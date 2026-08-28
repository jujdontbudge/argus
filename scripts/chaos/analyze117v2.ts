/**
 * #119's CORRECTED copy of #117's pre-registered verdict.
 *
 * `scripts/chaos/analyze117.ts` is the sealed #117 record and is NOT edited —
 * same discipline as analyze.ts / analyze109.ts / analyze116.ts before it. The
 * verdict that file returned on #117's run stands as written. This file is a
 * copy of it with exactly two harness defects fixed, both filed in
 * docs/acceptance/chaos117.txt §6 and ticketed as #119 H1 and H2. Nothing else
 * is changed: every threshold, every other component and the overall rule are
 * byte-for-byte what #117 pre-registered.
 *
 * H1 (leaseTakeover / healthPidSeen) — the sealed file returns a bare `false`
 *   when no sample in the window carries the replacement pid, so "the sampler
 *   never had an opportunity to look" is scored identically to "the watcher
 *   never took its lease". It has no third state, even though the same file is
 *   careful about exactly this elsewhere: `inBudget` and `leaseTakenOver` are
 *   nulled when `newPid` is null and `leaseJudged` filters nulls out. Fixed
 *   below by bounding the observation window at the replacement's own death and
 *   returning `null` when that window contains no usable sample. See the
 *   COMPONENT 4 section for the argument.
 *
 * H2 (bystander) — the sealed file counts supervisor restart lines across the
 *   whole log with no teardown exclusion, while `noMessageLoss` in the same file
 *   excludes the last TAIL_GRACE_MS by design and says why. Fixed below by
 *   applying the same exclusion. See the COMPONENT 6 section.
 *
 * Neither fix invents a threshold. Both reuse a rule the sealed file already
 * argued for and already applies somewhere else in the same verdict.
 *
 * ---------------------------------------------------------------------------
 * The original preamble, unchanged, follows.
 * ---------------------------------------------------------------------------
 *
 * #117's PRE-REGISTERED verdict. Committed before the run it judges, in the
 * discipline soak.txt, soak2.txt and scale116.txt established: the rule that
 * decides PASS or FAIL is written down while the outcome is still unknown, so
 * a number that lands badly cannot be reinterpreted into a number that lands
 * well. Every threshold below is argued here and nowhere else.
 *
 * ===========================================================================
 * WHAT #117 IS ALLOWED TO CLAIM, AND WHAT IT IS NOT
 * ===========================================================================
 * `src/supervisor/runtime.test.ts` already proves the restart POLICY: crash
 * causes respawn, backoff is exponential, five restarts in a five-minute window
 * brakes the eye, and one repo's crash storm does not brake another's. It
 * proves all of that against a `FakeProcess` whose `crash()` is a resolved
 * promise. Nothing here re-derives any of it.
 *
 * What a fake process cannot exercise, and what this file judges, is everything
 * between a REAL SIGKILL and a REAL replacement being useful:
 *   - a killed watcher leaves a `watch.lock` behind (src/watch/lease.ts). The
 *     replacement must take that lease over or it exits immediately and the eye
 *     is dead forever while `supervisor-status.json` still lists it as running.
 *   - the supervisor learns about a real death through `child.exited`, not a
 *     promise it resolved itself.
 *   - the archive's transactional message+cursor commit has to actually hold
 *     across a process torn down mid-`catchUp`.
 * That is the gap this run measures, and the verdict below is confined to it.
 *
 * ===========================================================================
 * COMPONENT 1 — noMessageLoss                                    PASS / FAIL
 * ===========================================================================
 * Set subtraction over sentinel sequence numbers, per repo:
 *     lost = { seq in the ledger } \ { seq in archive_messages }
 * PASS iff `lost` is empty for every repo. There is no tolerance and no
 * statistic: `traffic117.ts` writes the transcript line before the ledger line,
 * so the ledger is provably a subset of what was really emitted, and any seq in
 * it that is not in the archive is a message that was written and never landed.
 *
 * ONE EXCLUSION, defined here rather than after seeing the data. Traffic runs
 * until the run's deadline, so the last sentinels are genuinely still in flight
 * when the fleet is torn down; counting them as lost would fail every possible
 * run. Sentinels emitted within TAIL_GRACE_MS of the traffic generator's own
 * recorded exit are therefore excluded from `lost` and reported separately as
 * `inFlightAtTeardown`, with the count of them that landed anyway.
 *
 * TAIL_GRACE_MS = 120_000. The archiver polls every 1_000 ms
 * (src/watch.ts `pollMilliseconds`) and a settled `catchUp` of one second of
 * traffic is milliseconds of work, so 120 s is two orders of magnitude of
 * slack. It is a grace on the LAST two minutes only; a message lost at minute
 * 30 of a 70-minute run is lost, and is reported as lost.
 *
 * ===========================================================================
 * COMPONENT 2 — restartBudget                                    PASS / FAIL
 * ===========================================================================
 * The supervisor states its own intended delay in its own stderr:
 *     "... exited with code N; restart A/L in D ms"
 * so the attempt number and the policy delay are ground truth read from the
 * process under test, never reconstructed by the harness. For every kill with
 * a matched restart:
 *     PASS iff restartMs <= D + SLACK_MS
 *
 * SLACK_MS = 5_000, and it is 5x the supervisor's 1_000 ms reconcile poll
 * (src/supervisor/daemon.ts `ARGUS_SUPERVISOR_POLL_MS`). The measured
 * `restartMs` already includes, on top of D: the exit being noticed, the
 * reconcile queue possibly being busy, a registry read, a temp-then-rename
 * status write, and the killer's own 100 ms observation granularity. Every one
 * of those inflates the measurement, so this check errs against the code under
 * test, which is the only direction a budget check may err in.
 *
 * ===========================================================================
 * COMPONENT 3 — restartCompletion                                PASS / FAIL
 * ===========================================================================
 * PASS iff every `killed` event ended in either a `restarted` event or a
 * "restart limit reached" line naming that pid. A kill with neither is a
 * watcher that silently never came back, which is the failure #89 shipped and
 * the reason this ticket exists.
 *
 * ===========================================================================
 * COMPONENT 4 — leaseTakeover                                    PASS / FAIL
 * ===========================================================================
 * A replacement that cannot take over the dead watcher's `watch.lock` returns 0
 * from `runLoop` before writing any health, while `supervisor-status.json` has
 * already listed it as running. Status alone therefore cannot distinguish a
 * working eye from a permanently blocked one. PASS iff, for every restart, the
 * new pid appears as `health.json`'s `pid` in some sample within
 * LEASE_TAKEOVER_MS of that restart.
 *
 * LEASE_TAKEOVER_MS = 120_000: `acquireWatchLease` retries at the watcher's
 * poll interval and `moveStaleLease` fires as soon as the recorded owner is
 * seen dead, so takeover is expected in single-digit seconds. 120 s asks only
 * that it happen at all on a human timescale.
 *
 * #119 H1 FIX. The question above is only answerable if the sampler actually
 * looked while the replacement was alive. Two things can make that false, and
 * #117 hit both:
 *   - the brake phase kills the same eye every 8-10 s while the sampler runs at
 *     15 s, so a replacement can be born and killed strictly between two
 *     consecutive samples (#117 idx 37: pid 65148, 8.2 s of life, born 1.5 s
 *     after one sample and killed 6.2 s before the next);
 *   - the sampler can stop for minutes at a time across a suspend gap (#117
 *     idx 40: pid 66591, sampler blind from 17:59:26 to 18:02:56, so the first
 *     possible observation landed 201.7 s after the restart, past the 120 s
 *     bar). Scoring that as a failure smuggles sleep/wake into the verdict in
 *     the FAIL direction through the back door, which the suspendGaps docblock
 *     below explicitly says this file refuses to do.
 * So a second, narrower window is introduced: the OBSERVABILITY window, from
 * the restart to the earlier of `restart + LEASE_TAKEOVER_MS` and the moment
 * that replacement pid was itself killed — the interval in which the sampler
 * could have caught it alive and current.
 *
 * The two windows are used ASYMMETRICALLY, and the asymmetry is the whole
 * point. `health.json` is a file, not a process: once a replacement writes its
 * pid there, that pid stays on disk until the NEXT replacement overwrites it,
 * so a sighting is proof of a write that already happened and is sound wherever
 * in the 120 s bar it lands, including after the pid is dead. Narrowing the
 * positive test would throw away real evidence. Narrowing the negative test is
 * exactly what H1 asks for. Hence:
 *
 *   seen anywhere in [restart, restart + LEASE_TAKEOVER_MS]        -> true
 *   not seen, and >= 1 usable sample in the observability window   -> false
 *   not seen, and 0 usable samples in the observability window     -> null
 *
 * `leaseJudged` filters the nulls exactly as it already filters the
 * `newPid === null` nulls. `null` means "not measured here"; it is never a
 * pass. A run in which every kill nulls out judges nothing and cannot PASS,
 * because `leaseJudged.length > 0` is still required.
 *
 * This asymmetry is not decorative: on #117's data the symmetric version — the
 * obvious first cut, narrowing both tests — turned idx 42 (pid 69061) from a
 * correct `true` into a `null`, because that replacement wrote health, was
 * killed, and was then observed from the file it had already written. The
 * symmetric fix would have traded two false negatives for one lost true
 * positive. This one loses none.
 *
 * ===========================================================================
 * COMPONENT 5 — brake                                            PASS / FAIL
 * ===========================================================================
 * The brake phase drives one eye past five restarts inside one five-minute
 * window. PASS iff BOTH: at least one "restart limit reached" line appears, and
 * that eye holds a live pid in the final sample. Braking is correct; braking
 * forever is not. Only the pair is a pass.
 *
 * ===========================================================================
 * COMPONENT 6 — bystander                                        PASS / FAIL
 * ===========================================================================
 * Repo 1 is never a target. PASS iff it lost zero sentinels under the same
 * grace rule AND the supervisor logged zero restart lines naming it. This is
 * runtime.test.ts's "a crash storm in one repo does not brake another repo's
 * watchers" carried to a real fleet, and extended: not merely un-braked, but
 * un-disturbed, down to the message.
 *
 * #119 H2 FIX. "Under the same grace rule" was true of the sentinel half and
 * false of the log half. The sentinel half excludes anything within
 * TAIL_GRACE_MS of the traffic generator's exit, on the stated reasoning that
 * the tail of a run is not a fair place to judge from; the log half judged the
 * whole file. On #117 that failed the component on a single line the supervisor
 * wrote during its OWN shutdown, about an original repo-1 watcher that was
 * never killed and ran the full 70 minutes, 13 s after the planned end. The
 * same TAIL_GRACE_MS exclusion is applied to the log half here.
 *
 * Dating a log line takes one step, because supervisor.log carries no
 * timestamps. A line names the pid that exited, and that pid cannot have exited
 * before the last sample that still listed it as a live watcher. That last
 * sighting is therefore a sound LOWER BOUND on the exit time, and the bound is
 * all this needs: if the lower bound is already inside the grace window, the
 * exit is inside it too, whatever the exact instant was. The comparison only
 * ever excludes a line when the exclusion is certain. A line whose pid never
 * appeared in any sample cannot be dated and is JUDGED, not excluded — the
 * fix cannot quietly widen itself into an amnesty.
 *
 * ===========================================================================
 * COMPONENT 7 — ramGuard                                     WITHIN / BREACH
 * ===========================================================================
 * Peak whole-machine bun RSS against RAM_GUARD_MIB = 3_072, the same number
 * #116 pre-registered and the same sampled field. BREACH is an overall FAIL.
 *
 * ===========================================================================
 * REPORTED, NOT JUDGED — suspendGaps (ticket item 3)
 * ===========================================================================
 * Samples whose measured interval exceeds 3x nominal are listed as suspend
 * candidates, with what the fleet looked like across each. NO bar is invented:
 * the ticket asks to instrument for a real sleep/wake, not to threshold one,
 * and a run in which the machine never slept must not be scored as a pass for
 * a property it never tested. This section is excluded from the overall
 * verdict by construction, and says so in its own output.
 *
 * OVERALL = PASS iff components 1-6 are all PASS and component 7 is WITHIN.
 */
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const TAIL_GRACE_MS = 120_000;
export const SLACK_MS = 5_000;
export const LEASE_TAKEOVER_MS = 120_000;
export const RAM_GUARD_MIB = 3_072;
export const SUSPEND_GAP_MULTIPLE = 3;
export const TARGET_REPO_INDEX = 0;
export const BYSTANDER_REPO_INDEX = 1;

