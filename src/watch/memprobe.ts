/**
 * OPTIONAL in-process memory probe for the #109 soak. OFF unless asked for.
 *
 * #105 §7(4) is the reason this exists: `totalRssMiB` sampled from the OUTSIDE
 * with `ps` is one number per process, and one number cannot tell a growing
 * SQLite page cache from a growing JS heap from an arena that never returns
 * pages to the OS. #105 therefore found a SHAPE and no CAUSE. This is the only
 * instrument in the harness that can find a cause, so it lives inside the
 * watcher process, where the split is actually visible.
 *
 * IT MUST NOT CHANGE PRODUCTION BEHAVIOUR. Gating is by the presence of
 * `ARGUS_WATCH_MEMPROBE_FILE` alone: with it unset `createMemProbe` returns
 * null, `probe?.maybeSample()` is a no-op on an undefined, and not one byte is
 * written or read. That is why the gate is an env var and not a config knob —
 * a config knob is a file every enrolled repo would have to be reasoned about.
 *
 * WHAT IT RECORDS, AND WHY EACH FIELD.
 *   rss          the same quantity `ps` reports, but read from inside, so the
 *                four fields below can be subtracted from the SAME number
 *                rather than from a differently-timed external sample.
 *   heapUsed     JSC's live JS objects. If the fleet's RSS climbs and this does
 *                not, the growth is not JS objects.
 *   heapTotal    JSC's heap capacity. heapTotal - heapUsed is heap the engine
 *                is holding but not using.
 *   external     non-heap memory tied to JS objects.
 *   arrayBuffers the Tailer reads transcript files into buffers; if the growth
 *                is retained read buffers it lands here.
 *   residual     rss - (heapUsed + external + arrayBuffers). THE POINT OF THE
 *                WHOLE FILE. Memory the process holds that is accounted for by
 *                none of the above is, by elimination, allocator/arena
 *                retention or mapped pages — "freed by JSC, never returned to
 *                the OS". #105 could not distinguish that hypothesis from a
 *                real leak because it had no term for it. Now it has one.
 *
 * WHAT BUN DOES NOT EXPOSE, stated rather than worked around. There is no
 * binding for `sqlite3_memory_used()` or
 * `sqlite3_db_status(SQLITE_DBSTATUS_CACHE_USED)`: `bun:sqlite`'s Database
 * surface is open/close/exec/query/prepare/run/transaction/serialize/
 * fileControl/loadExtension/clearQueryCache and nothing else. So SQLite's
 * actual cache occupancy is NOT measurable here. What IS measurable is a hard
 * UPPER BOUND — `min(cache_size, page_count) * page_size` — and that is
 * collected by `scripts/soak/sampler.ts` from the readonly handle it already
 * holds, NOT here. Deliberately not here: opening a second Database inside the
 * watcher to read a PRAGMA would allocate a second page cache inside the
 * process whose memory is being measured, which is an instrument that changes
 * its own reading. This file touches no database at all.
 *
 * COST. `process.memoryUsage()` measured at 0.47 microseconds per call on this
 * machine. At the default 30 s cadence that is ~1.4 ms of probe time per
 * watcher per day, against a 250 ms poll loop. The throttle check itself is one
 * `Date.now()` comparison per poll.
 */
import { appendFileSync } from "node:fs";

/** Matches `scripts/soak/sampler.ts`'s own cadence, so the two series line up. */
const DEFAULT_INTERVAL_MS = 30_000;

export interface MemProbeReading {
  arrayBuffers: number;
  at: string;
  external: number;
  eye: string;
  heapTotal: number;
  heapUsed: number;
  pid: number;
  /** rss - (heapUsed + external + arrayBuffers); may be negative if the engine double-counts. */
  residual: number;
  rss: number;
  uptimeSeconds: number;
}

export interface MemProbe {
  /** Writes a reading if the interval has elapsed. Never throws. */
  maybeSample(): void;
  /** Writes a reading unconditionally. Never throws. */
  sample(): void;
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function readingFor(eye: string, startedAtMs: number): MemProbeReading {
  const usage = process.memoryUsage();
  const arrayBuffers = usage.arrayBuffers ?? 0;
  const external = usage.external ?? 0;
  const heapUsed = usage.heapUsed ?? 0;
  return {
    arrayBuffers,
    at: new Date().toISOString(),
    external,
    eye,
    heapTotal: usage.heapTotal ?? 0,
    heapUsed,
    pid: process.pid,
    residual: usage.rss - (heapUsed + external + arrayBuffers),
    rss: usage.rss,
    uptimeSeconds: Number(((Date.now() - startedAtMs) / 1000).toFixed(1)),
  };
}

/**
 * Returns null — and so costs exactly nothing — unless
 * `ARGUS_WATCH_MEMPROBE_FILE` is set. `ARGUS_WATCH_MEMPROBE_MS` overrides the
 * cadence.
 *
 * Every write is one `appendFileSync` of a single sub-512-byte line to an
 * O_APPEND handle, which is the same discipline `scripts/soak/sampler.ts`
 * relies on: five watchers share one file and interleave whole lines. The
 * file handle is not held open between writes, so a probe file that is moved
 * or removed mid-run costs a caught error, not a dead watcher.
 */
export function createMemProbe(
  eye: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): MemProbe | null {
  const path = environment.ARGUS_WATCH_MEMPROBE_FILE;
  if (path === undefined || path === "") return null;
  const intervalMs = positiveInteger(
    environment.ARGUS_WATCH_MEMPROBE_MS,
    DEFAULT_INTERVAL_MS,
  );
  const startedAtMs = Date.now();
  let nextDue = 0;

  const sample = (): void => {
    try {
      appendFileSync(path, `${JSON.stringify(readingFor(eye, startedAtMs))}\n`);
    } catch {
      // A probe that kills a watcher would turn the instrument into the
      // failure it is measuring. Losing a reading is always the better trade.
    }
  };

  return {
    maybeSample(): void {
      const now = Date.now();
      if (now < nextDue) return;
      nextDue = now + intervalMs;
      sample();
    },
    sample,
  };
}
