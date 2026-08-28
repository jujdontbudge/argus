/**
 * #116's measurement: ONE fleet, N repos, one series file per repo.
 *
 * ---------------------------------------------------------------------------
 * WHY PER-REPO SERIES FILES RATHER THAN ONE WIDE ONE
 * ---------------------------------------------------------------------------
 * #116 says to reuse #110's `latency.ts` Report machinery and to CITE it rather
 * than refit it. `latency.ts` judges a `Sample[]` and its `usableSamples`
 * requires `eyeCount === 5` — five eyes, one repo, one archive. That is exactly
 * one repo's worth of fleet.
 *
 * So this file emits `series-repo-<i>.jsonl` per repo, each line a `Sample` in
 * `latency.ts`'s own shape with that repo's five eyes, that repo's archive rows
 * and that repo's search timings. `judge()` then runs UNCHANGED, N times, and
 * #110's registered per-archived-row bars apply per repo exactly as written.
 * Flattening N repos into one series would have required editing `latency.ts`,
 * and #110 refused to edit `analyze.ts` for the same reason: a published
 * judgement has to stay byte-for-byte reproducible.
 *
 * Fleet-wide facts that belong to no single repo — total RSS, pid count, the
 * machine's whole-bun RSS, load — go to `fleet.jsonl` instead, so no per-repo
 * series ever contains a number that is not that repo's.
 *
 * ---------------------------------------------------------------------------
 * THE LEAKAGE PROBE, WHICH IS THE POINT OF THE TICKET
 * ---------------------------------------------------------------------------
 * #116 calls no cross-repo leakage "the single most important correctness
 * property here, more than performance". A row count cannot show it: repo 0 and
 * repo 1 both grow, and "grew by the right amount" is an inference.
 *
 * `seed116.ts` and `traffic116.ts` stamp every line with a `marker<i>` token
 * unique to its repo, so leakage is a DIRECT query rather than an inference:
 * `foreignRows` is the number of rows in repo i's archive that FTS-match some
 * other repo's marker. Zero is the only passing value and it is a fact, not a
 * statistic. `ownRows` is recorded beside it so a probe that silently matched
 * nothing at all cannot be mistaken for a clean result.
 *
 * ---------------------------------------------------------------------------
 * WHY CPU TIME IS COLLECTED, WHICH #105 AND #109 DID NOT NEED
 * ---------------------------------------------------------------------------
 * Under one HOME, `listFiles()` hands every watcher every repo's transcripts;
 * `sessionsForRepo` then parses and discards the foreign ones. Per-watcher
 * parse work therefore scales with N, and with 5N watchers the fleet's total
 * parse work scales as N^2 for a per-repo corpus that is constant. RSS alone
 * cannot see that — discarded parses cost CPU, not resident bytes. `ps -o time=`
 * is cumulative CPU per pid, so differencing it across the run gives CPU-seconds
 * per watcher directly. Whether the N^2 term is real and how big it is, is left
 * to the analysis; this file only has to make it MEASURABLE.
 *
 * Everything else is `scripts/soak/sampler.ts`'s discipline unchanged: RSS by
 * PID via `ps -p` and never by a command-line grep (a grep matches Johan's own
 * ~28 sessions), one self-describing JSON line appended and the handle closed,
 * and an owner-pid liveness check so this process can never outlive its run.
 */
