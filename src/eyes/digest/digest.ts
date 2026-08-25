/**
 * The Digest eye (SPEC §5.4, ticket #31): a per-session running markdown
 * narrative under `.argus/sessions/`, same brain tier as the Reviewer,
 * ADR-0002 cadence (30s quiet / 120s max) PLUS immediate fires on lifecycle
 * events. The digest's `status:` field doubles as the §6 slow-poll signal, so
 * lifecycle surfacing is MECHANICAL — session start, takeover, end/blocked/
 * dead flips hit the digest file and INDEX.md without waiting on (or being
 * able to be delayed by) the brain; only narrative goes through the coalesced
 * brain path.
 *
 * The coalesce-no-skip invariant matches the Reviewer: every ingested turn is
 * persisted to `.argus/eyes/digest/state.json` before ingest() resolves and
 * removed only after a successful evaluation. Rotated session ids (Hermes
 * compression chains, `continues` in sessions.jsonl) are resolved to their
 * chain root at ingest, so a whole chain converges on ONE logical digest.
 */
import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  loadRegistry,
  registryPaths,
  type ProvenanceRecord,
  type SessionRecord,
} from "../../provenance";
import { fileAlertEmitter, retryForever, type StuckAlert } from "../backpressure";
import { createCodexBrain, type Brain } from "../brain";
import { createBrainCap, defaultBrainSlotsDirectory, type BrainCap } from "../cap";
import { Coalescer, type CoalesceWindow } from "../coalesce";
import { loadEyesConfig, type CadenceConfig } from "../config";
import { chainRootOf } from "./chain";
import { applyDigestUpdate, digestFileName, updateIndex, type DigestSeed } from "./outputs";
import { parseDigestVerdict, DIGEST_OUTPUT_SCHEMA, type DigestVerdict } from "./schema";

export type { ProvenanceRecord } from "../../provenance";

/** The §6 lifecycle signals that fire the digest immediately. */
export interface SessionLifecycleEvent {
  kind: "session-start" | "session-end" | "session-blocked" | "session-dead";
  sessionId: string;
  /** ISO-8601 signal time. */
  ts: string;
}

const LIFECYCLE_STATUS = {
  "session-start": "running",
  "session-end": "done",
  "session-blocked": "blocked",
  "session-dead": "dead",
} as const;

interface PendingEntry {
  record: ProvenanceRecord;
  /** Wall-clock arrival, the coalescer's time base. */
  ingestedAt: number;
  /** The logical (chain-root) session id, resolved at ingest. */
  root: string;
}

/** What the eye remembers per logical session (restart-safe). */
interface KnownSession {
  fileName: string;
  seed: DigestSeed;
  johanTouched: boolean;
}

interface PersistedState {
  pending: PendingEntry[];
  window: CoalesceWindow | null;
  sessions: Record<string, KnownSession>;
}

export interface DigestEyeOptions {
  /** Repo root; digests live under its `.argus/sessions/`. */
  repo: string;
  brain: Brain;
  cap: BrainCap;
  cadence: CadenceConfig;
  /** Registry sessions supplier for chain/ticket lookup; defaults to the repo registry. */
  sessions?: () => Promise<SessionRecord[]>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Stuck-alert sink; defaults to a §6 event file in `.argus/events/`. */
  onAlert?: (alert: StuckAlert) => void | Promise<void>;
  /** Backoff tuning passthrough (tests shrink it). */
  baseDelayMs?: number;
  maxDelayMs?: number;
  stuckAfterMs?: number;
  signal?: AbortSignal;
}

