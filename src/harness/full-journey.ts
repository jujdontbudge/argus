/**
 * Ticket #63 — the opt-in FULL real-driver journey.
 *
 * AUDIT.md §4 item 10's third clause: "at least one opt-in full real-driver
 * journey rather than narrow transcript smokes". The distinction is exact and
 * worth stating, because this tree already had live drives.
 *
 * WHAT THE EXISTING LIVE DRIVES ARE. `subscription-drive.test.ts` and
 * `live-agents.test.ts` spawn a real agent, then read the transcript file it
 * wrote with a `Tailer` constructed in the test. Real agent, real transcript,
 * real parser — and then the test IS the pipeline. No watcher runs, no eye
 * runs, no supervisor runs, nothing that production would run touches the
 * output. They are transcript smokes, and they are valuable as exactly that.
 *
 * WHAT THIS IS. `SimulationDriverRunner` — the class SPEC §13 names as the
 * simulation driver and which, before this ticket, no scenario had ever
 * started — drives real agents into sandbox worktrees, and then the REAL
 * production watcher processes are started over the result: the same
 * `WatcherSupervisor`, spawning the same `argus` eye commands, reading the
 * same archive SQLite store. What gets asserted is what production's own
 * archiver made of a live agent's own words.
 *
 * WHAT IT DELIBERATELY STOPS SHORT OF, stated here rather than discovered
 * later. It does not run the reviewer, digest, honcho or retro eyes' BRAINS
 * over the live transcript, and it does not close a ticket:
 *
 *   - the brains are `claude`/`codex` CLI calls, one subscription call per eye
 *     per session, and a journey that spends five per run is a journey nobody
 *     runs. `FULL_JOURNEY_MANIFEST` marks every requirement that needs them
 *     UNCOVERED rather than quietly grading them on the archiver's evidence.
 *   - closing a ticket needs a tracker, and SPEC §13 forbids a test run
 *     writing to one. #57's slot-1 half covers closure against a `gh` double
 *     and grades PARTIAL for exactly that reason; this journey uses no double
 *     at all, so it reports the requirement UNCOVERED instead.
 *
 * SPEC §1, items 7 and 8. No API key, no token, no metered provider access.
 * The Claude leg is `createSubscriptionAgentSpawner` — Johan's own
 * subscription through the `claude` CLI, real `HOME`, sandbox `cwd` — and a
 * missing `CLAUDE_CODE_OAUTH_TOKEN` is never a reason for the gate to report
 * NOT RUN. The Codex leg is the `codex` CLI with the one copy of `auth.json`
 * SPEC §13 permits, into a scratch `CODEX_HOME` inside the sandbox.
 *
 * THE GATE IS ITS OWN. `ARGUS_LIVE_AGENTS=1` does NOT open this one. That gate
 * buys two one-sentence round trips; this buys those plus five watcher
 * processes and a supervisor, and quietly upgrading someone's opt-in from the
 * first to the second is how a gate stops being an opt-in. Three statuses per
 * #43, in the test name and on the always-printed banner: `gate-unset` when
 * nobody asked, `not-run` when someone asked and a CLI is genuinely absent,
 * and never a silent pass.
 */
import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";

import {
  classifierFromRegistry,
  loadRegistry,
  registryPaths,
  type ProvenanceRecord,
} from "../provenance/index.ts";
import {
  EYE_NAMES,
  WatcherSupervisor,
  type SupervisorStatus,
} from "../supervisor/runtime.ts";
import { claudeProjectDir } from "../tailing/claude-code.ts";
import {
  createClaudeCodeSource,
  createCodexSource,
  Tailer,
  type MessageEvent,
  type TailEvent,
} from "../tailing/index.ts";
import {
  createIsolatedAgentSpawner,
  createSandboxWatcherSpawner,
  SimulationDriverRunner,
  type AgentSpawner,
  type Sandbox,
  type ScenarioHandler,
  type TestAgent,
} from "./index.ts";
import type { SandboxScope } from "./sandbox-scope.ts";
import {
  CODEX_AUTH_FILE,
  LIVE_HALF_BANNER,
  type LiveHalfOutcome,
} from "./live-gate.ts";
import { NATIVE_CLAUDE } from "./subscription-gate.ts";
import { createSubscriptionAgentSpawner } from "./subscription-mode.ts";
import type { ScenarioManifest } from "./verdicts.ts";

