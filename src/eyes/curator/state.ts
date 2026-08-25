/**
 * The weekly gate — `.argus/curator_state.json`.
 *
 * LIFTED (research #16 §8(iv)) from Hermes' `should_run_now()` +
 * `.curator_state` (`agent/curator.py:66-113,198-252`), which is exactly the
 * idempotency layer SPEC §5.1's "weekly" needs. RE-SPECCED: the trigger.
 * Hermes polls this from a session-startup hook and a gateway ticker; Argus
 * has neither, so the Reviewer checks it on every debounced invocation and
 * the gate — not the caller — decides. Same opportunistic-poll-with-internal-
 * gate design, no cron, no sixth watcher.
 *
 * First sight seeds `last_run_at = now` and defers one full interval: a repo
 * that has just installed Argus does not get an LLM pass over its skills in
 * its first minute.
 */
import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

export interface CuratorState {
  last_run_at: string | null;
  last_run_summary: string | null;
  last_report_path: string | null;
  paused: boolean;
  run_count: number;
}

const EMPTY: CuratorState = {
  last_run_at: null,
  last_run_summary: null,
  last_report_path: null,
  paused: false,
  run_count: 0,
};

export function curatorStatePath(repo: string): string {
  return join(repo, ".argus/curator_state.json");
}

/** A missing or torn state file reads as a fresh repo, never throws. */
export async function readCuratorState(repo: string): Promise<CuratorState> {
  const file = Bun.file(curatorStatePath(repo));
  if (!(await file.exists())) return { ...EMPTY };
  let parsed: unknown;
  try {
    parsed = await file.json();
  } catch {
    return { ...EMPTY };
  }
  if (typeof parsed !== "object" || parsed === null) return { ...EMPTY };
  const raw = parsed as Record<string, unknown>;
  return {
    last_run_at: typeof raw.last_run_at === "string" ? raw.last_run_at : null,
    last_run_summary:
      typeof raw.last_run_summary === "string" ? raw.last_run_summary : null,
    last_report_path:
      typeof raw.last_report_path === "string" ? raw.last_report_path : null,
    paused: raw.paused === true,
    run_count: typeof raw.run_count === "number" ? raw.run_count : 0,
  };
}

/** Atomic (temp + rename): a crash mid-write can never tear the gate. */
export async function writeCuratorState(
  repo: string,
  state: CuratorState,
): Promise<void> {
  const path = curatorStatePath(repo);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await Bun.write(temporary, `${JSON.stringify(state, null, 2)}\n`);
  await rename(temporary, path);
}

export type GateReason =
  | "disabled"
  | "paused"
  | "seeded-deferred"
  | "not-due"
  | "due";

export interface GateDecision {
  run: boolean;
  reason: GateReason;
  state: CuratorState;
}

export interface GateOptions {
  /** Epoch ms. */
  now: number;
  intervalHours: number;
  enabled: boolean;
}

export async function shouldRunNow(
  repo: string,
  options: GateOptions,
): Promise<GateDecision> {
  if (!options.enabled) {
    // Deliberately no write: a disabled curator leaves no footprint at all.
    return { run: false, reason: "disabled", state: await readCuratorState(repo) };
  }
  const state = await readCuratorState(repo);
  if (state.paused) return { run: false, reason: "paused", state };
  if (state.last_run_at === null) {
    const seeded: CuratorState = {
      ...state,
      last_run_at: new Date(options.now).toISOString(),
    };
    await writeCuratorState(repo, seeded);
    return { run: false, reason: "seeded-deferred", state: seeded };
  }
  const elapsed = options.now - Date.parse(state.last_run_at);
  if (elapsed >= options.intervalHours * 3_600_000) {
    return { run: true, reason: "due", state };
  }
  return { run: false, reason: "not-due", state };
}

export interface RecordRunOptions {
  /** ISO-8601 stamp of the run that just finished. */
  at: string;
  summary: string;
  reportPath?: string;
}

/**
 * Bump the gate after a REAL pass. A dry run must never call this
 * (`agent/curator.py:1478-1483`): a report-only pass leaves the schedule
 * exactly where it found it.
 */
export async function recordRun(
  repo: string,
  options: RecordRunOptions,
): Promise<CuratorState> {
  const state = await readCuratorState(repo);
  const next: CuratorState = {
    ...state,
    last_run_at: options.at,
    last_run_summary: options.summary,
    last_report_path: options.reportPath ?? state.last_report_path,
    run_count: state.run_count + 1,
  };
  await writeCuratorState(repo, next);
  return next;
}