function buildPrompt(entries: PendingEntry[]): string {
  const blocks = entries.map(
    ({ record, root }) =>
      `[session=${root} author=${record.author} role=${record.event.role} ` +
      `ts=${record.ts}]\n${record.text}`,
  );
  return [
    "You are the Argus Digest eye. The blocks below are transcript turns from",
    "agent sessions in this repo, each tagged with its logical session id and",
    "registry-verified author. Maintain each session's running narrative. Do",
    "not run any commands; judge only from the blocks.",
    "",
    "Emit JSON matching the output schema: for EVERY distinct session id in",
    "the blocks, one entry with",
    "- narrative: markdown for what happened in these turns (appended to the",
    "  session's digest — write it to be read after the earlier entries).",
    "- summary: ONE line describing where the session stands now.",
    '- status: "done" when the work concluded, "blocked" when it waits on a',
    '  human, otherwise "running".',
    "",
    ...blocks,
  ].join("\n");
}

export class DigestEye {
  private pending: PendingEntry[];
  private readonly known: Map<string, KnownSession>;
  private readonly coalescer: Coalescer;
  private readonly now: () => number;
  private readonly statePath: string;
  private readonly sessionsDir: string;
  private readonly loadSessions: () => Promise<SessionRecord[]>;
  private readonly onAlert: (alert: StuckAlert) => void | Promise<void>;
  private evaluating = false;
  /** A lifecycle event happened: pending narrative is due NOW, not at cadence. */
  private fireNow = false;

  private constructor(
    private readonly options: DigestEyeOptions,
    state: PersistedState,
  ) {
    this.pending = state.pending;
    this.known = new Map(Object.entries(state.sessions));
    this.coalescer = new Coalescer(options.cadence, state.window);
    this.now = options.now ?? Date.now;
    this.statePath = join(options.repo, ".argus/eyes/digest/state.json");
    this.sessionsDir = join(options.repo, ".argus/sessions");
    this.loadSessions =
      options.sessions ??
      (async () => (await loadRegistry(registryPaths(options.repo))).sessions);
    this.onAlert =
      options.onAlert ?? fileAlertEmitter(join(options.repo, ".argus/events"));
  }

  /** Open the eye, restoring any pending-but-unevaluated turns (no-skip). */
  static async open(options: DigestEyeOptions): Promise<DigestEye> {
    const statePath = join(options.repo, ".argus/eyes/digest/state.json");
    let state: PersistedState = { pending: [], window: null, sessions: {} };
    const file = Bun.file(statePath);
    if (await file.exists()) {
      try {
        const raw = (await file.json()) as PersistedState;
        if (Array.isArray(raw.pending)) {
          state = {
            pending: raw.pending,
            window: raw.window ?? null,
            sessions: raw.sessions ?? {},
          };
        }
      } catch {
        // Torn state file: the atomic-rename writer makes this near-impossible,
        // but an unreadable file must not kill the eye — it restarts empty and
        // upstream cursor replay re-delivers.
      }
    }
    return new DigestEye(options, state);
  }

  /**
   * Resolve a session id to its logical root and the identity the digest file
   * carries, learning it into the restart-safe map on first sight.
   */
  private async resolveSession(
    sessionId: string,
    record?: ProvenanceRecord,
  ): Promise<{ root: string; session: KnownSession; isNew: boolean }> {
    const registrations = await this.loadSessions();
    const root = chainRootOf(registrations, sessionId);
    const existing = this.known.get(root);
    if (existing) return { root, session: existing, isNew: false };

    const rootRegistration = registrations.find(
      (candidate) => candidate.sessionId === root,
    );
    const ownRegistration = registrations.find(
      (candidate) => candidate.sessionId === sessionId,
    );
    const ticket =
      rootRegistration?.ticket ?? ownRegistration?.ticket ?? record?.ticket;
    const seed: DigestSeed = {
      agent:
        rootRegistration?.agent ?? ownRegistration?.agent ?? record?.agent ?? "unknown",
      ...(ticket !== undefined && { ticket }),
      startedBy:
        record?.startedBy ??
        (rootRegistration ?? ownRegistration ? "hermes" : "johan"),
    };
    const session: KnownSession = {
      fileName: digestFileName(ticket, root),
      seed,
      johanTouched: false,
    };
    this.known.set(root, session);
    return { root, session, isNew: true };
  }

