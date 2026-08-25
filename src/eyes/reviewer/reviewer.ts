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
import type { Brain } from "../brain";
import type { BrainCap } from "../cap";
import { Coalescer, type CoalesceWindow } from "../coalesce";
import type { CadenceConfig } from "../config";
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
    await applyFindings(
      { memoryDir, skillsDir, authorOf: (uuid) => authors.get(uuid) },
      verdict.findings,
    );
    await repairMemoryIndex(memoryDir);
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