const rootArgument = process.argv[2];
if (!rootArgument) throw new Error("usage: analyze117v2.ts <scratch-root>");
// Plainly typed: the readers below are hoisted declarations, so TypeScript will
// not carry the narrowing above into their bodies.
const root: string = rootArgument;

function readLines(path: string): string[] {
  try {
    return readFileSync(path, "utf8").split("\n").filter((line) => line.trim().length > 0);
  } catch {
    return [];
  }
}

function readJsonl<T>(path: string): T[] {
  const out: T[] = [];
  for (const line of readLines(path)) {
    try {
      out.push(JSON.parse(line) as T);
    } catch {
      // A torn final line is possible if a writer was killed mid-append. It is
      // dropped rather than guessed at, and the drop is counted below.
    }
  }
  return out;
}

function tornLines(path: string): number {
  return readLines(path).length - readJsonl(path).length;
}

interface SentinelLedgerLine {
  at: number;
  repo: number;
  seq: number;
  token: string;
}

interface KillLine {
  event: string;
  eye?: string;
  index?: number;
  killedPid?: number;
  newPid?: number;
  phase?: string;
  pid?: number;
  restartMs?: number;
  at: number;
}

interface Sample {
  intervalMs: number | null;
  machineBunRssMiB?: number | null;
  nominalIntervalMs: number;
  repos?: Array<{
    archive: { error: string | null; maxArchivedSeq: number | null; rows: number | null };
    health: Record<string, { lastError: string | null; pid: number | null }>;
    index: number;
  }>;
  sampledAtEpochMs: number;
  sampleError: string | null;
  watcherCount?: number;
  watchers?: string[];
}