  /** Mechanical write: patch the digest file, mirror the result into INDEX.md. */
  private async surface(
    session: KnownSession,
    patch: Parameters<typeof applyDigestUpdate>[3],
    summary?: string,
  ): Promise<void> {
    const frontmatter = await applyDigestUpdate(
      this.sessionsDir,
      session.fileName,
      session.seed,
      patch,
    );
    session.johanTouched = frontmatter.johanTouched;
    await updateIndex(this.sessionsDir, {
      file: session.fileName,
      agent: frontmatter.agent,
      ...(frontmatter.ticket !== undefined && { ticket: frontmatter.ticket }),
      status: frontmatter.status,
      startedBy: frontmatter.startedBy,
      johanTouched: frontmatter.johanTouched,
      ...(summary !== undefined && { summary }),
    });
  }

  /** Turn content arrived. Persisted before this resolves — never skippable. */
  async ingest(records: ProvenanceRecord[]): Promise<void> {
    const at = this.now();
    const touched = new Map<string, { session: KnownSession; isNew: boolean }>();
    for (const record of records) {
      const { root, session, isNew } = await this.resolveSession(
        record.sessionId,
        record,
      );
      this.pending.push({ record, ingestedAt: at, root });
      this.coalescer.note(at);
      const seen = touched.get(root) ?? { session, isNew };
      seen.isNew = seen.isNew || isNew;
      if (record.johanTouched && !session.johanTouched) {
        // Takeover: surface johan_touched immediately, not at the next brain fire.
        await this.surface(session, { johanTouched: true });
      }
      touched.set(root, seen);
    }
    await this.persist();
    for (const { session, isNew } of touched.values()) {
      if (isNew) {
        await this.surface(session, { status: "running" }, "session started");
        await this.persist();
      }
    }
  }

  /** A §6 lifecycle signal: fires the digest immediately, no brain involved. */
  async ingestLifecycle(event: SessionLifecycleEvent): Promise<void> {
    const { session, isNew } = await this.resolveSession(event.sessionId);
    await this.surface(
      session,
      { status: LIFECYCLE_STATUS[event.kind] },
      isNew ? "session started" : undefined,
    );
    if (this.pending.length > 0) this.fireNow = true;
    await this.persist();
  }

  pendingCount(): number {
    return this.pending.length;
  }

  /** Epoch ms of the next due evaluation, or null when nothing pends. */
  dueAt(): number | null {
    if (this.fireNow && this.pending.length > 0) return this.now();
    return this.coalescer.dueAt();
  }

  /**
   * Evaluate the pending batch if it is due. Returns whether an evaluation
   * ran. Never throws for brain failures — those retry forever inside.
   */
  async tick(): Promise<boolean> {
    const due =
      (this.fireNow && this.pending.length > 0) ||
      this.coalescer.shouldFire(this.now());
    if (this.evaluating || !due) return false;
    this.evaluating = true;
    try {
      const batch = this.pending.slice();
      const verdict = await retryForever(() => this.evaluateOnce(batch), {
        eye: "digest",
        onAlert: this.onAlert,
        ...(this.options.baseDelayMs !== undefined && {
          baseDelayMs: this.options.baseDelayMs,
        }),
        ...(this.options.maxDelayMs !== undefined && {
          maxDelayMs: this.options.maxDelayMs,
        }),
        ...(this.options.stuckAfterMs !== undefined && {
          stuckAfterMs: this.options.stuckAfterMs,
        }),
        now: this.now,
        ...(this.options.signal !== undefined && { signal: this.options.signal }),
        ...(this.options.sleep !== undefined && { sleep: this.options.sleep }),
      });
      await this.apply(verdict, batch);

      // Turns that arrived during the evaluation stay pending for the next one.
      this.pending = this.pending.slice(batch.length);
      this.coalescer.flush();
      for (const entry of this.pending) this.coalescer.note(entry.ingestedAt);
      this.fireNow = false;
      await this.persist();
      return true;
    } finally {
      this.evaluating = false;
    }
  }