/** Its own name, deliberately. #43's gate does not open this one — see above. */
export const FULL_JOURNEY_GATE = "ARGUS_LIVE_FULL_JOURNEY";

export interface FullJourneyProbe {
  codexAuthPresent: boolean;
  codexInstalled: boolean;
  env: Readonly<Record<string, string | undefined>>;
  nativeClaudeInstalled: boolean;
}

export interface FullJourneyGate {
  claude: LiveHalfOutcome;
  codex: LiveHalfOutcome;
  enabled: boolean;
}

const GATE_SHUT =
  `${FULL_JOURNEY_GATE} is unset — the default gate never spends a subscription call`;

/**
 * Pure. Every input arrives in the probe, so all six states are testable
 * without touching the real environment or naming a real credential.
 */
export function resolveFullJourneyGate(
  probe: FullJourneyProbe,
): FullJourneyGate {
  const enabled = probe.env[FULL_JOURNEY_GATE] === "1";
  return {
    // SPEC §1: the ONLY blocking reason on the Claude side is a missing CLI.
    // A missing token is not consulted here at all — subscription mode is the
    // path, and it needs none, so no branch in this function can read one.
    claude: half(enabled, probe.nativeClaudeInstalled
      ? null
      : `the native claude CLI is not at ${NATIVE_CLAUDE}`),
    codex: half(
      enabled,
      !probe.codexInstalled
        ? "the codex CLI is not on PATH"
        : !probe.codexAuthPresent
          ? `${CODEX_AUTH_FILE} is not present`
          : null,
    ),
    enabled,
  };
}

function half(enabled: boolean, missing: string | null): LiveHalfOutcome {
  if (!enabled) return { reason: GATE_SHUT, status: "gate-unset" };
  if (missing !== null) return { reason: missing, status: "not-run" };
  return {
    reason: "gate set, the CLI is present and no API key or token is needed",
    status: "run",
  };
}

/** The banner, printed on every run so a skip is never merely an absence. */
export function describeFullJourneyGate(gate: FullJourneyGate): string {
  if (!gate.enabled) {
    return `argus: the §13 FULL real-driver journey is SKIPPED — set ${FULL_JOURNEY_GATE}=1 to run it; it drives real agents AND five real watcher processes`;
  }
  return [
    `${FULL_JOURNEY_GATE}=1 — the FULL real-driver journey is ENABLED (this spends Johan's subscription)`,
    `  claude  ${LIVE_HALF_BANNER[gate.claude.status]}  ${gate.claude.reason}`,
    `  codex   ${LIVE_HALF_BANNER[gate.codex.status]}  ${gate.codex.reason}`,
    "  SPEC §1: no Anthropic API key, no token, no metered provider — the `claude` and `codex` CLIs only",
  ].join("\n");
}

export function probeFullJourney(): FullJourneyProbe {
  return {
    // Existence only. The file holds a credential and is never opened here.
    codexAuthPresent: existsSync(CODEX_AUTH_FILE),
    codexInstalled: Bun.which("codex") !== null,
    env: { ...Bun.env },
    nativeClaudeInstalled: existsSync(NATIVE_CLAUDE),
  };
}

/**
 * The sentinel the live agents are asked to say.
 *
 * Deliberately not a word either model would produce spontaneously, and
 * deliberately NOT present verbatim in the dispatch below. The assertion
 * downstream is that production's archiver stored the AGENT'S words; if the
 * prompt contained the sentinel, the same query would match the archived
 * dispatch prompt and pass while proving only that the pipeline carried the
 * harness's own echo. The prompt spells it in two halves for that reason.
 */
export const JOURNEY_SENTINEL = "ARGUS-JOURNEY-63-OK";

const DISPATCH =
  "You are working ticket #63. Reply with exactly the two fragments " +
  '"ARGUS-JOURNEY" and "63-OK" joined by a single hyphen, and nothing ' +
  "else. Do not run any commands and do not write any files.";