const kills = readJsonl<KillLine>(join(root, "kills.jsonl"));
const samples = readJsonl<Sample>(join(root, "series.jsonl"));
const supervisorLog = readLines(join(root, "supervisor.log"));
const trafficExits = readJsonl<{ at: number; reason: string }>(join(root, "traffic-exit.jsonl"));
const manifest = JSON.parse(readFileSync(join(root, "run.json"), "utf8")) as {
  repoCount: number;
  runStartEpochMs: number;
};

/** "... watcher pid P for R exited with code C; restart A/L in D ms" */
const RESTART_LINE = /watcher pid (\d+) for (\S+) exited with code (-?\d+); restart (\d+)\/(\d+) in (\d+)ms/;
/** "... watcher pid P for R exited with code C; restart limit reached; giving up for Mms" */
const BRAKE_LINE = /watcher pid (\d+) for (\S+) exited with code (-?\d+); restart limit reached; giving up for (\d+)ms/;

interface SupervisorRestart {
  attempt: number;
  delayMs: number;
  limit: number;
  pid: number;
  repo: string;
}
const supervisorRestarts = new Map<number, SupervisorRestart>();
const supervisorBrakes: Array<{ pid: number; repo: string; givingUpMs: number }> = [];
for (const line of supervisorLog) {
  const restart = RESTART_LINE.exec(line);
  if (restart) {
    supervisorRestarts.set(Number(restart[1]), {
      attempt: Number(restart[4]),
      delayMs: Number(restart[6]),
      limit: Number(restart[5]),
      pid: Number(restart[1]),
      repo: restart[2]!,
    });
    continue;
  }
  const brake = BRAKE_LINE.exec(line);
  if (brake) {
    supervisorBrakes.push({
      givingUpMs: Number(brake[4]),
      pid: Number(brake[1]),
      repo: brake[2]!,
    });
  }
}