  /** One brain attempt under the machine-wide cap; throws to trigger retry. */
  private async evaluateOnce(batch: PendingEntry[]): Promise<DigestVerdict> {
    const release = await this.options.cap.acquire();
    try {
      const outcome = await this.options.brain.evaluate({
        prompt: buildPrompt(batch),
        schema: DIGEST_OUTPUT_SCHEMA,
        cwd: this.options.repo,
      });
      if (!outcome.ok) {
        throw new Error(`brain ${outcome.reason}: ${outcome.detail}`);
      }
      const verdict = parseDigestVerdict(outcome.text);
      if (verdict === null) {
        throw new Error(`brain schema miss: ${outcome.text.slice(0, 500)}`);
      }
      return verdict;
    } finally {
      await release();
    }
  }

  /**
   * Fold the verdict into the digests. Entries are matched by logical session
   * id (physical ids the brain echoes resolve through the batch); ids the
   * batch never contained are ignored — the trust boundary, not the model,
   * decides what gets written.
   */
  private async apply(verdict: DigestVerdict, batch: PendingEntry[]): Promise<void> {
    const rootOf = new Map<string, string>();
    const latestTs = new Map<string, string>();
    for (const { record, root } of batch) {
      rootOf.set(record.sessionId, root);
      rootOf.set(root, root);
      latestTs.set(root, record.ts);
    }
    for (const entry of verdict.sessions) {
      const root = rootOf.get(entry.sessionId);
      if (root === undefined) continue;
      const session = this.known.get(root);
      if (session === undefined) continue;
      await this.surface(
        session,
        {
          status: entry.status,
          narrative: {
            ts: latestTs.get(root) ?? new Date(this.now()).toISOString(),
            text: entry.narrative,
          },
        },
        entry.summary,
      );
    }
  }

  /** Atomic (temp + rename) so a crash can never tear the no-skip state. */
  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.tmp`;
    await Bun.write(
      temporary,
      JSON.stringify(
        {
          pending: this.pending,
          window: this.coalescer.pendingWindow(),
          sessions: Object.fromEntries(this.known),
        },
        null,
        2,
      ),
    );
    await rename(temporary, this.statePath);
  }
}

/** Pieces `openDigest` composes from config that a caller may substitute. */
export interface OpenDigestOverrides {
  brain?: Brain;
  /** Brain-slot directory; defaults machine-wide per `defaultBrainSlotsDirectory`. */
  capDirectory?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onAlert?: (alert: StuckAlert) => void | Promise<void>;
  signal?: AbortSignal;
}

/**
 * The production composition (the wiring #34's supervisor calls): cadence,
 * model/effort and the machine cap all come from `.argus/config.yaml` with
 * defaults in code (digest: 30s quiet / 120s max), the brain is the same
 * codex tier as the Reviewer, and the cap directory is the machine-shared one.
 */
export async function openDigest(
  repo: string,
  overrides: OpenDigestOverrides = {},
): Promise<DigestEye> {
  const config = await loadEyesConfig(repo);
  return DigestEye.open({
    repo,
    brain:
      overrides.brain ??
      createCodexBrain({
        model: config.brain.model,
        reasoningEffort: config.brain.reasoningEffort,
      }),
    cap: createBrainCap({
      directory: overrides.capDirectory ?? defaultBrainSlotsDirectory(),
      maxConcurrency: config.brain.maxConcurrency,
    }),
    cadence: config.digest,
    ...(overrides.now !== undefined && { now: overrides.now }),
    ...(overrides.sleep !== undefined && { sleep: overrides.sleep }),
    ...(overrides.onAlert !== undefined && { onAlert: overrides.onAlert }),
    ...(overrides.signal !== undefined && { signal: overrides.signal }),
  });
}