/** Route each leg to the spawner SPEC §13 names for it. Never by env var. */
export function journeySpawner(scope: SandboxScope): AgentSpawner {
  const subscription = createSubscriptionAgentSpawner({
    // The native install by NAME. Several `claude` shims sit ahead of it on
    // PATH here, one of which never produces an assistant turn at all (#36).
    executables: { claude: NATIVE_CLAUDE },
    scope,
  });
  const isolated = createIsolatedAgentSpawner({});
  return {
    spawn: (request) =>
      request.agent === "claude"
        ? subscription.spawn(request)
        : isolated.spawn(request),
  };
}

function commandFor(agent: TestAgent, cwd: string): readonly string[] {
  return agent === "claude"
    ? ["claude", "-p", DISPATCH, "--model", "claude-opus-5"]
    : [
        "codex",
        "exec",
        "-c",
        "model_reasoning_effort=high",
        "--cd",
        cwd,
        // Stricter than the acceptance script's workspace-write: the journey
        // grades the transcript, so the agent needs no write access at all.
        "--sandbox",
        "read-only",
        DISPATCH,
      ];
}

export interface FullJourneyOptions {
  gate: FullJourneyGate;
}

/**
 * The journey, as a `ScenarioHandler`, so it flows through `runScenario` and
 * gets the same report, the same sandbox lifecycle and the same verdict
 * machinery as any other slot — and so its LIVE verdict comes from
 * `recordLiveEvidence`, which only the real spawns below can honestly call.
 *
 * THERE IS NO SPAWNER SEAM HERE, and its absence is deliberate. Injecting a
 * fake spawner would make the journey's wiring testable on the default path —
 * and would also let a fixture run record live evidence and come out LIVE,
 * which is the exact overclaim this ticket exists to delete. So the live path
 * is exercised only behind the gate. What stops it rotting unnoticed (#46) is
 * that `describeFullJourneyGate` prints on EVERY `bun test`, gate open or shut.
 */
export function fullJourneyScenario(options: FullJourneyOptions): ScenarioHandler {
  return async ({ assert, recordLiveEvidence, sandbox }) => {
    const { gate } = options;
    assert(sandbox.up.exitCode === 0, "sandbox was converged by argus up");

    const agents: TestAgent[] = [];
    if (gate.claude.status === "run") agents.push("claude");
    if (gate.codex.status === "run") {
      // The single production touchpoint SPEC §13 permits, and it is a COPY,
      // into a scratch CODEX_HOME inside the sandbox that teardown removes.
      const codexHome = sandbox.env.CODEX_HOME!;
      await mkdir(codexHome, { recursive: true });
      await copyFile(CODEX_AUTH_FILE, join(codexHome, "auth.json"));
      agents.push("codex");
    }
    assert(
      agents.length > 0,
      "at least one live agent leg is runnable — the journey is not a no-op",
    );

    // SPEC §13's simulation driver, actually started. Nothing in this tree had
    // ever done that: `SimulationDriverRunner` had one unit test and no caller.
    const driven = await new SimulationDriverRunner(
      journeySpawner(sandbox.scope),
      { agents, command: commandFor },
    ).drive(sandbox);

    for (const { agent, cwd, result } of driven) {
      assert(
        result.exitCode === 0,
        `the simulation driver ran a real ${agent} session to completion`,
      );
      assert(
        cwd.startsWith(join(sandbox.root, "worktrees")),
        `the live ${agent} session ran in a sandbox worktree`,
      );
      recordLiveEvidence(
        `${agent}: exit ${result.exitCode} from ${basename(cwd)} (${(result.stdout ?? "").length} bytes of stdout)`,
      );
    }

    // The Claude leg's transcript lands under the REAL `~/.claude/projects/`,
    // because subscription mode is a normal terminal session. It is read from
    // there and copied into the sandbox's own projects root so the sandbox's
    // watchers — which read `CLAUDE_CONFIG_DIR` — can see it. A read of the
    // real home, never a write: SPEC §13 forbids the harness touching it.
    if (gate.claude.status === "run") {
      const copied = await relocateClaudeTranscripts(sandbox);
      assert(
        copied > 0,
        "the live Claude session wrote a real transcript under its own sandbox slug",
      );
      recordLiveEvidence(`claude: ${copied} live transcript file(s)`);
    }

    // The live output, normalized by the same sources production tails. Read
    // BEFORE the watchers start, because the Hermes registry row below has to
    // exist before an eye ever sees the session (§5 rule 1) — registering it
    // afterwards would archive the dispatch as unattributed and make the
    // §13.4 assertions pass for the wrong reason (#50).
    const streams = await liveEvents(sandbox, agents);
    const events = streams.flatMap(({ events: read }) => read);
    const dispatched = streams.flatMap(({ agent, events: read }) =>
      read
        .filter(
          (event): event is MessageEvent =>
            event.type === "message" && event.text.includes("ticket #63"),
        )
        .map((message) => ({ agent, message })),
    );
    assert(
      dispatched.length === agents.length,
      "every live dispatch prompt reached the normalized stream",
    );

    const paths = registryPaths(sandbox.repo);
    await mkdir(join(sandbox.repo, ".argus", "registry"), { recursive: true });
    for (const { agent, message } of dispatched) {
      // What Hermes logs before opening a session (§5 rule 1). The harness is
      // playing Hermes here exactly as #43's and #49's drives do; without the
      // row, the dispatch would be attributed to nobody and the assertion
      // below would pass for the wrong reason (#50).
      await appendFile(
        paths.sessionsFile,
        `${JSON.stringify({
          ts: message.ts,
          sessionId: message.sessionId,
          agent,
          ticket: "63",
          dispatchPrompt: DISPATCH,
          workspace: sandbox.repo,
        })}\n`,
      );
    }

    // PRODUCTION'S OWN WATCHERS, over the live output. This is the whole
    // difference between this journey and a transcript smoke.
    const archived = await runRealWatchers(sandbox);
    assert(
      archived > 0,
      "the real archiver watcher archived the live agent's own words",
    );
    recordLiveEvidence(`archiver: ${archived} live message(s) in archive.db`);

    const { classifier } = classifierFromRegistry(await loadRegistry(paths));
    const records: ProvenanceRecord[] = [];
    for (const event of events) {
      const { record } = classifier.handle(event);
      if (record) records.push(record);
    }
    assert(
      records
        .filter((record) => record.author === "johan")
        .map((record) => record.event.text.slice(0, 120)).length === 0,
      "no live agent output classified Johan-authored",
    );
    assert(
      dispatched.every(({ message }) =>
        records.some(
          (record) => record.event === message && record.author === "hermes",
        ),
      ),
      "every live dispatch prompt classifies Hermes-authored",
    );

  };
}

