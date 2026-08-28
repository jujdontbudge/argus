/**
 * #117's continuous measurement. #116's sampler discipline unchanged — RSS by
 * `ps -p` on owned pids and never a command-line grep, one self-describing JSON
 * line per sample, an owner-pid liveness check — with three additions #117 needs
 * and #116 did not.
 *
 * 1. SUSPEND DETECTION (ticket item 3). The ticket says not to SIMULATE
 *    sleep/wake but to INSTRUMENT for the real thing, because this machine
 *    already sleeps unpredictably. A sleeping Mac stops the sampler's timer
 *    without stopping the wall clock, so a sample whose measured interval
 *    greatly exceeds its nominal one is a suspend candidate. Each sample
 *    records `intervalMs` (measured) beside `nominalIntervalMs`, so the gap is
 *    in the raw series and no post-hoc reconstruction is needed. `pmset -g log`
 *    is captured separately at teardown as the corroborating source.
 *
 * 2. PER-EYE HEALTH. `health.json` is where a watcher says it is broken, and
 *    #117 item 2 asks whether failure is LOUD. So every sample reads all five
 *    eyes' `health.json` per repo and records pid, lastError and lastSuccess.
 *    The pid field is what proves a post-kill replacement actually took the
 *    watch lease over rather than merely being spawned: a new process that
 *    cannot get the lease exits at once and never writes health.
 *
 * 3. SENTINEL PROGRESS. `maxArchivedSeq` per repo, sampled continuously, so a
 *    stall is visible as it happens rather than only in the final subtraction.
 *
 * Everything is read-only against the archive, opened `readonly` with a busy
 * timeout, so the measurement can never be the thing that corrupts the file
 * item 2 is about to corrupt on purpose.
 */
import { Database } from "bun:sqlite";
import { appendFileSync } from "node:fs";
import { loadavg } from "node:os";
import { join } from "node:path";

const [, , scratchRoot, intervalArgument, deadlineArgument, ownerArgument, epochArgument, countArgument] =
  process.argv;
if (!scratchRoot || !intervalArgument || !deadlineArgument || !ownerArgument || !epochArgument) {
  throw new Error(
    "usage: sampler117.ts <scratch-root> <interval-ms> <deadline-epoch-ms> <owner-pid> <run-start-epoch-ms> [repo-count]",
  );
}
const root: string = scratchRoot;
const nominalIntervalMs = Number(intervalArgument);
const deadline = Number(deadlineArgument);
const owner = Number(ownerArgument);
const startedAt = Number(epochArgument);
const repoCount = Number(countArgument ?? 2);

const EYES = ["reviewer", "archiver", "honcho", "digest", "retro"] as const;
const statusPath = join(root, "supervisor-status.json");
const seriesPath = join(root, "series.jsonl");

interface RepoTarget {
  archivePath: string;
  index: number;
  path: string;
}

const targets: RepoTarget[] = Array.from({ length: repoCount }, (_, index) => {
  const path = join(root, `repo-${index}`);
  return { archivePath: join(path, ".argus", "archive.db"), index, path };
});

function ownerAlive(): boolean {
  try {
    process.kill(owner, 0);
    return true;
  } catch {
    return false;
  }
}

interface PidStat {
  cpuSeconds: number | null;
  rssKiB: number;
}

/** RSS and cumulative CPU for owned pids, via `ps -p` — never a grep (#116). */
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
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/);
    if (!match) continue;
    const parts = match[3]!.split(/[-:]/).map(Number);
    let cpuSeconds: number | null = 0;
    for (const part of parts) {
      if (!Number.isFinite(part)) {
        cpuSeconds = null;
        break;
      }
      cpuSeconds = (cpuSeconds ?? 0) * 60 + part;
    }
    out[Number(match[1])] = { cpuSeconds, rssKiB: Number(match[2]) };
  }
  return out;
}