// ---- component 1: no message loss ---------------------------------------
const trafficExitAt =
  trafficExits.length > 0 ? Math.max(...trafficExits.map(({ at }) => at)) : Date.now();
const graceFrom = trafficExitAt - TAIL_GRACE_MS;

interface RepoLoss {
  archivedSentinelRows: number | null;
  archiveError: string | null;
  emitted: number;
  inFlightAtTeardown: number;
  inFlightThatLanded: number;
  judged: number;
  lost: number[];
  lostCount: number;
  repo: number;
  rows: number | null;
  tornLedgerLines: number;
}

function archivedSeqs(repoIndex: number): { error: string | null; rows: number | null; seqs: Set<number> } {
  const seqs = new Set<number>();
  let database: Database | undefined;
  try {
    database = new Database(join(root, `repo-${repoIndex}`, ".argus", "archive.db"), {
      readonly: true,
      strict: true,
    });
    database.exec("PRAGMA busy_timeout = 10000");
    const rows =
      database.query<{ count: number }, []>("SELECT count(*) AS count FROM archive_messages").get()
        ?.count ?? null;
    const prefix = `chaos117_r${repoIndex}_s`;
    const pattern = `chaos117\\_r${repoIndex}\\_s%`;
    for (const row of database
      .query<{ token: string }, [number, string]>(
        "SELECT substr(content, 1, ?) AS token FROM archive_messages WHERE content LIKE ? ESCAPE '\\'",
      )
      .all(prefix.length + 7, pattern)) {
      seqs.add(Number(row.token.slice(prefix.length)));
    }
    return { error: null, rows, seqs };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), rows: null, seqs };
  } finally {
    database?.close();
  }
}

