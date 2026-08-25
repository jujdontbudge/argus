/**
 * The Reviewer eye (SPEC §5.1, ticket #30): debounced/coalesced per-turn
 * evaluation of classified transcript content, judged by the codex brain,
 * applied to USER.md / MEMORY.md / skills through the provenance-gated
 * writers in ./outputs.
 *
 * The coalesce-no-skip invariant: every ingested turn's content is persisted
 * to `.argus/eyes/reviewer/state.json` BEFORE ingest() resolves and removed
 * only after a successful evaluation — a crash mid-coalesce or mid-retry
 * loses nothing, and the persisted window keeps the ADR-0002 max-wait clock
 * anchored at the first still-pending turn across restarts.
 */
import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileAlertEmitter, retryForever, type StuckAlert } from "../backpressure";
import { createCodexBrain, type Brain } from "../brain";
import { createBrainCap, defaultBrainSlotsDirectory, type BrainCap } from "../cap";
import { Coalescer, type CoalesceWindow } from "../coalesce";
import { loadEyesConfig, type CadenceConfig, type CuratorConfig } from "../config";
import { maybeRunCurator } from "../curator/curator";
import { recordSkillWrites } from "../curator/usage";
import { applyFindings, foldHermesEntries, repairMemoryIndex } from "./outputs";
import { parseVerdict, REVIEWER_OUTPUT_SCHEMA, type Verdict } from "./schema";

import type { ProvenanceRecord } from "../../provenance";
export type { ProvenanceRecord } from "../../provenance";
export type { MessageEvent } from "../../tailing";

interface PendingEntry {
  record: ProvenanceRecord;
  /** Wall-clock arrival, the coalescer's time base. */
  ingestedAt: number;
}

interface PersistedState {
  pending: PendingEntry[];
  window: CoalesceWindow | null;
}

export interface ReviewerEyeOptions {
  /** Repo root; all state lives under its `.argus/`. */
  repo: string;
  brain: Brain;
  cap: BrainCap;
  cadence: CadenceConfig;
  /**
   * The weekly curator pass (#35) rides this loop. Omitted (as unit tests
   * omit it) the curator never runs and leaves no state — it is a pass inside
   * the Reviewer, so it is only ever as alive as the Reviewer is.
   */
  curator?: CuratorConfig;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Stuck-alert sink; defaults to a §6 event file in `.argus/events/`. */
  onAlert?: (alert: StuckAlert) => void | Promise<void>;
  /** Backoff tuning passthrough (tests shrink it). */
  baseDelayMs?: number;
  maxDelayMs?: number;
  stuckAfterMs?: number;
}

function buildPrompt(records: ProvenanceRecord[]): string {
  const blocks = records.map(
    (record) =>
      `[uuid=${record.event.uuid ?? "unknown"} author=${record.author} ` +
      `session=${record.sessionId} role=${record.event.role} ts=${record.ts}]\n` +
      record.text,
  );
  return [
    "You are the Argus Reviewer eye. The blocks below are transcript turns",
    "from agent sessions in this repo, each tagged with its registry-verified",
    "author. Decide whether anything DURABLE happened. Do not run any",
    "commands; judge only from the blocks.",
    "",
    'Emit findings (possibly none) as JSON matching the output schema:',
    '- kind "user-preference": something about Johan himself (how he works,',
    "  what he wants). Derive ONLY from blocks with author=johan and cite",
    "  exactly those uuids in sources.",
    '- kind "project-fact": a durable fact about this project, from any author.',
    '- kind "procedure": a repeatable procedure worth a reusable skill.',
    "Use a stable kebab-case slug per finding so repeats converge.",
    "Cite the uuid(s) each finding derives from in sources.",
    "",
    ...blocks,
  ].join("\n");
}

export class ReviewerEye {
  private pending: PendingEntry[];
  private readonly coalescer: Coalescer;
  private readonly now: () => number;
  private readonly statePath: string;
  private readonly onAlert: (alert: StuckAlert) => void | Promise<void>;
  private evaluating = false;

  private constructor(
    private readonly options: ReviewerEyeOptions,
    state: PersistedState,
  ) {
    this.pending = state.pending;
    this.coalescer = new Coalescer(options.cadence, state.window);
    this.now = options.now ?? Date.now;
    this.statePath = join(options.repo, ".argus/eyes/reviewer/state.json");
    this.onAlert =
      options.onAlert ?? fileAlertEmitter(join(options.repo, ".argus/events"));
  }

  /** Open the eye, restoring any pending-but-unevaluated turns (no-skip). */
  static async open(options: ReviewerEyeOptions): Promise<ReviewerEye> {
    const statePath = join(options.repo, ".argus/eyes/reviewer/state.json");
    let state: PersistedState = { pending: [], window: null };
    const file = Bun.file(statePath);
    if (await file.exists()) {
      try {
        const raw = (await file.json()) as PersistedState;
        if (Array.isArray(raw.pending)) {
          state = { pending: raw.pending, window: raw.window ?? null };
        }
      } catch {
        // Torn state file: the atomic-rename writer makes this near-impossible,
        // but an unreadable file must not kill the eye — it restarts empty and
        // upstream cursor replay re-delivers.
      }
    }
    return new ReviewerEye(options, state);
  }

  /** Turn content arrived. Persisted before this resolves — never skippable. */
  async ingest(records: ProvenanceRecord[]): Promise<void> {
    const at = this.now();
    for (const record of records) {
      this.pending.push({ record, ingestedAt: at });
      this.coalescer.note(at);
    }
    await this.persist();
  }

