/**
 * Load-scaled test budgets (#42 item 5).
 *
 * A test timeout here is a HANG detector, not a performance assertion —
 * nothing in the eyes' suites asserts how fast anything is. So the only
 * question a budget has to answer is "did this ever finish", and the failure
 * mode to avoid is a busy machine answering "no" for a run that would have
 * finished fine.
 *
 * The measurements, on the 10-core machine these tests are developed on:
 *
 *   - `retro/retro.test.ts`: 29 tests, whole file 27–34s, slowest single test
 *     **1.11s**, taken at 1-minute load average 8–21 (already 1–2x
 *     oversubscribed). Its 60s budget is ~54x that worst case.
 *   - `retro/live.test.ts`: one real `codex exec` round trip each, measured at
 *     6.98s in #36. Its 240s budget is ~34x.
 *
 * Both still failed. #36 saw three hard timeouts in these two files while a
 * live agent drive ran alongside; #38's worker saw two curator tests time out
 * at load average 98; unloaded runs of both are green. The work these tests do
 * is dominated by subprocess spawns (`git`, and `codex` for the live pair),
 * which is exactly what degrades worst when the scheduler and the disk are
 * saturated — 5-60x on this machine class is routine, and >54x is what those
 * failures measured.
 *
 * Raising the flat number would buy that headroom by making every hang take
 * five minutes to report, on every machine, forever. Scaling by measured
 * oversubscription buys it only where it is needed: **on an idle machine the
 * budget is byte-for-byte what it is today**, so nothing that could be caught
 * before is hidden now, and it stretches only in proportion to a load the
 * machine is actually under.
 *
 * The verdict is what this stabilises. A timeout is inherently a wall-clock
 * assertion, so its outcome already depended on machine state; making the
 * budget depend on machine state is what makes the OUTCOME stop depending
 * on it.
 */
import { cpus, loadavg } from "node:os";

export interface BudgetInput {
  /** The budget on a machine that is not oversubscribed. */
  idleMs: number;
  /** The most it may ever stretch to: past here, slow and hung look the same. */
  ceilingMs: number;
  /** Runnable-thread backlog, as `os.loadavg()` reports it. */
  load: number;
  /** Cores available to absorb it. */
  cores: number;
}

export function scaleBudget({ idleMs, ceilingMs, load, cores }: BudgetInput): number {
  if (!Number.isFinite(load) || !Number.isFinite(cores) || cores < 1) return idleMs;
  // One runnable thread per core is a machine working at full speed, not a
  // slow one: oversubscription is what costs wall-clock, so that is the ratio.
  const factor = Math.max(1, load / cores);
  return Math.max(idleMs, Math.min(Math.round(idleMs * factor), ceilingMs));
}

/**
 * The budget for this machine, right now. Read at module load, which is when
 * `test()` needs its timeout.
 *
 * All three averages are consulted and the busiest wins: the 1-minute figure
 * lags the START of a load spike and the 15-minute figure lags its END, so a
 * machine that is busy now and one that has been busy both scale, and only a
 * genuinely quiet machine gets the floor.
 */
export function loadScaledMs(idleMs: number, ceilingMs: number): number {
  return scaleBudget({
    idleMs,
    ceilingMs,
    load: Math.max(...loadavg()),
    cores: cpus().length,
  });
}
