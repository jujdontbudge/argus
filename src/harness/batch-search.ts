/**
 * Ticket #92 — SPEC §14's second and fourth acceptance bullets, driven live.
 *
 * THE TWO BULLETS, IN JOHAN'S OWN WORDS. Quoted from `SPEC.md`, not from the
 * ticket, because #89 caught the ticket citing §14 at the wrong lines and
 * paraphrasing bullet 2 in a way that changed what it claims:
 *
 *   SPEC.md:768-769
 *   > A 10-ticket batch executes 3-at-a-time in worktrees, every ticket a
 *   > fresh attachable cmux session, and USER.md gains **nothing** unless
 *   > Johan actually typed.
 *
 *   SPEC.md:791
 *   > `argus search` answers "how did we solve X" from any past session of
 *   > any agent.
 *
 * The ticket renders bullet 2's tail as "USER.md gains nothing BECAUSE Johan
 * typed nothing". That is a different, weaker claim: the SPEC guarantees a
 * GATE (nothing but Johan's own typing may write USER.md), while the ticket's
 * wording only observes an absence of input. This module asserts the bytes,
 * which is the strongest thing a run with no human in it can say about either
 * reading, and the shortfall is stated rather than papered over.
 *
 * WHAT HAD NEVER BEEN RUN. Scenario 1 is one synthesized fixture session and
 * `src/search/search.test.ts` queries a fixture DB built in-process. So
 * "several real agents at once" and "retrieval across them" had no coverage.
 * `ARGUS_LIVE_FULL_JOURNEY` (#83) does not close it: it drives at most two
 * agents through `SimulationDriverRunner` and never touches `dispatchFrontier`
 * or the slot cap. The cap has never had three real sessions to hold back.
 *
 * WHAT IS PRODUCTION HERE, AND WHAT IS NOT. The dispatcher is
 * `dispatchFrontier` — the exact function `argus dispatch` calls. The slot
 * allocator is `createDispatchSlots`, the registry writer is `deployWorker`,
 * the routes are `ROUTES`, the spawn primitive is `spawnWorker`, the watchers
 * are the real eye processes under the real `WatcherSupervisor`, and the
 * search is the `argus search` CLI in its own process. Three doubles, each
 * named and each forced:
 *
 *   1. `gh` — `createFakeGh`. SPEC §13 forbids a test run writing to a
 *      tracker, and the frontier IS a tracker read. The ticket asks for "a
 *      fake frontier of five tickets" for this reason.
 *   2. `HOME` for the Claude leg — `spawnWorker` is handed the real home for
 *      claude only, because a scratch `CLAUDE_CONFIG_DIR` has no credentials
 *      by construction and SPEC §1 item 7 forbids minting one. This is
 *      `createSubscriptionAgentSpawner`'s rule applied at the `WorkerSpawn`
 *      seam: the same strip list, the same `SandboxScope` cwd check, and the
 *      production primitive still doing the spawning.
 *   3. cmux — absent, not faked. `createSandbox` strips `CMUX_*`, so
 *      `openWorkerTab` refuses at its first check and NO cmux verb runs. That
 *      leaves bullet 2's "fresh attachable cmux session" clause UNCOVERED and
 *      it is reported as such. It is a deliberate refusal: the tab is
 *      cosmetic to every assertion below, and closing five surfaces through
 *      `close-surface` is the verb behind open incident #98.
 *
 * WHY EACH PASS-1 WORKTREE IS DIRTIED, and why the ticket's stated design
 * cannot work without it. `recoverDeadSlots` grades a dead session by what it
 * left behind. A session that produced "one bounded scripted reply and
 * nothing else" — the ticket's own words — leaves a CLEAN worktree and no
 * commits, which production grades `returned-to-frontier`: the claim is
 * released, the worktree and branch are DELETED, and the ticket goes back on
 * the frontier. The next pass would then re-dispatch tickets 1-3 and tickets
 * 4 and 5 would never run, so the refill the ticket asks for could not have
 * happened as specified. Worse, deleting the worktree makes
 * `repositoryFor()` unable to resolve the session's repo, so production's own
 * repo-scoped source would drop every pass-1 transcript and the archive
 * assertions would fail for a reason that has nothing to do with the archiver.
 *
 * So after each pass-1 session exits, the harness writes one file into its
 * worktree. That is a stand-in for "the session left uncommitted work", it is
 * the minimum that makes production grade the slot `uncommitted-work` (claim
 * stands, worktree preserved, slot released), and it is named here rather
 * than hidden. Everything downstream of it — the release, the refill, the
 * archive, the search — is production's.
 *
 * SPEC §1 items 7 and 8. Subscription on both vendors. No API key, no token,
 * no metered access. The Codex leg gets the one copy of `auth.json` §13
 * permits, into a scratch `CODEX_HOME` inside the sandbox.
 *
 * ITS OWN GATE. `ARGUS_LIVE_BATCH_SEARCH` and nothing else. This buys FIVE
 * subscription sessions, three of them concurrent, plus five watcher
 * processes — more than any other gate in the tree — so rolling it into one
 * of them would be how a gate stops being an opt-in.
 */
