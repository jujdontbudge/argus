/**
 * The soak's measurement, written so it SURVIVES the thing that started it (#105).
 *
 * Every sample is appended to series.jsonl as one self-describing JSON line and
 * the file handle is closed again immediately. That is the whole point: #89
 * died to a foreground Bash call at the 10-minute ceiling and left nothing
 * behind. Here, if the driver, the fleet, or the agent supervising all of it
 * dies at minute 37, minute 37's series is already on disk and readable.
 *
 * What each sample records, and why:
 *   rss      per-eye RSS by PID — the ticket's primary signal. By PID, never by
 *            a command-line grep, because a grep also matches Johan's own
 *            sessions and this machine has ~28 of them.
 *   pids     so restarts are detectable from the SERIES ALONE. A PID that
 *            changes between samples is a restart even if the supervisor log
 *            were lost; this is independent evidence, not a second copy.
 *   load     a load spike is not a leak. #86 was found on a machine that also
 *            runs iOS Release builds at load 124, and conflating the two would
 *            be a false alarm.
 *   wal/db   a store that grows without bound is the same failure as the RSS
 *            leak, just slower.
 *   search   a query that degrades over hours, likewise.
 *
 * ADDED FOR #109, both additive and both optional:
 *   phase    the pre-registered phase label and traffic rate in force at this
 *            sample (./phases.ts). Written only when the run start epoch is
 *            passed, i.e. only for a phased run. Recorded rather than
 *            recomputed at analysis time so the series states its own design:
 *            if `phases.ts` were ever edited after the fact, the series would
 *            still say what actually ran.
 *   sqlite   page_size / page_count / freelist_count / cache_size, read off
 *            the readonly handle this file ALREADY opens. Bun exposes no
 *            `sqlite3_memory_used()` and no
 *            `sqlite3_db_status(SQLITE_DBSTATUS_CACHE_USED)` — the `Database`
 *            surface is open/close/exec/query/prepare/run/transaction/
 *            serialize/fileControl/loadExtension/clearQueryCache and nothing
 *            more — so SQLite's ACTUAL cache occupancy cannot be measured from
 *            here. What these four give is a hard UPPER BOUND,
 *            min(cache_size, page_count) * page_size, and a bound is enough to
 *            REFUTE the page-cache hypothesis even though it cannot confirm
 *            it. That asymmetry is the whole reason to collect it: #105 §7(4)
 *            named "a growing SQLite page cache" as one of three
 *            indistinguishable causes, and a small bound removes it from the
 *            list.
 */
import { Database } from "bun:sqlite";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";

import { phaseAt, rateName } from "./phases.ts";

const [, , scratchRoot, intervalArgument, deadlineArgument, ownerArgument, epochArgument] =
  process.argv;
if (!scratchRoot || !intervalArgument || !deadlineArgument || !ownerArgument) {
  throw new Error(
    "usage: sampler.ts <scratch-root> <interval-ms> <deadline-epoch-ms> <owner-pid> [run-start-epoch-ms]",
  );
}
const root: string = scratchRoot;
const intervalMilliseconds = Number(intervalArgument);
const deadline = Number(deadlineArgument);
const owner = Number(ownerArgument);
/** Set only for a phased run; see the docblock on `phase`. */
const phaseEpoch = epochArgument === undefined ? null : Number(epochArgument);

const repo = join(root, "repo");
const seriesPath = join(root, "series.jsonl");
const statusPath = join(root, "supervisor-status.json");
const archivePath = join(repo, ".argus", "archive.db");
/**
 * For an unphased run this is this process's start, exactly as #105 had it.
 * For a phased run it is the RUN's start, shared with `traffic.ts`, so the
 * instant at which the rate changes and the instant labelled with that rate
 * are the same instant.
 */
const startedAt = phaseEpoch ?? Date.now();

const SEARCH_QUERIES = ["provenance cursor", "soak traffic", "sqlite backlog"];

function ownerAlive(): boolean {
  try {
    process.kill(owner, 0);
    return true;
  } catch {
    return false;
  }
}

function sizeOf(path: string): number | null {
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

/** RSS in KiB for a set of pids, via `ps -p` — never via a command-line grep. */
async function rssByPid(pids: readonly number[]): Promise<Record<number, number>> {
  if (pids.length === 0) return {};
  const child = Bun.spawn(["ps", "-o", "pid=,rss=", "-p", pids.join(",")], {
    stderr: "ignore",
    stdout: "pipe",
  });
  const text = await new Response(child.stdout).text();
  await child.exited;
  const out: Record<number, number> = {};
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (match) out[Number(match[1])] = Number(match[2]);
  }
  return out;
}

interface StatusWatcher {
  eye: string;
  pid: number;
  repo: string;
}

async function readStatus(): Promise<StatusWatcher[]> {
  try {
    const parsed = (await Bun.file(statusPath).json()) as {
      watchers?: StatusWatcher[];
    };
    return parsed.watchers ?? [];
  } catch {
    return [];
  }
}