const losses: RepoLoss[] = [];
for (let repo = 0; repo < manifest.repoCount; repo += 1) {
  const ledgerPath = join(root, `sentinels-repo-${repo}.jsonl`);
  const ledger = readJsonl<SentinelLedgerLine>(ledgerPath);
  const archived = archivedSeqs(repo);
  const judged = ledger.filter(({ at }) => at < graceFrom);
  const inFlight = ledger.filter(({ at }) => at >= graceFrom);
  const lost = judged.filter(({ seq }) => !archived.seqs.has(seq)).map(({ seq }) => seq);
  losses.push({
    archivedSentinelRows: archived.seqs.size,
    archiveError: archived.error,
    emitted: ledger.length,
    inFlightAtTeardown: inFlight.length,
    inFlightThatLanded: inFlight.filter(({ seq }) => archived.seqs.has(seq)).length,
    judged: judged.length,
    lost: lost.slice(0, 50),
    lostCount: lost.length,
    repo,
    rows: archived.rows,
    tornLedgerLines: tornLines(ledgerPath),
  });
}
const noMessageLoss = losses.every(({ archiveError, lostCount }) => archiveError === null && lostCount === 0);

// ---- components 2, 3, 4: restart budget, completion, lease --------------
const killed = kills.filter((line) => line.event === "killed");
const restarted = new Map<number, KillLine>();
for (const line of kills) {
  if (line.event === "restarted" && line.killedPid !== undefined) restarted.set(line.killedPid, line);
}
const timedOut = new Set(
  kills.filter((line) => line.event === "restart-timeout").map((line) => line.killedPid!),
);
const brakedPids = new Set(supervisorBrakes.map(({ pid }) => pid));

interface KillVerdict {
  attempt: number | null;
  eye: string;
  index: number;
  inBudget: boolean | null;
  killedPid: number;
  /** #119 H1: samples that could have carried this replacement's health. */
  leaseObservations: number | null;
  leaseTakenOver: boolean | null;
  /** #119 H1: end of the interval the sampler could have caught it alive in. */
  leaseWindowEndsAt: string | null;
  newPid: number | null;
  overBudgetMs: number | null;
  phase: string;
  policyDelayMs: number | null;
  restartMs: number | null;
  supervisorBraked: boolean;
}