/** Whole-machine bun RSS in MiB — the ticket's RAM guard, every sample. */
async function machineBunRssMiB(): Promise<number | null> {
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
  return seen ? Number((kiB / 1024).toFixed(2)) : null;
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

interface EyeHealthSample {
  backlog: number | null;
  lastError: string | null;
  lastErrorAt: string | null;
  lastSuccess: string | null;
  pid: number | null;
  readable: boolean;
}

async function eyeHealth(repoPath: string, eye: string): Promise<EyeHealthSample> {
  try {
    const value = (await Bun.file(join(repoPath, ".argus", "eyes", eye, "health.json")).json()) as {
      backlog?: number;
      lastError?: { at: string; message: string } | null;
      lastSuccess?: string | null;
      pid?: number;
    };
    return {
      backlog: value.backlog ?? null,
      lastError: value.lastError?.message ?? null,
      lastErrorAt: value.lastError?.at ?? null,
      lastSuccess: value.lastSuccess ?? null,
      pid: value.pid ?? null,
      readable: true,
    };
  } catch {
    return {
      backlog: null,
      lastError: null,
      lastErrorAt: null,
      lastSuccess: null,
      pid: null,
      readable: false,
    };
  }
}

interface ArchiveSample {
  error: string | null;
  integrity: string | null;
  maxArchivedSeq: number | null;
  ownSentinelRows: number | null;
  rows: number | null;
  walBytes: number | null;
}

function archiveSample(target: RepoTarget): ArchiveSample {
  let database: Database | undefined;
  try {
    database = new Database(target.archivePath, { readonly: true, strict: true });
    database.exec("PRAGMA busy_timeout = 5000");
    const rows =
      database.query<{ count: number }, []>("SELECT count(*) AS count FROM archive_messages").get()
        ?.count ?? null;
    // `_` is a LIKE wildcard, so the sentinel's own underscores are escaped.
    // The token is fixed width and zero padded, so a lexicographic max over its
    // first `token.length` characters IS the numeric max sequence number.
    const prefix = `chaos117_r${target.index}_s`;
    const tokenLength = prefix.length + 7;
    const pattern = `chaos117\\_r${target.index}\\_s%`;
    const sentinelRow = database
      .query<{ count: number; top: string | null }, [number, string]>(
        "SELECT count(*) AS count, max(substr(content, 1, ?)) AS top FROM archive_messages WHERE content LIKE ? ESCAPE '\\'",
      )
      .get(tokenLength, pattern);
    const top = sentinelRow?.top ?? null;
    return {
      error: null,
      integrity: null,
      maxArchivedSeq: top === null ? null : Number(top.slice(prefix.length)),
      ownSentinelRows: sentinelRow?.count ?? null,
      rows,
      walBytes: null,
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      integrity: null,
      maxArchivedSeq: null,
      ownSentinelRows: null,
      rows: null,
      walBytes: null,
    };
  } finally {
    database?.close();
  }
}

function sizeOf(path: string): number | null {
  try {
    return Bun.file(path).size;
  } catch {
    return null;
  }
}

let previousSampleAt: number | null = null;

while (Date.now() < deadline && ownerAlive()) {
  const sampledAt = Date.now();
  const intervalMs = previousSampleAt === null ? null : sampledAt - previousSampleAt;
  previousSampleAt = sampledAt;

  let sampleError: string | null = null;
  const line: Record<string, unknown> = {
    elapsedMinutes: Number(((sampledAt - startedAt) / 60_000).toFixed(3)),
    intervalMs,
    // A measured interval far above nominal means this process was not
    // scheduled — the machine slept, or the load average ate it. Recorded, not
    // judged, exactly as the ticket asks. Corroborated by pmset at teardown.
    nominalIntervalMs,
    sampledAt: new Date(sampledAt).toISOString(),
    sampledAtEpochMs: sampledAt,
  };
  try {
    const watchers = await readStatus();
    const stats = await statsByPid(watchers.map(({ pid }) => pid));
    let fleetRssKiB = 0;
    let fleetCpuSeconds = 0;
    for (const { pid } of watchers) {
      const stat = stats[pid];
      if (stat === undefined) continue;
      fleetRssKiB += stat.rssKiB;
      fleetCpuSeconds += stat.cpuSeconds ?? 0;
    }
    line.watcherCount = watchers.length;
    line.livePidCount = watchers.filter(({ pid }) => stats[pid] !== undefined).length;
    line.fleetRssMiB = Number((fleetRssKiB / 1024).toFixed(2));
    line.fleetCpuSeconds = Number(fleetCpuSeconds.toFixed(2));
    line.machineBunRssMiB = await machineBunRssMiB();
    line.loadAverage1m = Number(loadavg()[0]!.toFixed(2));
    line.watchers = watchers
      .map(({ eye, pid, repo }) => `${repo}:${eye}:${pid}`)
      .sort();
    line.repos = await Promise.all(
      targets.map(async (target) => ({
        archive: archiveSample(target),
        archiveBytes: sizeOf(target.archivePath),
        health: Object.fromEntries(
          await Promise.all(
            EYES.map(async (eye) => [eye, await eyeHealth(target.path, eye)] as const),
          ),
        ),
        index: target.index,
        walBytes: sizeOf(`${target.archivePath}-wal`),
      })),
    );
  } catch (error) {
    sampleError = error instanceof Error ? error.message : String(error);
  }
  line.sampleError = sampleError;
  appendFileSync(seriesPath, `${JSON.stringify(line)}\n`);
  await Bun.sleep(nominalIntervalMs);
}
