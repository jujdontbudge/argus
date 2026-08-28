/**
 * #117's chaos monkey: SIGKILL live watchers, and measure what the supervisor
 * does about it.
 *
 * ---------------------------------------------------------------------------
 * OWNERSHIP, WHICH IS THE ONLY PART OF THIS FILE THAT CANNOT BE GOT WRONG
 * ---------------------------------------------------------------------------
 * The house rule is "never kill a process you did not spawn ... judged by
 * launchctl registration and process table, never by ppid alone". A chaos
 * ticket is the one place that rule is under real pressure, so ownership here
 * is FOUR independent checks and a candidate must pass all four:
 *
 *   1. the pid appears in THIS run's `supervisor-status.json`, against a repo
 *      that is one of THIS run's scratch repos;
 *   2. `ps -o args= -p <pid>` still resolves — the pid is alive right now;
 *   3. that command line contains this run's UNIQUE scratch path, which is an
 *      `mktemp -d` name no other process on the machine can hold;
 *   4. that command line contains `watch <eye> --repo <this run's repo>`.
 *
 * Plus one global precondition re-checked before EVERY kill: `launchctl list`
 * must report zero argus entries. If launchd has picked anything up, this run
 * is not the only owner of anything and the killer refuses to fire at all.
 *
 * ppid is deliberately NOT used, not even as a fifth check — #105's ledger
 * records wrapper shells being reaped out from under live children under load,
 * so a watcher's ppid can be 1 while it is perfectly ours.
 *
 * A candidate failing any check is recorded as `skipped` with the failing check
 * named. A skip is data, not an error: a run that skipped every kill would show
 * up as zero kills rather than as a false clean sweep.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS MEASURED, AND WHERE THE CLOCK STARTS AND STOPS
 * ---------------------------------------------------------------------------
 * `restartMs` starts the instant `process.kill(pid, "SIGKILL")` returns and
 * stops when this process first OBSERVES a watcher entry for the same
 * (repo, eye) carrying a different pid. That interval therefore includes the
 * supervisor's exit handling, its backoff sleep, its reconcile, its status
 * write, AND this file's 100 ms observation granularity. Every one of those
 * biases the measurement UPWARD. The number reported is an upper bound on the
 * true restart latency, which is the direction a budget check must err in.
 *
 * The supervisor's own stderr is the ground truth for WHICH attempt each
 * restart was (`restart N/5 in Xms`), so the analysis never has to reconstruct
 * the attempt counter from the outside and never has to assume the supervisor
 * saw the same window this file did.
 *
 * ---------------------------------------------------------------------------
 * PHASES
 * ---------------------------------------------------------------------------
 * warmup  no kills. Cold-start catchUp drains; a kill during catchUp would be
 *         measuring seeding, not chaos.
 * chaos   one kill every KILL_INTERVAL_S, target chosen by a seeded LCG over
 *         repo 0's five eyes. Seeded rather than `Math.random` so the kill
 *         sequence is reproducible from the run manifest alone.
 * brake   BRAKE_KILLS kills of ONE eye inside one restart window, to drive the
 *         documented 5-per-5-minutes limit into its braked state on a REAL
 *         fleet. runtime.test.ts proves the arithmetic with a fake process;
 *         this proves the policy survives contact with a real one.
 * settle  no kills. Everything drains before the archive is counted.
 *
 * Repo 1 is NEVER a target. It is the bystander: same supervisor, same HOME,
 * same second — chaos next door must not cost it a message or a restart.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";

const [, , scratchRoot, deadlineArgument, ownerArgument, epochArgument] = process.argv;
if (!scratchRoot || !deadlineArgument || !ownerArgument || !epochArgument) {
  throw new Error(
    "usage: killer117.ts <scratch-root> <deadline-epoch-ms> <owner-pid> <run-start-epoch-ms>",
  );
}
const root: string = scratchRoot;
const deadline = Number(deadlineArgument);
const owner = Number(ownerArgument);
const startedAt = Number(epochArgument);

const statusPath = join(root, "supervisor-status.json");
const ledgerPath = join(root, "kills.jsonl");

/**
 * Minutes from run start. The driver's manifest states the same numbers, and
 * the kill ledger's first line records whatever was actually used — so a smoke
 * run with compressed phases can never be mistaken for the registered one.
 * The env overrides exist ONLY so the harness can be exercised end to end
 * before the run it judges; the defaults are the registered schedule.
 */