import { existsSync } from "node:fs";
import { copyFile, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";

import { dispatchFrontier, type DispatchReport } from "../dispatch/index.ts";
import { dispatchSlotsDirectory } from "../dispatch/slots.ts";
import { spawnWorker, type WorkerProcess, type WorkerSpawn } from "../deploy/index.ts";
import { createFakeGh, type FakeGh } from "../eyes/retro/fake-gh.ts";
import { createRepoTranscriptSource } from "../eyes/source.ts";
import { claudeProjectDir } from "../tailing/claude-code.ts";
import { Tailer, type MessageEvent } from "../tailing/index.ts";
import { EYE_NAMES, WatcherSupervisor, type SupervisorStatus } from "../supervisor/runtime.ts";
import {
  createSandbox,
  createSandboxWatcherSpawner,
  LIVE_WATCHER_FLEET_LOCK_PATH,
  type Sandbox,
} from "./index.ts";
import {
  CODEX_AUTH_FILE,
  LIVE_HALF_BANNER,
  type LiveHalfOutcome,
  type LiveHalfStatus,
} from "./live-gate.ts";
import { NATIVE_CLAUDE } from "./subscription-gate.ts";

export const BATCH_SEARCH_GATE = "ARGUS_LIVE_BATCH_SEARCH";

/** The tracker the fake frontier lives on. Never resolved against the network. */
const TRACKER = "JohanSardar/argus-batch-fixture";
const LOGIN = "argus-batch-dispatcher";

/**
 * SPEC §14's two bullets, byte-for-byte from `SPEC.md`, so the evidence file
 * and the assertions quote one source and a SPEC edit breaks the test rather
 * than silently ageing the quotation.
 */
export const SPEC_SECTION_14_HEADING = "## 14. It's working if";
export const SPEC_BULLET_2 =
  "- A 10-ticket batch executes 3-at-a-time in worktrees, every ticket a fresh attachable\n" +
  "  cmux session, and USER.md gains **nothing** unless Johan actually typed.";
export const SPEC_BULLET_4 =
  '- `argus search` answers "how did we solve X" from any past session of any agent.';

/**
 * One batch ticket.
 *
 * `token` is the distinctive string §14 bullet 4 is retrieved by. It is
 * deliberately spelled in TWO HALVES in the dispatch prompt and joined by the
 * agent, for #63's reason: if the prompt contained the token whole, the same
 * `argus search` query would match the ARCHIVED DISPATCH PROMPT and the bullet
 * would appear to pass while proving only that the pipeline carried the
 * harness's own echo back to it.
 */
export interface BatchTicket {
  number: string;
  title: string;
  body: string;
  agent: "claude" | "codex";
  /** The whole token the agent is asked to assemble and say. */
  token: string;
  /** The two halves the prompt spells, joined by a single hyphen. */
  halves: [string, string];
}

/**
 * Five, not ten, and the shortfall is stated rather than left to look like
 * ten. Three-at-a-time against a cap of three is what bullet 2 tests; tickets
 * four and five prove the cap released and refilled. Ten would cost seven more
 * subscription sessions to assert nothing new.
 *
 * The agents alternate so that bullet 4's "any past session of ANY AGENT" is
 * a cross-agent retrieval and not two lookups into one CLI's transcripts. In
 * particular tickets 1 and 2 — both in the FIRST, three-at-a-time pass — are
 * different agents, so the cross-agent search crosses the concurrent batch
 * rather than the serialized tail of it.
 */
export const BATCH_TICKETS: readonly BatchTicket[] = [
  {
    agent: "codex",
    body: "Answer with the assembled token and nothing else. Do not run commands, do not write files.",
    halves: ["ARGUSBATCH", "QUINDAR"],
    number: "501",
    title: "batch slot one",
    token: "ARGUSBATCH-QUINDAR",
  },
  {
    agent: "claude",
    body: "Answer with the assembled token and nothing else. Do not run commands, do not write files.",
    halves: ["ARGUSBATCH", "TRANSOM"],
    number: "502",
    title: "batch slot two",
    token: "ARGUSBATCH-TRANSOM",
  },
  {
    agent: "codex",
    body: "Answer with the assembled token and nothing else. Do not run commands, do not write files.",
    halves: ["ARGUSBATCH", "VERGLAS"],
    number: "503",
    title: "batch slot three",
    token: "ARGUSBATCH-VERGLAS",
  },
  {
    agent: "claude",
    body: "Answer with the assembled token and nothing else. Do not run commands, do not write files.",
    halves: ["ARGUSBATCH", "WICKIUP"],
    number: "504",
    title: "batch slot four",
    token: "ARGUSBATCH-WICKIUP",
  },
  {
    agent: "codex",
    body: "Answer with the assembled token and nothing else. Do not run commands, do not write files.",
    halves: ["ARGUSBATCH", "XENOLITH"],
    number: "505",
    title: "batch slot five",
    token: "ARGUSBATCH-XENOLITH",
  },
];

const ticketByNumber = (number: string): BatchTicket | undefined =>
  BATCH_TICKETS.find((ticket) => ticket.number === number);

/** The dispatch prompt. Spells the token in halves; see `BatchTicket.token`. */
export function batchDispatchPrompt(ticket: BatchTicket, tracker: string): string {
  return [
    `You are an Argus worker on ticket #${ticket.number} of ${tracker}: ${ticket.title}`,
    "",
    "The ticket states:",
    "",
    ticket.body,
    "",
    `Reply with exactly the two fragments "${ticket.halves[0]}" and "${ticket.halves[1]}"`,
    "joined by a single hyphen, and nothing else. Do not run any commands, do not",
    "write any files, do not commit, and do not close the ticket — the dispatcher",
    "owns ticket state.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------

export interface BatchSearchProbe {
  claudeInstalled: boolean;
  nativeClaudeInstalled: boolean;
  codexInstalled: boolean;
  codexAuthPresent: boolean;
  env: Readonly<Record<string, string | undefined>>;
}

export interface BatchSearchGate {
  enabled: boolean;
  claude: LiveHalfOutcome;
  codex: LiveHalfOutcome;
  /** The batch runs only when BOTH legs can: bullet 4 is a cross-agent claim. */
  overall: LiveHalfOutcome;
}

const GATE_SHUT =
  `${BATCH_SEARCH_GATE} is unset — the default gate never burns five subscription sessions`;

export function probeBatchSearch(): BatchSearchProbe {
  return {
    claudeInstalled: Bun.which("claude") !== null,
    // Existence only. The file holds a credential and is never opened here.
    codexAuthPresent: existsSync(CODEX_AUTH_FILE),
    codexInstalled: Bun.which("codex") !== null,
    env: { ...Bun.env },
    nativeClaudeInstalled: existsSync(NATIVE_CLAUDE),
  };
}

export function resolveBatchSearchGate(probe: BatchSearchProbe): BatchSearchGate {
  const enabled = probe.env[BATCH_SEARCH_GATE] === "1";
  const half = (missing: string | null, ready: string): LiveHalfOutcome => {
    if (!enabled) return { reason: GATE_SHUT, status: "gate-unset" };
    if (missing !== null) return { reason: missing, status: "not-run" };
    return { reason: ready, status: "run" };
  };

  const claude = half(
    probe.nativeClaudeInstalled
      ? null
      : `the native claude CLI is not at ${NATIVE_CLAUDE}`,
    "subscription mode: real HOME, sandbox cwd, no token (SPEC §1 item 7)",
  );
  const codex = half(
    !probe.codexInstalled
      ? "the codex CLI is not on PATH"
      : !probe.codexAuthPresent
        ? "~/.codex/auth.json is not present"
        : null,
    "subscription mode: scratch CODEX_HOME holding the one permitted copy of auth.json",
  );

  // A one-agent batch cannot answer bullet 4, which is explicitly "any past
  // session of ANY AGENT". So the batch does not run half-crippled and grade
  // itself on the half it managed; it reports NOT RUN and says which leg.
  const overall: LiveHalfOutcome =
    claude.status === "run" && codex.status === "run"
      ? {
          reason: "both legs are runnable — bullet 4's cross-agent retrieval is reachable",
          status: "run",
        }
      : claude.status === "gate-unset"
        ? { reason: GATE_SHUT, status: "gate-unset" }
        : {
            reason:
              `bullet 4 needs BOTH agents; claude=${claude.status} (${claude.reason}), ` +
              `codex=${codex.status} (${codex.reason})`,
            status: "not-run",
          };

  return { claude, codex, enabled, overall };
}

export function describeBatchSearchGate(gate: BatchSearchGate): string {
  if (!gate.enabled) {
    return (
      `argus: SPEC §14 bullet 2+4 live batch SKIPPED — set ${BATCH_SEARCH_GATE}=1 to run it; ` +
      "it burns FIVE subscription sessions, three concurrent, plus five watchers"
    );
  }
  const line = (name: string, verdict: LiveHalfOutcome): string =>
    `  ${name.padEnd(7)}  ${LIVE_HALF_BANNER[verdict.status]}  ${verdict.reason}`;
  return [
    `${BATCH_SEARCH_GATE}=1 — the live batch is ENABLED (five subscription sessions)`,
    line("claude", gate.claude),
    line("codex", gate.codex),
    line("batch", gate.overall),
  ].join("\n");
}

export function batchSearchTitle(base: string, verdict: LiveHalfOutcome): string {
  const banner: Readonly<Record<LiveHalfStatus, string>> = {
    "gate-unset": "SKIPPED",
    "not-run": "NOT RUN",
    run: "",
  };
  return verdict.status === "run" ? base : `${base} — ${banner[verdict.status]}: ${verdict.reason}`;
}

// ---------------------------------------------------------------------------
// The observed slot timeline
// ---------------------------------------------------------------------------

/**
 * One (slot file, occupant) pair, as the FILE described itself.
 *
 * `acquiredAt` and `ticket` and `pid` are read out of the slot file's own
 * JSON; `birthtime` is the filesystem's. The only fields the harness
 * contributes are the two observation stamps, and they are named as such so a
 * reader is never asked to take a timeline built from a counter the test kept
 * — which is the thing #92 explicitly forbids.
 */
export interface SlotOccupancy {
  slot: string;
  ticket: string;
  /** From the slot file's own `acquiredAt` field. */
  acquiredAt: string;
  /** From the filesystem's own record of the file. */
  birthtime: string;
  /** The last `state` the file carried before it vanished. */
  state: string;
  /** The last `pid` the file carried — the WORKER's, once deployed. */
  pid: number;
  sessionId?: string;
  worktree?: string;
  agent?: string;
  /** Harness observation, labelled: when the poller first/last saw the file. */
  firstObserved: string;
  lastObserved: string;
  /** Harness observation, labelled: when the poller first saw it gone. */
  vanishedObserved?: string;
}

export interface SlotTimeline {
  occupancies: SlotOccupancy[];
  /**
   * The largest number of DISTINCT slot files the poller ever saw at once.
   * A ceiling observation, not the cap's proof — the cap's proof is that only
   * `maxConcurrency` slot paths exist and each is created with an exclusive
   * `wx` open, so a fourth concurrent holder has nowhere to go.
   */
  peakConcurrentFiles: number;
  samples: number;
}

interface SlotPoller {
  stop(): Promise<SlotTimeline>;
}

function startSlotPoller(directory: string, intervalMs = 40): SlotPoller {
  const seen = new Map<string, SlotOccupancy>();
  let peak = 0;
  let samples = 0;
  let running = true;

  const key = (slot: string, acquiredAt: string, ticket: string): string =>
    `${slot}|${acquiredAt}|${ticket}`;

  const loop = (async (): Promise<void> => {
    while (running) {
      const now = new Date().toISOString();
      let names: string[] = [];
      try {
        names = (await readdir(directory)).filter((name) => name.startsWith("slot-"));
      } catch {
        names = [];
      }
      samples += 1;
      const live = new Set<string>();
      for (const name of names) {
        const path = join(directory, name);
        let raw: string;
        let born: string;
        try {
          raw = await readFile(path, "utf8");
          born = (await stat(path)).birthtime.toISOString();
        } catch {
          continue; // released between the listing and the read
        }
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(raw) as Record<string, unknown>;
        } catch {
          continue; // mid-write; the next sample sees it whole
        }
        const acquiredAt = typeof record.acquiredAt === "string" ? record.acquiredAt : "";
        const ticket = typeof record.ticket === "string" ? record.ticket : "";
        const id = key(name, acquiredAt, ticket);
        live.add(id);
        const existing = seen.get(id);
        const shared = {
          acquiredAt,
          birthtime: born,
          lastObserved: now,
          pid: typeof record.pid === "number" ? record.pid : -1,
          slot: name,
          state: typeof record.state === "string" ? record.state : "",
          ticket,
          ...(typeof record.agent === "string" && { agent: record.agent }),
          ...(typeof record.sessionId === "string" && { sessionId: record.sessionId }),
          ...(typeof record.worktree === "string" && { worktree: record.worktree }),
        };
        seen.set(id, { ...(existing ?? { firstObserved: now }), ...shared });
      }
      if (live.size > peak) peak = live.size;
      for (const [id, occupancy] of seen) {
        if (!live.has(id) && occupancy.vanishedObserved === undefined) {
          seen.set(id, { ...occupancy, vanishedObserved: now });
        }
      }
      await Bun.sleep(intervalMs);
    }
  })();

  return {
    async stop() {
      running = false;
      await loop;
      return {
        occupancies: [...seen.values()].sort((a, b) =>
          a.acquiredAt === b.acquiredAt
            ? a.slot.localeCompare(b.slot)
            : a.acquiredAt.localeCompare(b.acquiredAt),
        ),
        peakConcurrentFiles: peak,
        samples,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// The spawn seam
// ---------------------------------------------------------------------------

/** What a single worker process did, from the seam that started it. */
export interface WorkerWitness {
  ticket: string;
  agent: string;
  cwd: string;
  pid?: number;
  argv: readonly string[];
  /** Real wall-clock, so concurrency is visible from the PROCESSES too. */
  startedAt: string;
  exitedAt?: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  /** `HOME` the child was actually handed — #89's cwd/home regression check. */
  home: string;
  claudeConfigDir?: string;
  codexHome?: string;
}

/**
 * The batch's `WorkerSpawn`.
 *
 * It is a WRAPPER, never a replacement: `spawnWorker` — production's own
 * primitive, with its own stdout scanner and its own announcement contract —
 * does the spawning in every branch. The wrapper does exactly two things, and
 * both are forced by SPEC §1 item 7:
 *
 *   - for `claude`, it applies `createSubscriptionAgentSpawner`'s rule at this
 *     seam: strip `CLAUDE_CONFIG_DIR` and the three credential variables, set
 *     `HOME` to the real home explicitly, and refuse any cwd the sandbox scope
 *     does not own. A scratch config has no credentials by construction and
 *     this machine may never mint a token, so there is no other route.
 *   - it records, per worker, what was handed to the process and what came
 *     back — including the wall-clock the process ran between, which is the
 *     concurrency evidence that does NOT come from the slot files.
 */
function batchSpawn(
  sandbox: Sandbox,
  witnesses: WorkerWitness[],
  processes: WorkerProcess[],
): WorkerSpawn {
  return async (request) => {
    const env: Record<string, string> = { ...request.env };
    if (request.agent === "claude") {
      // The safety property, by name and before anything is started.
      await sandbox.scope.resolved(request.cwd, "batch subscription spawn cwd");
      delete env.CLAUDE_CONFIG_DIR;
      delete env.ANTHROPIC_API_KEY;
      delete env.ANTHROPIC_AUTH_TOKEN;
      delete env.CLAUDE_CODE_OAUTH_TOKEN;
      env.HOME = homedir();
    }
    const executable =
      request.agent === "claude" ? NATIVE_CLAUDE : request.executable;
    const witness: WorkerWitness = {
      agent: request.agent,
      argv: [executable, ...request.command.slice(1)],
      cwd: request.cwd,
      home: env.HOME ?? "(unset)",
      startedAt: new Date().toISOString(),
      ticket: "(unknown)",
      ...(env.CLAUDE_CONFIG_DIR !== undefined && { claudeConfigDir: env.CLAUDE_CONFIG_DIR }),
      ...(env.CODEX_HOME !== undefined && { codexHome: env.CODEX_HOME }),
    };
    witnesses.push(witness);

    const process = await spawnWorker({ ...request, env, executable });
    if (process.pid !== undefined) {
      witness.pid = process.pid;
      sandbox.scope.adopt(process.pid);
    }
    processes.push(process);
    void process.exited.then((exit) => {
      witness.exitCode = exit.exitCode;
      witness.exitedAt = new Date().toISOString();
      witness.stdout = exit.stdout;
      witness.stderr = exit.stderr;
    });
    return process;
  };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface BatchPass {
  label: string;
  report: DispatchReport;
}

export interface ArchivedMessage {
  sessionId: string;
  agent: string | null;
  role: string;
  provenance: string;
  via: string;
  ticket: string | null;
  ts: string;
  content: string;
}

export interface SearchInvocation {
  query: string;
  argv: readonly string[];
  cwd: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface BatchSearchReport {
  sandboxRoot: string;
  repo: string;
  upExitCode: number;
  passes: BatchPass[];
  timeline: SlotTimeline;
  workers: WorkerWitness[];
  /** ticket -> what the dispatcher recorded for it, across all passes. */
  dispatched: Array<{
    ticket: string;
    agent: string;
    sessionId: string;
    worktree: string;
    branch: string;
    workspaceDegraded?: string;
  }>;
  userMdBefore: string;
  userMdAfter: string;
  userMdPath: string;
  relocatedTranscripts: number;
  visibleSessions: string[];
  watcherStatus: SupervisorStatus | null;
  archived: ArchivedMessage[];
  searches: SearchInvocation[];
  /** Everything the run observed that a reader must not have to re-derive. */
  notes: string[];
  /** Peak resident set of the whole live fleet, in MB, sampled through the run. */
  peakFleetRssMb: number;
  fleetSamples: Array<{ at: string; processes: number; rssMb: number }>;
}

const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
}

/** Every live `bun ... watch` / agent process this run owns, and its RSS. */
async function sampleFleet(): Promise<{ processes: number; rssMb: number }> {
  const ps = Bun.spawn(["ps", "-Ao", "rss=,command="], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(ps.stdout).text();
  await ps.exited;
  let rss = 0;
  let count = 0;
  for (const line of text.split("\n")) {
    if (!/cli\.ts watch|\bcodex\b exec|\.local\/share\/claude\/versions/.test(line)) continue;
    const match = /^\s*(\d+)\s/.exec(line);
    if (match?.[1] === undefined) continue;
    rss += Number(match[1]);
    count += 1;
  }
  return { processes: count, rssMb: Math.round((rss / 1024) * 10) / 10 };
}

export interface RunBatchSearchOptions {
  /** The checkout `argus up` and the watchers run out of. */
  checkout: string;
  /** Wall-clock ceiling for one pass's sessions, in ms. */
  sessionTimeoutMs?: number;
  notes?: string[];
}

export async function runBatchAndSearch(
  options: RunBatchSearchOptions,
): Promise<{ report: BatchSearchReport; sandbox: Sandbox }> {
  const notes: string[] = options.notes ?? [];
  const sandbox = await createSandbox({ checkout: options.checkout });
  const repo = await realpath(sandbox.repo);
  const sessionTimeoutMs = options.sessionTimeoutMs ?? 600_000;

  // The one production touchpoint SPEC §13 permits: a COPY of auth.json into
  // a scratch CODEX_HOME inside the sandbox, which teardown removes.
  const codexHome = sandbox.env.CODEX_HOME!;
  await mkdir(codexHome, { recursive: true });
  await copyFile(CODEX_AUTH_FILE, join(codexHome, "auth.json"));

  const userMdPath = join(repo, ".argus", "memory", "USER.md");
  const userMdBefore = await Bun.file(userMdPath).text();

  const gh: FakeGh = createFakeGh({ login: LOGIN, repo: TRACKER });
  for (const ticket of BATCH_TICKETS) {
    gh.seed({
      body: ticket.body,
      labels: [`agent:${ticket.agent === "claude" ? "claude-code" : "codex"}`],
      number: Number(ticket.number),
      title: ticket.title,
    });
  }

  const witnesses: WorkerWitness[] = [];
  const processes: WorkerProcess[] = [];
  const spawn = batchSpawn(sandbox, witnesses, processes);
  const poller = startSlotPoller(dispatchSlotsDirectory(repo));
  const fleetSamples: Array<{ at: string; processes: number; rssMb: number }> = [];
  let peakFleetRssMb = 0;
  let sampling = true;
  const fleetLoop = (async (): Promise<void> => {
    while (sampling) {
      const sample = await sampleFleet();
      if (sample.processes > 0) {
        fleetSamples.push({ at: new Date().toISOString(), ...sample });
        if (sample.rssMb > peakFleetRssMb) peakFleetRssMb = sample.rssMb;
      }
      await Bun.sleep(1000);
    }
  })();

  const passes: BatchPass[] = [];
  const dispatched: BatchSearchReport["dispatched"] = [];

  const dispatchOnce = async (label: string): Promise<DispatchReport> => {
    const report = await dispatchFrontier({
      dispatchPrompt: (ticket, tracker) => {
        const known = ticketByNumber(ticket.number);
        if (known === undefined) {
          throw new Error(`the batch dispatched an unknown ticket #${ticket.number}`);
        }
        return batchDispatchPrompt(known, tracker);
      },
      env: sandbox.env,
      gh: gh.run,
      maxConcurrency: 3,
      repo,
      spawn,
      // "auto" is what `argus dispatch` passes. `createSandbox` strips CMUX_*,
      // so `openWorkerTab` refuses at its first check and no cmux verb runs —
      // the degradation is recorded rather than engineered away.
      workspace: "auto",
    });
    passes.push({ label, report });
    for (const entry of report.dispatched) {
      dispatched.push({
        agent: entry.agent,
        branch: entry.branch,
        sessionId: entry.sessionId,
        ticket: entry.ticket,
        worktree: entry.worktree,
        ...(entry.workspaceDegraded !== undefined && {
          workspaceDegraded: entry.workspaceDegraded,
        }),
      });
    }
    return report;
  };

  /** Wait for every worker started so far to exit; never kills a live one. */
  const drain = async (label: string): Promise<void> => {
    const deadline = Date.now() + sessionTimeoutMs;
    const pending = [...processes];
    const results = await Promise.race([
      Promise.all(pending.map((process) => process.exited)),
      (async () => {
        while (Date.now() < deadline) await Bun.sleep(500);
        return null;
      })(),
    ]);
    if (results === null) {
      notes.push(
        `${label}: TIMED OUT after ${sessionTimeoutMs}ms waiting for ${pending.length} ` +
          "worker session(s) to exit; the run continues and the assertions below say what happened",
      );
    }
  };

  try {
    // ---- pass 1: five tickets on the frontier, a cap of three -------------
    const first = await dispatchOnce("pass 1");
    await drain("pass 1");

    // Every pass-1 worktree is dirtied here, and ONLY here. See the module
    // docblock: without it production grades these slots
    // `returned-to-frontier`, deletes the worktrees, puts tickets 1-3 back on
    // the frontier and tickets 4 and 5 never run.
    for (const entry of first.dispatched) {
      const marker = join(entry.worktree, "WORK-IN-PROGRESS.txt");
      await writeFile(
        marker,
        `harness stand-in for uncommitted work left by ticket #${entry.ticket}\n`,
      );
      notes.push(
        `pass 1: harness wrote ${marker} so production grades this slot ` +
          "`uncommitted-work` (claim stands, worktree preserved) rather than " +
          "`returned-to-frontier` (claim released, worktree and branch deleted)",
      );
    }

    // Claude's transcripts land under the REAL ~/.claude/projects/ because
    // subscription mode is a normal terminal session. Copy them into the
    // sandbox's own projects root BEFORE the next pass, so nothing depends on
    // a worktree surviving recovery. A read of the real home, never a write.
    let relocated = await relocateClaudeTranscripts(sandbox, first.dispatched);

    // ---- pass 2: the cap released, and refilled onto 4 and 5 -------------
    await dispatchOnce("pass 2");
    await drain("pass 2");
    relocated += await relocateClaudeTranscripts(
      sandbox,
      passes[1]?.report.dispatched ?? [],
    );

    // ---- what production's own repo-scoped source can see ----------------
    const visible = await new Tailer(
      await createRepoTranscriptSource(repo, sandbox.env),
    ).catchUp();
    const visibleSessions = [
      ...new Set(
        visible
          .filter((event): event is MessageEvent => event.type === "message")
          .map((event) => event.sessionId),
      ),
    ];

    // ---- production's own watchers, over the batch ------------------------
    const watcherStatus = await runRealWatchers(sandbox, repo, dispatched.length * 2);

    const archived = readArchive(join(repo, ".argus", "archive.db"));
    const userMdAfter = await Bun.file(userMdPath).text();

    // ---- SPEC §14 bullet 4: the CLI, in its own process -------------------
    const searches: SearchInvocation[] = [];
    for (const number of ["501", "502"]) {
      const ticket = ticketByNumber(number)!;
      searches.push(await runSearchCli(sandbox, repo, ticket.token));
    }

    notes.push(`USER.md sha256 before=${await hashOf(userMdBefore)} after=${await hashOf(userMdAfter)}`);

    return {
      report: {
        archived,
        dispatched,
        fleetSamples,
        notes,
        passes,
        peakFleetRssMb,
        relocatedTranscripts: relocated,
        repo,
        sandboxRoot: sandbox.root,
        searches,
        timeline: await poller.stop(),
        upExitCode: sandbox.up.exitCode,
        userMdAfter,
        userMdBefore,
        userMdPath,
        visibleSessions,
        watcherStatus,
        workers: witnesses,
      },
      sandbox,
    };
  } finally {
    sampling = false;
    await fleetLoop;
    await poller.stop().catch(() => undefined);
  }
}

async function hashOf(text: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(text);
  return hasher.digest("hex");
}

/**
 * Copy the live Claude transcripts out of the real home and into the
 * sandbox's projects root, keyed by the worktree each session ran in.
 *
 * This is also #89's check, made structurally: the slug is derived from the
 * DEPLOYMENT'S OWN worktree path, so a session that had run in Johan's real
 * `~/argus` — the regression #89 fixed on the grill path — would produce zero
 * files here and the assertion downstream would fail rather than pass quietly.
 */
async function relocateClaudeTranscripts(
  sandbox: Pick<Sandbox, "env">,
  entries: ReadonlyArray<{ agent: string; worktree: string }>,
): Promise<number> {
  const realProjects = join(homedir(), ".claude/projects");
  const sandboxProjects = join(sandbox.env.CLAUDE_CONFIG_DIR!, "projects");
  let copied = 0;
  for (const entry of entries) {
    if (entry.agent !== "claude") continue;
    let resolved: string;
    try {
      resolved = await realpath(entry.worktree);
    } catch {
      continue;
    }
    const source = claudeProjectDir(resolved, realProjects);
    const target = claudeProjectDir(resolved, sandboxProjects);
    let files: string[];
    try {
      files = (await readdir(source)).filter((name) => name.endsWith(".jsonl"));
    } catch {
      continue;
    }
    if (files.length === 0) continue;
    await mkdir(target, { recursive: true });
    for (const name of files) {
      await copyFile(join(source, name), join(target, name));
      copied += 1;
    }
  }
  return copied;
}

/**
 * The five real eye watchers, over the batch's archive.
 *
 * Every pid is adopted through `SandboxScope` in the same read that discovers
 * it — the production dispatcher supervises the real `~/argus` on this same
 * machine, and #49's rule is that no pid this harness did not spawn is ever
 * signalled. This function starts and stops the fleet; it does not kill an
 * eye mid-run (that is #63's slot-6 business, and repeating it here would buy
 * nothing this ticket claims).
 */
async function runRealWatchers(
  sandbox: Pick<Sandbox, "env" | "root" | "scope">,
  repo: string,
  expected: number,
): Promise<SupervisorStatus | null> {
  const databasePath = join(repo, ".argus", "archive.db");
  const statusPath = join(sandbox.root, "state", "batch-search-status.json");
  const supervisor = new WatcherSupervisor({
    fleetLockPath: LIVE_WATCHER_FLEET_LOCK_PATH,
    registryPath: sandbox.env.ARGUS_REPOS_FILE!,
    restartDelayMilliseconds: 25,
    spawn: createSandboxWatcherSpawner([process.execPath, CLI], sandbox),
    statusPath,
  });

  const snapshot = async (): Promise<SupervisorStatus | null> => {
    try {
      const status = (await Bun.file(statusPath).json()) as SupervisorStatus;
      for (const watcher of status.watchers) {
        if (watcher.repo === repo) sandbox.scope.adopt(watcher.pid);
      }
      return status;
    } catch {
      return null;
    }
  };

  let status: SupervisorStatus | null = null;
  try {
    await supervisor.reconcile();
    for (let attempt = 0; attempt < 600; attempt += 1) {
      await Bun.sleep(50);
      status = await snapshot();
      if ((status?.watchers.length ?? 0) >= EYE_NAMES.length) break;
    }
    for (let attempt = 0; attempt < 900; attempt += 1) {
      await Bun.sleep(100);
      status = await snapshot();
      if (countArchived(databasePath) >= expected) break;
    }
    return status;
  } finally {
    await supervisor.stop();
  }
}

function countArchived(databasePath: string): number {
  try {
    const database = new Database(databasePath, { readonly: true });
    const row = database
      .query<{ count: number }, []>("SELECT count(*) AS count FROM archive_messages")
      .get();
    database.close();
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

function readArchive(databasePath: string): ArchivedMessage[] {
  try {
    const database = new Database(databasePath, { readonly: true });
    const rows = database
      .query<
        {
          agent: string | null;
          content: string;
          provenance: string;
          role: string;
          session_id: string;
          ticket: string | null;
          ts: string;
          provenance_via: string;
        },
        []
      >(
        "SELECT session_id, agent, role, provenance, provenance_via, ticket, ts, content " +
          "FROM archive_messages ORDER BY ts, id",
      )
      .all();
    database.close();
    return rows.map((row) => ({
      agent: row.agent,
      content: row.content,
      provenance: row.provenance,
      role: row.role,
      sessionId: row.session_id,
      ticket: row.ticket,
      ts: row.ts,
      via: row.provenance_via,
    }));
  } catch {
    return [];
  }
}

/**
 * `argus search`, THE CLI, in its own process.
 *
 * The boundary this crosses is the point of §14 bullet 4 and is stated here
 * rather than left implied: the five writers have already exited, the five
 * watcher processes have already been stopped, and this is a THIRD process
 * that opens the on-disk SQLite store read-only and knows nothing about the
 * run except its own `cwd`. Calling `openArchiveSearch` in-process — which is
 * all `src/search/search.test.ts` does — would prove only that a store written
 * moments earlier in the same process can be read back.
 */
async function runSearchCli(
  sandbox: Pick<Sandbox, "env">,
  repo: string,
  query: string,
): Promise<SearchInvocation> {
  const argv = [process.execPath, CLI, "search", query];
  const child = Bun.spawn(argv, {
    cwd: repo,
    env: sandbox.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { argv, cwd: repo, exitCode, query, stderr, stdout };
}

export { sha256 };