import { Database } from "bun:sqlite";
import { appendFileSync, readFileSync, statSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";

const [, , scratchRoot, intervalArgument, deadlineArgument, ownerArgument, epochArgument, countArgument] =
  process.argv;
if (!scratchRoot || !intervalArgument || !deadlineArgument || !ownerArgument || !epochArgument) {
  throw new Error(
    "usage: sampler116.ts <scratch-root> <interval-ms> <deadline-epoch-ms> <owner-pid> <run-start-epoch-ms> [repo-count]",
  );
}
const root: string = scratchRoot;
const intervalMilliseconds = Number(intervalArgument);
const deadline = Number(deadlineArgument);
const owner = Number(ownerArgument);
const startedAt = Number(epochArgument);
const repoCount = Number(countArgument ?? 3);

const statusPath = join(root, "supervisor-status.json");
const fleetPath = join(root, "fleet.jsonl");

/** #110's `REGISTERED` keys, verbatim. A different string gets a different bar. */
const SEARCH_QUERIES = ["provenance cursor", "soak traffic", "sqlite backlog"];

interface RepoTarget {
  archivePath: string;
  index: number;
  path: string;
  seriesPath: string;
}

const targets: RepoTarget[] = [];
for (let index = 0; index < repoCount; index += 1) {
  const path = join(root, `repo-${index}`);
  targets.push({
    archivePath: join(path, ".argus", "archive.db"),
    index,
    path,
    seriesPath: join(root, `series-repo-${index}.jsonl`),
  });
}

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

interface PidStat {
  cpuSeconds: number | null;
  rssKiB: number;
}

/** RSS and cumulative CPU for a set of pids, via `ps -p` — never a grep. */
async function statsByPid(pids: readonly number[]): Promise<Record<number, PidStat>> {
  if (pids.length === 0) return {};
  const child = Bun.spawn(["ps", "-o", "pid=,rss=,time=", "-p", pids.join(",")], {
    stderr: "ignore",
    stdout: "pipe",
  });
  const text = await new Response(child.stdout).text();
  await child.exited;
  const out: Record<number, PidStat> = {};
  for (const line of text.split("\n")) {
    // `ps` prints CPU time as [[dd-]hh:]mm:ss.ff.
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/);
    if (!match) continue;
    const parts = match[3]!.split(/[-:]/).map(Number);
    let cpuSeconds: number | null = 0;
    for (const part of parts) {
      if (!Number.isFinite(part)) { cpuSeconds = null; break; }
      cpuSeconds = (cpuSeconds ?? 0) * 60 + part;
    }
    out[Number(match[1])] = { cpuSeconds, rssKiB: Number(match[2]) };
  }
  return out;
}

/** Whole-machine bun RSS in GiB — the ticket's RAM guard, recorded every sample. */
async function machineBunRssGiB(): Promise<number | null> {
  const child = Bun.spawn(["ps", "-eo", "rss=,comm="], { stderr: "ignore", stdout: "pipe" });
  const text = await new Response(child.stdout).text();
  await child.exited;
  let kiB = 0;
  let seen = false;
  for (const line of text.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    if (!match || !/bun/i.test(match[2]!)) continue;
    kiB += Number(match[1]);
    seen = true;
  }
  return seen ? Number((kiB / 1048576).toFixed(3)) : null;
}

interface StatusWatcher {
  eye: string;
  pid: number;
  repo: string;
}

async function readStatus(): Promise<StatusWatcher[]> {
  try {
    const parsed = (await Bun.file(statusPath).json()) as { watchers?: StatusWatcher[] };
    return parsed.watchers ?? [];
  } catch {
    return [];
  }
}

interface SqliteShape {
  cacheSize: number | null;
  freelistCount: number | null;
  pageCacheBoundBytes: number | null;
  pageCount: number | null;
  pageSize: number | null;
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
    const cachePages = cacheSize < 0 ? Math.floor((-cacheSize * 1024) / pageSize) : cacheSize;
    pageCacheBoundBytes = Math.min(cachePages, pageCount) * pageSize;
  }
  return { cacheSize, freelistCount: scalar("freelist_count"), pageCacheBoundBytes, pageCount, pageSize };
}

interface ArchiveMetrics {
  foreignMarkers: Record<string, number> | null;
  foreignRows: number | null;
  ownRows: number | null;
  rows: number | null;
  searchMs: Record<string, number> | null;
  sqlite: SqliteShape | null;
}

function countMatching(database: Database, token: string): number {
  return (
    database
      .query<{ count: number }, [string]>(
        "SELECT count(*) AS count FROM archive_messages_fts WHERE archive_messages_fts MATCH ?",
      )
      .get(`"${token}"`)?.count ?? 0
  );
}