/**
 * The first `killed` event for `pid` at or after `fromEpochMs`, or null if this
 * replacement was never killed again. Anchored at `fromEpochMs` rather than
 * taking the earliest kill outright, so a recycled pid number from earlier in
 * the run cannot shorten a later replacement's window.
 */
function killedAtOrAfter(pid: number, fromEpochMs: number): number | null {
  let earliest: number | null = null;
  for (const line of kills) {
    if (line.event !== "killed" || line.pid !== pid || line.at < fromEpochMs) continue;
    if (earliest === null || line.at < earliest) earliest = line.at;
  }
  return earliest;
}

interface LeaseObservation {
  /** Usable samples inside the OBSERVABILITY window: chances to have looked. */
  opportunities: number;
  /** true seen, false looked and did not see, null never had a chance to look. */
  seen: boolean | null;
  /** End of the observability window (the narrower of the two). */
  windowEndEpochMs: number;
  windowStartEpochMs: number;
}

/**
 * Did `pid` write health for its eye within the takeover window — and if not,
 * did the sampler ever get a chance to look? #119 H1. The positive test spans
 * the full LEASE_TAKEOVER_MS bar; the negative test only counts samples inside
 * the observability window, which ends at this replacement's own death. See
 * COMPONENT 4 above for why the two differ.
 */
function healthPidSeen(
  repoIndex: number,
  eye: string,
  pid: number,
  fromEpochMs: number,
): LeaseObservation {
  const diedAt = killedAtOrAfter(pid, fromEpochMs);
  const windowEndEpochMs = Math.min(
    fromEpochMs + LEASE_TAKEOVER_MS,
    diedAt ?? Number.POSITIVE_INFINITY,
  );
  let opportunities = 0;
  for (const sample of samples) {
    const at = sample.sampledAtEpochMs;
    if (at < fromEpochMs) continue;
    if (at > fromEpochMs + LEASE_TAKEOVER_MS) break;
    const repo = sample.repos?.find((entry) => entry.index === repoIndex);
    // A sample carrying no reading for this repo is not a chance to observe it;
    // counting it as one would reintroduce the very defect H1 names.
    if (repo === undefined) continue;
    if (at <= windowEndEpochMs) opportunities += 1;
    if (repo.health[eye]?.pid === pid) {
      return { opportunities, seen: true, windowEndEpochMs, windowStartEpochMs: fromEpochMs };
    }
  }
  return {
    opportunities,
    seen: opportunities === 0 ? null : false,
    windowEndEpochMs,
    windowStartEpochMs: fromEpochMs,
  };
}

const killVerdicts: KillVerdict[] = killed.map((kill) => {
  const pid = kill.pid!;
  const restart = restarted.get(pid);
  const supervisor = supervisorRestarts.get(pid);
  const policyDelayMs = supervisor?.delayMs ?? null;
  const restartMs = restart?.restartMs ?? null;
  const newPid = restart?.newPid ?? null;
  const lease =
    newPid === null ? null : healthPidSeen(TARGET_REPO_INDEX, kill.eye!, newPid, restart!.at);
  return {
    attempt: supervisor?.attempt ?? null,
    eye: kill.eye!,
    index: kill.index!,
    inBudget:
      restartMs === null || policyDelayMs === null ? null : restartMs <= policyDelayMs + SLACK_MS,
    killedPid: pid,
    leaseObservations: lease?.opportunities ?? null,
    leaseTakenOver: lease === null ? null : lease.seen,
    leaseWindowEndsAt:
      lease === null ? null : new Date(lease.windowEndEpochMs).toISOString(),
    newPid,
    overBudgetMs:
      restartMs === null || policyDelayMs === null ? null : restartMs - (policyDelayMs + SLACK_MS),
    phase: kill.phase ?? "unknown",
    policyDelayMs,
    restartMs,
    supervisorBraked: brakedPids.has(pid),
  };
});