  pendingCount(): number {
    return this.pending.length;
  }

  /** Epoch ms of the next due evaluation, or null when nothing pends. */
  dueAt(): number | null {
    return this.coalescer.dueAt();
  }

  /**
   * Evaluate the pending batch if it is due. Returns whether an evaluation
   * ran. Never throws for brain failures — those retry forever inside.
   */
  async tick(): Promise<boolean> {
    if (this.evaluating || !this.coalescer.shouldFire(this.now())) return false;
    this.evaluating = true;
    try {
      const batch = this.pending.slice();
      const verdict = await retryForever(() => this.evaluateOnce(batch), {
        eye: "reviewer",
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
        ...(this.options.sleep !== undefined && { sleep: this.options.sleep }),
      });
      await this.apply(verdict, batch);

      // Turns that arrived during the evaluation stay pending for the next one.
      this.pending = this.pending.slice(batch.length);
      this.coalescer.flush();
      for (const entry of this.pending) this.coalescer.note(entry.ingestedAt);
      await this.persist();
      await this.curate();
      return true;
    } finally {
      this.evaluating = false;
    }
  }

  /** One brain attempt under the machine-wide cap; throws to trigger retry. */
  private async evaluateOnce(batch: PendingEntry[]): Promise<Verdict> {
    const release = await this.options.cap.acquire();
    try {
      const outcome = await this.options.brain.evaluate({
        prompt: buildPrompt(batch.map(({ record }) => record)),
        schema: REVIEWER_OUTPUT_SCHEMA,
        cwd: this.options.repo,
      });
      if (!outcome.ok) {
        throw new Error(`brain ${outcome.reason}: ${outcome.detail}`);
      }
      const verdict = parseVerdict(outcome.text);
      if (verdict === null) {
        throw new Error(`brain schema miss: ${outcome.text.slice(0, 500)}`);
      }
      return verdict;
    } finally {
      await release();
    }
  }

  /**
   * SPEC §5.1's weekly curator pass. The gate answers "not yet" almost every
   * time, so this is a cheap file read on the overwhelming majority of ticks.
   * It can never take the eye down: a pass that throws is alerted like any
   * other stuck eye and the evaluation that preceded it still counts.
   */
  private async curate(): Promise<void> {
    const config = this.options.curator;
    if (config === undefined) return;
    try {
      await maybeRunCurator({
        repo: this.options.repo,
        brain: this.options.brain,
        cap: this.options.cap,
        now: this.now(),
        config,
      });
    } catch (error) {
      await this.onAlert({
        type: "eye-stuck",
        eye: "curator",
        stuckForMs: 0,
        attempts: 1,
        lastError: error instanceof Error ? error.message : String(error),
        at: new Date(this.now()).toISOString(),
      });
    }
  }

  private async apply(verdict: Verdict, batch: PendingEntry[]): Promise<void> {
    const memoryDir = join(this.options.repo, ".argus/memory");
    const skillsDir = join(this.options.repo, ".argus/skills");
    // The provenance gate resolves citations against the batch the brain saw;
    // an unknown uuid can never authorize a USER.md write.
    const authors = new Map(
      batch
        .filter(({ record }) => record.event.uuid !== undefined)
        .map(({ record }) => [record.event.uuid!, record.author]),
    );
    await foldHermesEntries(memoryDir);
    const result = await applyFindings(
      { memoryDir, skillsDir, authorOf: (uuid) => authors.get(uuid) },
      verdict.findings,
    );
    await repairMemoryIndex(memoryDir);

    // The curator's telemetry source (#35): every skill this eye writes gets a
    // usage record, carrying the provenance split — a skill Johan asked for is
    // his, and pinned beyond the curator's reach.
    const johanAuthored = new Set(
      verdict.findings
        .filter(
          (finding) =>
            finding.kind === "procedure" &&
            finding.sources.length > 0 &&
            finding.sources.every((source) => authors.get(source) === "johan"),
        )
        .map(({ slug }) => slug),
    );
    const at = new Date(this.now()).toISOString();
    for (const createdBy of ["johan", "agent"] as const) {
      const slugs = result.applied.skills.filter(
        (slug) => johanAuthored.has(slug) === (createdBy === "johan"),
      );
      await recordSkillWrites(skillsDir, slugs, { at, createdBy });
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
        },
        null,
        2,
      ),
    );
    await rename(temporary, this.statePath);
  }
}

/** Pieces `openReviewer` composes from config that a caller may substitute. */
export interface OpenReviewerOverrides {
  brain?: Brain;
  /** Brain-slot directory; defaults machine-wide per `defaultBrainSlotsDirectory`. */
  capDirectory?: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onAlert?: (alert: StuckAlert) => void | Promise<void>;
}

/**
 * The production composition (the wiring #34's supervisor calls): cadence,
 * model/effort and the machine cap all come from `.argus/config.yaml` with
 * defaults in code, the brain is the real codex CLI, and the cap directory
 * is the machine-shared one.
 */
export async function openReviewer(
  repo: string,
  overrides: OpenReviewerOverrides = {},
): Promise<ReviewerEye> {
  const config = await loadEyesConfig(repo);
  return ReviewerEye.open({
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
    cadence: config.reviewer,
    curator: config.curator,
    ...(overrides.now !== undefined && { now: overrides.now }),
    ...(overrides.sleep !== undefined && { sleep: overrides.sleep }),
    ...(overrides.onAlert !== undefined && { onAlert: overrides.onAlert }),
  });
}