function minutes(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const WARMUP_UNTIL_MIN = minutes("ARGUS_CHAOS_WARMUP_MIN", 10);
const CHAOS_UNTIL_MIN = minutes("ARGUS_CHAOS_CHAOS_UNTIL_MIN", 45);
const BRAKE_UNTIL_MIN = minutes("ARGUS_CHAOS_BRAKE_UNTIL_MIN", 55);

export const PHASES = [
  { until: WARMUP_UNTIL_MIN, name: "warmup" },
  { until: CHAOS_UNTIL_MIN, name: "chaos" },
  { until: BRAKE_UNTIL_MIN, name: "brake" },
  { until: Infinity, name: "settle" },
] as const;

export const KILL_INTERVAL_S = minutes("ARGUS_CHAOS_KILL_INTERVAL_S", 45);
export const BRAKE_EYE = "retro";
export const BRAKE_KILLS = 7;
export const BRAKE_SPACING_S = minutes("ARGUS_CHAOS_BRAKE_SPACING_S", 8);
export const TARGET_REPO = 0;
export const OBSERVE_POLL_MS = 100;
export const OBSERVE_TIMEOUT_MS = 180_000;
export const LCG_SEED = 117;

const EYES = ["reviewer", "archiver", "honcho", "digest", "retro"] as const;

function phaseAt(now: number): string {
  const minutes = (now - startedAt) / 60_000;
  for (const phase of PHASES) if (minutes < phase.until) return phase.name;
  return "settle";
}

let lcg = LCG_SEED >>> 0;
function nextEye(): string {
  lcg = (lcg * 1103515245 + 12345) >>> 0;
  return EYES[lcg % EYES.length]!;
}

function ownerAlive(): boolean {
  try {
    process.kill(owner, 0);
    return true;
  } catch {
    return false;
  }
}

function record(entry: Record<string, unknown>): void {
  appendFileSync(ledgerPath, `${JSON.stringify(entry)}\n`);
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

async function commandLine(pid: number): Promise<string | null> {
  const child = Bun.spawn(["ps", "-o", "args=", "-p", String(pid)], {
    stderr: "ignore",
    stdout: "pipe",
  });
  const text = (await new Response(child.stdout).text()).trim();
  await child.exited;
  return text.length === 0 ? null : text;
}

/** Global precondition (R5): launchd must own nothing named argus. */
async function launchdArgusEntries(): Promise<number> {
  const child = Bun.spawn(["/bin/launchctl", "list"], { stderr: "ignore", stdout: "pipe" });
  const text = await new Response(child.stdout).text();
  await child.exited;
  return text.split("\n").filter((line) => /argus/i.test(line)).length;
}

interface Ownership {
  checks: Record<string, boolean>;
  commandLine: string | null;
  owned: boolean;
}

async function verifyOwnership(
  watcher: StatusWatcher,
  repoPaths: readonly string[],
): Promise<Ownership> {
  const args = await commandLine(watcher.pid);
  const checks = {
    inThisRunsStatus: repoPaths.includes(watcher.repo),
    aliveInProcessTable: args !== null,
    commandLineHasScratchPath: args !== null && args.includes(root),
    commandLineHasWatchAndRepo:
      args !== null &&
      args.includes(`watch ${watcher.eye}`) &&
      args.includes(`--repo ${watcher.repo}`),
  };
  return {
    checks,
    commandLine: args,
    owned: Object.values(checks).every(Boolean),
  };
}

/** Wait for a DIFFERENT pid to hold (repo, eye). Returns null on timeout. */
async function observeRestart(
  repo: string,
  eye: string,
  deadPid: number,
): Promise<{ atMs: number; pid: number } | null> {
  const started = Date.now();
  while (Date.now() - started < OBSERVE_TIMEOUT_MS) {
    if (!ownerAlive()) return null;
    for (const watcher of await readStatus()) {
      if (watcher.repo === repo && watcher.eye === eye && watcher.pid !== deadPid) {
        return { atMs: Date.now() - started, pid: watcher.pid };
      }
    }
    await Bun.sleep(OBSERVE_POLL_MS);
  }
  return null;
}

const repoPaths: string[] = [];
for (let index = 0; index < 8; index += 1) {
  const candidate = join(root, `repo-${index}`);
  if (await Bun.file(join(candidate, ".argus", "config.yaml")).exists()) {
    repoPaths.push(await Bun.$`cd ${candidate} && pwd -P`.text().then((t) => t.trim()));
  }
}
const resolvedTarget = repoPaths[TARGET_REPO];
if (resolvedTarget === undefined) throw new Error(`no repo-${TARGET_REPO} under ${root}`);
// Re-bound as a plainly-typed const: `attemptKill` is a hoisted declaration, so
// TypeScript will not carry the narrowing above into its body.
const targetRepo: string = resolvedTarget;

record({
  at: Date.now(),
  brakeEye: BRAKE_EYE,
  brakeKills: BRAKE_KILLS,
  event: "killer-start",
  killIntervalSeconds: KILL_INTERVAL_S,
  lcgSeed: LCG_SEED,
  phases: PHASES.map(({ name, until }) => ({ name, untilMinute: until })),
  repoPaths,
  targetRepo,
});

let killIndex = 0;
let brakeFired = 0;

async function attemptKill(eye: string, reason: string): Promise<void> {
  const launchd = await launchdArgusEntries();
  if (launchd !== 0) {
    record({ at: Date.now(), event: "refused", launchdArgusEntries: launchd, reason: "launchd-owns-argus" });
    return;
  }
  const watchers = await readStatus();
  const candidate = watchers.find((w) => w.repo === targetRepo && w.eye === eye);
  if (candidate === undefined) {
    record({ at: Date.now(), event: "skipped", eye, reason: "no-such-watcher-in-status" });
    return;
  }
  const ownership = await verifyOwnership(candidate, repoPaths);
  if (!ownership.owned) {
    record({
      at: Date.now(),
      checks: ownership.checks,
      commandLine: ownership.commandLine,
      event: "skipped",
      eye,
      pid: candidate.pid,
      reason: "ownership-unproven",
    });
    return;
  }

  killIndex += 1;
  const index = killIndex;
  const killedAt = Date.now();
  process.kill(candidate.pid, "SIGKILL");
  record({
    at: killedAt,
    checks: ownership.checks,
    commandLine: ownership.commandLine,
    event: "killed",
    eye,
    index,
    phase: phaseAt(killedAt),
    pid: candidate.pid,
    reason,
    repo: targetRepo,
    signal: "SIGKILL",
  });

  const restart = await observeRestart(targetRepo, eye, candidate.pid);
  record(
    restart === null
      ? {
          at: Date.now(),
          event: "restart-timeout",
          eye,
          index,
          killedPid: candidate.pid,
          timeoutMs: OBSERVE_TIMEOUT_MS,
        }
      : {
          at: Date.now(),
          event: "restarted",
          eye,
          index,
          killedPid: candidate.pid,
          newPid: restart.pid,
          restartMs: restart.atMs,
        },
  );
}

while (Date.now() < deadline && ownerAlive()) {
  const phase = phaseAt(Date.now());
  if (phase === "chaos") {
    await attemptKill(nextEye(), "scheduled-random");
    await Bun.sleep(KILL_INTERVAL_S * 1_000);
    continue;
  }
  if (phase === "brake" && brakeFired < BRAKE_KILLS) {
    brakeFired += 1;
    await attemptKill(BRAKE_EYE, `brake-${brakeFired}/${BRAKE_KILLS}`);
    await Bun.sleep(BRAKE_SPACING_S * 1_000);
    continue;
  }
  await Bun.sleep(1_000);
}
record({ at: Date.now(), event: "killer-stop", kills: killIndex });