const budgetJudged = killVerdicts.filter(({ inBudget }) => inBudget !== null);
const restartBudget = budgetJudged.length > 0 && budgetJudged.every(({ inBudget }) => inBudget === true);
const unattributed = killVerdicts.filter(
  ({ policyDelayMs, supervisorBraked }) => policyDelayMs === null && !supervisorBraked,
);
const incomplete = killVerdicts.filter(
  ({ killedPid, newPid, supervisorBraked }) =>
    newPid === null && !supervisorBraked && !timedOut.has(killedPid),
);
const restartCompletion =
  killVerdicts.every(({ newPid, supervisorBraked }) => newPid !== null || supervisorBraked) &&
  timedOut.size === 0;
const leaseJudged = killVerdicts.filter(({ leaseTakenOver }) => leaseTakenOver !== null);
const leaseTakeover = leaseJudged.length > 0 && leaseJudged.every(({ leaseTakenOver }) => leaseTakenOver === true);

// ---- component 5: brake --------------------------------------------------
const finalSample = samples.at(-1);
const brakeKills = kills.filter((line) => line.event === "killed" && line.phase === "brake");
const brakeEye = brakeKills.at(-1)?.eye ?? null;
/**
 * The target repo's brake-eye pid in the LAST sample, or null if the eye is
 * absent from the status file entirely. `watchers` entries are
 * `<repo>:<eye>:<pid>`; the repo is an absolute path, which contains no colon.
 */
const brakeEyeFinalPid = (() => {
  if (brakeEye === null || finalSample === undefined) return null;
  for (const entry of finalSample.watchers ?? []) {
    const parts = entry.split(":");
    const eye = parts.at(-2);
    const repo = parts.slice(0, -2).join(":");
    if (eye === brakeEye && repo.endsWith(`/repo-${TARGET_REPO_INDEX}`)) return Number(parts.at(-1));
  }
  return null;
})();
// Alive means: present in the final status AND not the very pid the supervisor
// last announced it was giving up on. Braking is correct; braking forever is not.
const brakeEyeAlive = brakeEyeFinalPid !== null && !brakedPids.has(brakeEyeFinalPid);
const brake = supervisorBrakes.length > 0 && brakeEyeAlive;

// ---- component 6: bystander ---------------------------------------------
/**
 * The last sample that still listed `pid` as a live watcher, or null if no
 * sample ever did. `watchers` entries are `<repo>:<eye>:<pid>`.
 */
function lastSeenAliveEpochMs(pid: number): number | null {
  const suffix = `:${pid}`;
  let last: number | null = null;
  for (const sample of samples) {
    if ((sample.watchers ?? []).some((entry) => entry.endsWith(suffix))) {
      last = sample.sampledAtEpochMs;
    }
  }
  return last;
}

interface BystanderLine {
  /** Lower bound on the exit: the last sample that still saw this pid alive. */
  lastSeenAliveAt: string | null;
  line: string;
  pid: number | null;
}

const bystanderPath = join(root, `repo-${BYSTANDER_REPO_INDEX}`);
const bystanderRestartLinesAll = supervisorLog.filter(
  (line) => line.includes(bystanderPath) && /exited with code/.test(line),
);
// #119 H2: the same TAIL_GRACE_MS exclusion `noMessageLoss` applies, applied to
// the log half of this component. `graceFrom` is that component's own boundary,
// reused rather than recomputed.
const bystanderRestartLinesJudged: BystanderLine[] = [];
const bystanderRestartLinesExcluded: BystanderLine[] = [];
for (const line of bystanderRestartLinesAll) {
  const pidMatch = /watcher pid (\d+)/.exec(line);
  const pid = pidMatch === null ? null : Number(pidMatch[1]);
  const lastAlive = pid === null ? null : lastSeenAliveEpochMs(pid);
  const entry: BystanderLine = {
    lastSeenAliveAt: lastAlive === null ? null : new Date(lastAlive).toISOString(),
    line,
    pid,
  };
  if (lastAlive !== null && lastAlive >= graceFrom) bystanderRestartLinesExcluded.push(entry);
  else bystanderRestartLinesJudged.push(entry);
}
const bystanderLoss = losses.find(({ repo }) => repo === BYSTANDER_REPO_INDEX);
const bystander =
  bystanderLoss !== undefined &&
  bystanderLoss.archiveError === null &&
  bystanderLoss.lostCount === 0 &&
  bystanderRestartLinesJudged.length === 0;