interface SqliteShape {
  /** Configured max cache. Positive = pages, negative = KiB (SQLite's own convention). */
  cacheSize: number | null;
  freelistCount: number | null;
  pageCount: number | null;
  pageSize: number | null;
  /** min(cache, page_count) * page_size. An UPPER BOUND, never an occupancy. */
  pageCacheBoundBytes: number | null;
}

function sqliteShape(database: Database): SqliteShape {
  const scalar = (pragma: string): number | null => {
    try {
      const row = database.query<Record<string, number>, []>(`PRAGMA ${pragma}`).get();
      const value = row === null ? undefined : Object.values(row)[0];
      return typeof value === "number" ? value : null;
    } catch {
      return null;
    }
  };
  const cacheSize = scalar("cache_size");
  const pageCount = scalar("page_count");
  const pageSize = scalar("page_size");
  let pageCacheBoundBytes: number | null = null;
  if (cacheSize !== null && pageCount !== null && pageSize !== null) {
    // SQLite reads a NEGATIVE cache_size as KiB and a positive one as pages.
    // Both are handled because the default differs by build and this bound is
    // only worth recording if it is right.
    const cachePages =
      cacheSize < 0 ? Math.floor((-cacheSize * 1024) / pageSize) : cacheSize;
    pageCacheBoundBytes = Math.min(cachePages, pageCount) * pageSize;
  }
  return {
    cacheSize,
    freelistCount: scalar("freelist_count"),
    pageCacheBoundBytes,
    pageCount,
    pageSize,
  };
}

function archiveMetrics(): {
  rows: number | null;
  searchMs: Record<string, number> | null;
  sqlite: SqliteShape | null;
  walPages: number | null;
} {
  let database: Database | undefined;
  try {
    database = new Database(archivePath, { readonly: true, strict: true });
    database.exec("PRAGMA busy_timeout = 5000");
    const rows =
      database.query<{ count: number }, []>("SELECT count(*) AS count FROM archive_messages").get()
        ?.count ?? null;
    const searchMs: Record<string, number> = {};
    for (const query of SEARCH_QUERIES) {
      const match = query
        .split(/\s+/)
        .map((term) => `"${term}"`)
        .join(" AND ");
      const started = Bun.nanoseconds();
      database
        .query<{ id: number }, [string]>(`
          SELECT messages.id
          FROM archive_messages_fts
          JOIN archive_messages AS messages ON messages.id = archive_messages_fts.rowid
          WHERE archive_messages_fts MATCH ?
          ORDER BY bm25(archive_messages_fts), messages.ts DESC, messages.id DESC
          LIMIT 20
        `)
        .all(match);
      searchMs[query] = Number(((Bun.nanoseconds() - started) / 1e6).toFixed(3));
    }
    return { rows, searchMs, sqlite: sqliteShape(database), walPages: null };
  } catch {
    return { rows: null, searchMs: null, sqlite: null, walPages: null };
  } finally {
    database?.close(false);
  }
}

function restartCount(): number | null {
  try {
    const log = readFileSync(join(root, "supervisor.log"), "utf8");
    return (log.match(/exited with code/g) ?? []).length;
  } catch {
    return null;
  }
}

async function sample(): Promise<void> {
  const watchers = await readStatus();
  const pids = watchers.map(({ pid }) => pid);
  const rss = await rssByPid(pids);
  const eyes: Record<string, { pid: number; rssKiB: number | null }> = {};
  let totalKiB = 0;
  let missing = 0;
  for (const watcher of watchers) {
    const value = rss[watcher.pid] ?? null;
    eyes[watcher.eye] = { pid: watcher.pid, rssKiB: value };
    if (value === null) missing += 1;
    else totalKiB += value;
  }
  const archive = archiveMetrics();
  const [one, five, fifteen] = loadavg();
  const elapsedMinutes = Number(((Date.now() - startedAt) / 60_000).toFixed(3));
  const phase = phaseEpoch === null ? null : phaseAt(elapsedMinutes);
  appendFileSync(
    seriesPath,
    `${JSON.stringify({
      at: new Date().toISOString(),
      archiveBytes: sizeOf(archivePath),
      elapsedMinutes,
      eyeCount: watchers.length,
      eyes,
      load: { fifteen, five, one },
      missingRss: missing,
      phase:
        phase === null
          ? null
          : {
              label: phase.label,
              rate: rateName(phase.rowsPerSample),
              rowsPerSample: phase.rowsPerSample,
              startMinute: phase.startMinute,
            },
      restartLines: restartCount(),
      rows: archive.rows,
      searchMs: archive.searchMs,
      sqlite: archive.sqlite,
      shmBytes: sizeOf(`${archivePath}-shm`),
      totalRssMiB: Number((totalKiB / 1024).toFixed(2)),
      walBytes: sizeOf(`${archivePath}-wal`),
    })}\n`,
  );
}

while (Date.now() < deadline && ownerAlive()) {
  try {
    await sample();
  } catch (error) {
    appendFileSync(
      seriesPath,
      `${JSON.stringify({
        at: new Date().toISOString(),
        sampleError: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  }
  await Bun.sleep(intervalMilliseconds);
}