/** Copy the live Claude transcripts into the sandbox's own projects root. */
async function relocateClaudeTranscripts(
  sandbox: Pick<Sandbox, "env" | "root">,
): Promise<number> {
  const realProjects = join(homedir(), ".claude/projects");
  const sandboxProjects = join(sandbox.env.CLAUDE_CONFIG_DIR!, "projects");
  let copied = 0;
  const worktrees = join(sandbox.root, "worktrees");
  for (const label of await readdir(worktrees)) {
    const source = claudeProjectDir(await realpath(join(worktrees, label)), realProjects);
    const target = claudeProjectDir(
      await realpath(join(worktrees, label)),
      sandboxProjects,
    );
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
 * Start the five real eye watchers and wait for the archiver to store the
 * sentinel. Every pid is adopted through `SandboxScope` before anything can
 * signal it — the production dispatcher supervises the real `~/argus` on this
 * same machine, and #49's rule is that no pid this harness did not spawn is
 * ever killable.
 */
async function runRealWatchers(
  sandbox: Pick<Sandbox, "env" | "repo" | "root" | "scope">,
): Promise<number> {
  const repo = await realpath(sandbox.repo);
  const statusPath = join(sandbox.root, "state", "full-journey-status.json");
  const supervisor = new WatcherSupervisor({
    registryPath: sandbox.env.ARGUS_REPOS_FILE!,
    restartDelayMilliseconds: 25,
    spawn: createSandboxWatcherSpawner(
      [process.execPath, fileURLToPath(new URL("../cli.ts", import.meta.url))],
      sandbox,
    ),
    statusPath,
  });

  try {
    await supervisor.reconcile();
    for (let attempt = 0; attempt < 400; attempt += 1) {
      await Bun.sleep(25);
      try {
        const status = (await Bun.file(statusPath).json()) as SupervisorStatus;
        for (const watcher of status.watchers) {
          if (watcher.repo === repo) sandbox.scope.adopt(watcher.pid);
        }
        if (status.watchers.length >= EYE_NAMES.length) break;
      } catch {
        // The supervisor is still writing its first snapshot.
      }
    }

    for (let attempt = 0; attempt < 600; attempt += 1) {
      await Bun.sleep(50);
      const found = countArchived(join(repo, ".argus", "archive.db"));
      if (found > 0) return found;
    }
    return countArchived(join(repo, ".argus", "archive.db"));
  } finally {
    await supervisor.stop();
  }
}

function countArchived(databasePath: string): number {
  try {
    const database = new Database(databasePath, { readonly: true });
    const row = database
      .query<{ count: number }, [string]>(
        // `role = 'assistant'` is load-bearing: it is what makes this an
        // assertion about the AGENT'S output rather than about the dispatch
        // prompt the harness itself wrote into the same table.
        "SELECT count(*) AS count FROM archive_messages WHERE role = 'assistant' AND content LIKE ?",
      )
      .get(`%${JOURNEY_SENTINEL}%`);
    database.close();
    return row?.count ?? 0;
  } catch {
    // The archiver may be creating the store or committing its batch.
    return 0;
  }
}

async function liveEvents(
  sandbox: Pick<Sandbox, "env" | "root">,
  agents: readonly TestAgent[],
): Promise<Array<{ agent: TestAgent; events: TailEvent[] }>> {
  const streams: Array<{ agent: TestAgent; events: TailEvent[] }> = [];
  if (agents.includes("claude")) {
    const dir = claudeProjectDir(
      await realpath(join(sandbox.root, "worktrees", "claude")),
      join(sandbox.env.CLAUDE_CONFIG_DIR!, "projects"),
    );
    streams.push({
      agent: "claude",
      events: await new Tailer(createClaudeCodeSource({ dir })).catchUp(),
    });
  }
  if (agents.includes("codex")) {
    streams.push({
      agent: "codex",
      events: await new Tailer(
        createCodexSource({ codexHome: sandbox.env.CODEX_HOME! }),
      ).catchUp(),
    });
  }
  return streams;
}

/**
 * The journey's own manifest, and the honest part of this ticket.
 *
 * It shares slot 1's SPEC quotes, because the journey is a live rendering of
 * scenario 1 — but it declares NO doubles, so when it runs it reaches LIVE,
 * and it marks every requirement it does not reach UNCOVERED rather than
 * inheriting slot 1's structural coverage. A journey that graded itself on the
 * fixture suite's assertions would be the same overclaim in a new file.
 */
export const FULL_JOURNEY_MANIFEST: ScenarioManifest = {
  doubles: [],
  number: 1,
  title: "FULL real-driver journey (opt-in)",
  requirements: [
    {
      assertions: [
        "the simulation driver ran a real claude session to completion",
        "the live Claude session wrote a real transcript under its own sandbox slug",
        "the live claude session ran in a sandbox worktree",
      ],
      id: "13.1.batch-end-to-end",
      shortfall:
        "a live session ran end to end and production's own watchers consumed it, but the batch's merge/close leg is not driven here — see 13.1.tickets-closed",
      spec: "run a ticket batch end to end",
    },
    {
      assertions: [
        "the real archiver watcher archived the live agent's own words",
      ],
      id: "13.1.archive-grew",
      shortfall: "",
      spec: "archive grew",
    },
    {
      assertions: [
        "no live agent output classified Johan-authored",
        "every live dispatch prompt classifies Hermes-authored",
      ],
      id: "13.4.hermes-authored",
      shortfall: "",
      spec: "classified Hermes-authored",
    },
    {
      assertions: [],
      id: "13.1.memory-md",
      shortfall:
        "UNCOVERED here by choice: the reviewer eye's brain is a `claude`/`codex` CLI call per session, and the journey does not spend one. Slot 1 covers this structurally on a fixture brain",
      spec: "`MEMORY.md` gained project facts",
    },
    {
      assertions: [],
      id: "13.1.digests-index",
      shortfall:
        "UNCOVERED here by choice: same reason as 13.1.memory-md — the digest eye needs a brain",
      spec: "digests + INDEX updated",
    },
    {
      assertions: [],
      id: "13.1.tickets-closed",
      shortfall:
        "UNCOVERED here by design: closing needs a tracker, and SPEC §13 forbids a test run writing to one. This journey uses no `gh` double at all, so it reports the gap rather than #57's PARTIAL",
      spec: "tickets closed",
    },
  ],
};