// ---- component 7: RAM guard ---------------------------------------------
const machineRss = samples
  .map(({ machineBunRssMiB }) => machineBunRssMiB)
  .filter((value): value is number => typeof value === "number");
const peakMachineBunRssMiB = machineRss.length > 0 ? Math.max(...machineRss) : null;
const ramGuard = peakMachineBunRssMiB !== null && peakMachineBunRssMiB < RAM_GUARD_MIB;

// ---- reported, not judged: suspend gaps ---------------------------------
const suspendGaps = samples
  .filter(
    (sample) =>
      sample.intervalMs !== null && sample.intervalMs > SUSPEND_GAP_MULTIPLE * sample.nominalIntervalMs,
  )
  .map((sample) => ({
    at: new Date(sample.sampledAtEpochMs).toISOString(),
    gapMs: sample.intervalMs,
    nominalIntervalMs: sample.nominalIntervalMs,
    watcherCount: sample.watcherCount ?? null,
  }));

const overall =
  noMessageLoss && restartBudget && restartCompletion && leaseTakeover && brake && bystander && ramGuard;

console.log(
  JSON.stringify(
    {
      components: {
        brake: brake ? "PASS" : "FAIL",
        bystander: bystander ? "PASS" : "FAIL",
        leaseTakeover: leaseTakeover ? "PASS" : "FAIL",
        noMessageLoss: noMessageLoss ? "PASS" : "FAIL",
        ramGuard: ramGuard ? "WITHIN" : "BREACH",
        restartBudget: restartBudget ? "PASS" : "FAIL",
        restartCompletion: restartCompletion ? "PASS" : "FAIL",
      },
      detail: {
        brakeEye,
        brakeEyeAliveAtEnd: brakeEyeAlive,
        brakeEyeFinalPid,
        brakeKills: brakeKills.length,
        bystanderRestartLines: bystanderRestartLinesJudged.length,
        bystanderRestartLinesExcluded,
        bystanderRestartLinesJudged,
        bystanderRestartLinesSeen: bystanderRestartLinesAll.length,
        graceFromEpochMs: graceFrom,
        incompleteKills: incomplete,
        killVerdicts,
        kills: killed.length,
        leaseJudgedCount: leaseJudged.length,
        // #119 H1: restarts the sampler had no opportunity to observe. Reported
        // in full so a null is never a silent null.
        leaseUnobservable: killVerdicts.filter(
          ({ leaseTakenOver, newPid }) => newPid !== null && leaseTakenOver === null,
        ),
        losses,
        peakMachineBunRssMiB,
        restartTimeouts: [...timedOut],
        samples: samples.length,
        sampleErrors: samples.filter(({ sampleError }) => sampleError !== null).length,
        skippedKills: kills.filter((line) => line.event === "skipped" || line.event === "refused"),
        supervisorBrakes,
        supervisorRestartLines: supervisorRestarts.size,
        trafficExitAt: new Date(trafficExitAt).toISOString(),
        unattributedKills: unattributed,
      },
      overall: overall ? "PASS" : "FAIL",
      reportedNotJudged: {
        note:
          "suspendGaps is instrumentation for ticket item 3 and is excluded from the overall verdict by construction; a run in which the machine never slept has not tested sleep/wake and must not be scored as if it had.",
        suspendGapCount: suspendGaps.length,
        suspendGaps,
      },
      thresholds: {
        LEASE_TAKEOVER_MS,
        RAM_GUARD_MIB,
        SLACK_MS,
        SUSPEND_GAP_MULTIPLE,
        TAIL_GRACE_MS,
      },
    },
    null,
    2,
  ),
);
