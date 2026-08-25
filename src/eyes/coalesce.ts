/**
 * Debounce/coalesce cadence (ADR-0002): an eye fires after `quietWindow` of
 * turn silence, but never later than `maxWait` after the FIRST still-pending
 * turn — a busy session cannot starve evaluation. This class only decides
 * WHEN to fire; the coalesce-no-skip invariant (no turn's content is ever
 * dropped) is the eye's job — it clears pending content only after a
 * successful evaluation.
 */
import type { CadenceConfig } from "./config";

/** Pending-window timestamps, epoch ms — persistable across restarts. */
export interface CoalesceWindow {
  firstPendingAt: number;
  lastEventAt: number;
}

export class Coalescer {
  private window: CoalesceWindow | null;

  constructor(
    private readonly cadence: CadenceConfig,
    seed: CoalesceWindow | null = null,
  ) {
    this.window = seed;
  }

  /** A turn's content arrived at `atMs`. */
  note(atMs: number): void {
    if (this.window === null) {
      this.window = { firstPendingAt: atMs, lastEventAt: atMs };
      return;
    }
    this.window.lastEventAt = Math.max(this.window.lastEventAt, atMs);
  }

  /** Epoch ms when the pending batch is due, or null when nothing pends. */
  dueAt(): number | null {
    if (this.window === null) return null;
    return Math.min(
      this.window.lastEventAt + this.cadence.quietWindowSeconds * 1_000,
      this.window.firstPendingAt + this.cadence.maxWaitSeconds * 1_000,
    );
  }

  shouldFire(nowMs: number): boolean {
    const due = this.dueAt();
    return due !== null && nowMs >= due;
  }

  /** The current window for persistence (restart mid-coalesce). */
  pendingWindow(): CoalesceWindow | null {
    return this.window === null ? null : { ...this.window };
  }

  /** The pending batch was evaluated; both windows reset. */
  flush(): void {
    this.window = null;
  }
}