function archiveMetrics(target: RepoTarget): ArchiveMetrics {
  let database: Database | undefined;
  try {
    database = new Database(target.archivePath, { readonly: true, strict: true });
    database.exec("PRAGMA busy_timeout = 5000");
    const rows =
      database
        .query<{ count: number }, []>("SELECT count(*) AS count FROM archive_messages")
        .get()?.count ?? null;

    const searchMs: Record<string, number> = {};
    for (const query of SEARCH_QUERIES) {
      const match = query.split(/\s+/).map((term) => `"${term}"`).join(" AND ");
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

    const foreignMarkers: Record<string, number> = {};
    let foreignRows = 0;
    for (let other = 0; other < repoCount; other += 1) {
      if (other === target.index) continue;
      const count = countMatching(database, `marker${other}`);
      foreignMarkers[`marker${other}`] = count;
      foreignRows += count;
    }
    return {
      foreignMarkers,
      foreignRows,
      ownRows: countMatching(database, `marker${target.index}`),
      rows,
      searchMs,
      sqlite: sqliteShape(database),
    };
  } catch {
    return {
      foreignMarkers: null,
      foreignRows: null,
      ownRows: null,
      rows: null,
      searchMs: null,
      sqlite: null,
    };
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
  const stats = await statsByPid(watchers.map(({ pid }) => pid));
  const [one, five, fifteen] = loadavg();
  const load = { fifteen, five, one };
  const elapsedMinutes = Number(((Date.now() - startedAt) / 60_000).toFixed(3));
  const at = new Date().toISOString();

  let fleetKiB = 0;
  let fleetCpu = 0;
  let fleetMissing = 0;

  for (const target of targets) {
    // Attribution comes from the supervisor's OWN status file, by repo path.
    // If the supervisor mis-attributed a watcher this would pick it up as a
    // wrong eyeCount, which `latency.ts` then refuses to score at all.
    const mine = watchers.filter((watcher) => watcher.repo === target.path);
    const eyes: Record<string, { cpuSeconds: number | null; pid: number; rssKiB: number | null }> = {};
    let totalKiB = 0;
    let missing = 0;
    for (const watcher of mine) {
      const stat = stats[watcher.pid];
      eyes[watcher.eye] = {
        cpuSeconds: stat?.cpuSeconds ?? null,
        pid: watcher.pid,
        rssKiB: stat?.rssKiB ?? null,
      };
      if (stat === undefined) missing += 1;
      else {
        totalKiB += stat.rssKiB;
        fleetCpu += stat.cpuSeconds ?? 0;
      }
    }
    fleetKiB += totalKiB;
    fleetMissing += missing;

    const archive = archiveMetrics(target);
    appendFileSync(
      target.seriesPath,
      `${JSON.stringify({
        at,
        archiveBytes: sizeOf(target.archivePath),
        elapsedMinutes,
        // `latency.ts`'s `usableSamples` gate. Five means this repo's own five.
        eyeCount: mine.length,
        eyes,
        foreignMarkers: archive.foreignMarkers,
        foreignRows: archive.foreignRows,
        load,
        missingRss: missing,
        ownRows: archive.ownRows,
        repo: target.path,
        repoIndex: target.index,
        restartLines: restartCount(),
        rows: archive.rows,
        searchMs: archive.searchMs,
        shmBytes: sizeOf(`${target.archivePath}-shm`),
        sqlite: archive.sqlite,
        totalRssMiB: Number((totalKiB / 1024).toFixed(2)),
        walBytes: sizeOf(`${target.archivePath}-wal`),
      })}\n`,
    );
  }

  appendFileSync(
    fleetPath,
    `${JSON.stringify({
      at,
      elapsedMinutes,
      fleetCpuSeconds: Number(fleetCpu.toFixed(2)),
      fleetRssMiB: Number((fleetKiB / 1024).toFixed(2)),
      load,
      // The ticket's RAM guard, recorded rather than only checked, so the run
      // can say afterwards how close it ever came.
      machineBunRssGiB: await machineBunRssGiB(),
      missingRss: fleetMissing,
      repoCount,
      restartLines: restartCount(),
      // Linear-in-N is the claim; pid count is how it is checked.
      watcherCount: watchers.length,
      watchersByRepo: Object.fromEntries(
        targets.map((target) => [
          target.index,
          watchers.filter((watcher) => watcher.repo === target.path).length,
        ]),
      ),
      // A watcher in the status file whose repo is not one of ours would be a
      // supervisor attribution failure, so it is counted rather than assumed away.
      unattributed: watchers.filter(
        (watcher) => !targets.some((target) => target.path === watcher.repo),
      ).length,
    })}\n`,
  );
}

while (Date.now() < deadline && ownerAlive()) {
  try {
    await sample();
  } catch (error) {
    appendFileSync(
      fleetPath,
      `${JSON.stringify({
        at: new Date().toISOString(),
        sampleError: error instanceof Error ? error.message : String(error),
      })}\n`,
    );
  }
  await Bun.sleep(intervalMilliseconds);
}
