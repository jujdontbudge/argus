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
 */
import { Database } from "bun:sqlite";
import { appendFileSync, statSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";

const [, , scratchRoot, intervalArgument, deadlineArgument, ownerArgument] = process.argv;
if (!scratchRoot || !intervalArgument || !deadlineArgument || !ownerArgument) {
  throw new Error("usage: sampler.ts <scratch-root> <interval-ms> <deadline-epoch-ms> <owner-pid>");
}
const intervalMilliseconds = Number(intervalArgument);
const deadline = Number(deadlineArgument);
const owner = Number(ownerArgument);

const repo = join(scratchRoot, "repo");
const seriesPath = join(scratchRoot, "series.jsonl");
const statusPath = join(scratchRoot, "supervisor-status.json");
const archivePath = join(repo, ".argus", "archive.db");
const startedAt = Date.now();

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

function archiveMetrics(): {
  rows: number | null;
  searchMs: Record<string, number> | null;
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
    return { rows, searchMs, walPages: null };
  } catch {
    return { rows: null, searchMs: null, walPages: null };
  } finally {
    database?.close(false);
  }
}

function restartCount(): number | null {
  try {
    const log = require("node:fs").readFileSync(join(scratchRoot, "supervisor.log"), "utf8") as string;
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
  appendFileSync(
    seriesPath,
    `${JSON.stringify({
      at: new Date().toISOString(),
      archiveBytes: sizeOf(archivePath),
      elapsedMinutes: Number(((Date.now() - startedAt) / 60_000).toFixed(3)),
      eyeCount: watchers.length,
      eyes,
      load: { fifteen, five, one },
      missingRss: missing,
      restartLines: restartCount(),
      rows: archive.rows,
      searchMs: archive.searchMs,
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
