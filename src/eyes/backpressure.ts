/**
 * Never-drop backpressure (ADR-0002): an eye's evaluation is retried forever
 * with exponential backoff — content is never skipped because the brain is
 * down. Being stuck is made LOUD instead: once an episode exceeds the stuck
 * threshold (15 min), one alert is emitted, wired to a §6 event file so
 * Hermes' poll sweep surfaces it.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface StuckAlert {
  type: "eye-stuck";
  eye: string;
  /** How long this retry episode has been failing, ms. */
  stuckForMs: number;
  attempts: number;
  lastError: string;
  /** ISO-8601 emission time. */
  at: string;
}

export interface RetryFailure {
  at: string;
  attempts: number;
  eye: string;
  lastError: string;
  stuckForMs: number;
}

export interface RetryForeverOptions {
  /** Alert sink; `fileAlertEmitter` writes §6 event files. */
  onAlert: (alert: StuckAlert) => void | Promise<void>;
  /** Immediate health sink; unlike onAlert, this runs on every failed attempt. */
  onFailure?: (failure: RetryFailure) => void | Promise<void>;
  /** Eye name stamped into alerts. */
  eye?: string;
  /** First backoff delay; doubles per failure. */
  baseDelayMs?: number;
  /** Backoff ceiling. */
  maxDelayMs?: number;
  /** Alert once the episode has failed for longer than this. */
  stuckAfterMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Daemon shutdown only; normal failures still retry forever. */
  signal?: AbortSignal;
}

function aborted(): Error {
  const error = new Error("eye retry stopped by daemon shutdown");
  error.name = "AbortError";
  return error;
}

async function sleepUntilRetry(
  milliseconds: number,
  sleep: (ms: number) => Promise<void>,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (signal === undefined) return sleep(milliseconds);
  if (signal.aborted) throw aborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => reject(aborted());
    signal.addEventListener("abort", onAbort, { once: true });
    void sleep(milliseconds).then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Run `operation` until it succeeds. Failures back off exponentially
 * (1s → 60s cap by default) and NEVER abort: the only exits are success and
 * the caller abandoning the promise.
 */
export async function retryForever<T>(
  operation: () => Promise<T>,
  options: RetryForeverOptions,
): Promise<T> {
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 60_000;
  const stuckAfterMs = options.stuckAfterMs ?? 15 * 60_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? Bun.sleep;

  const startedAt = now();
  let attempts = 0;
  let alerted = false;
  for (;;) {
    if (options.signal?.aborted) throw aborted();
    attempts += 1;
    try {
      return await operation();
    } catch (error) {
      if (options.signal?.aborted) throw aborted();
      const stuckForMs = now() - startedAt;
      const failure: RetryFailure = {
        at: new Date(now()).toISOString(),
        attempts,
        eye: options.eye ?? "unknown",
        lastError: error instanceof Error ? error.message : String(error),
        stuckForMs,
      };
      await options.onFailure?.(failure);
      if (!alerted && stuckForMs > stuckAfterMs) {
        alerted = true;
        await options.onAlert({
          type: "eye-stuck",
          ...failure,
        });
      }
      await sleepUntilRetry(
        Math.min(baseDelayMs * 2 ** (attempts - 1), maxDelayMs),
        sleep,
        options.signal,
      );
    }
  }
}

/** Alert sink writing one JSON event file per alert into `.argus/events/`. */
export function fileAlertEmitter(
  eventsDirectory: string,
): (alert: StuckAlert) => Promise<void> {
  return async (alert) => {
    await mkdir(eventsDirectory, { recursive: true });
    const stamp = alert.at.replaceAll(":", "-");
    await Bun.write(
      join(eventsDirectory, `${stamp}-${alert.eye}-stuck.json`),
      `${JSON.stringify(alert, null, 2)}\n`,
    );
  };
}
