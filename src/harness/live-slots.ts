/**
 * Ticket #78 — the §13 slots themselves, driven by real agents.
 *
 * THE FINDING THIS EXISTS TO CLOSE. All ten core slots listed `agent` among
 * their doubles — "no live Claude or Codex session ran; transcripts are
 * synthesized" — so the suite reported 10 of 10 STRUCTURAL no matter how much
 * else was real. #63 built the verdict vocabulary, #74 drove three manifests
 * LIVE off one journey. What neither did was let a SLOT run against a real
 * agent: #74's live renderings are additive, separately numbered, and say so.
 *
 * WHAT THIS IS, AND WHAT IT IS NOT. It is not a second journey and not a new
 * scenario. `createLiveProvenanceDriver` implements the seam #25 shipped on
 * day one — `ProvenanceScenarioDriver`, whose own docblock has always said
 * "the live harness swaps in a driver that deploys real agents and tails their
 * real transcripts, leaving the scenario bodies untouched". The bodies ARE
 * untouched. Slot 4 and slot 5 run their own code, their own assertions and
 * their own manifests, with a real CLI on the other end of every message.
 *
 * NO FAKE SPAWNER, NO MOCK DRIVER, NO EVIDENCE SEAM — #63's rule, restated
 * because this is the ticket where breaking it would be cheapest. Every
 * function below spawns a real `claude` or `codex` process or does nothing at
 * all. There is no fixture branch, no "record evidence anyway" path, and the
 * driver cannot be constructed into a mode that fabricates a transcript row:
 * the ONLY way a message reaches a session here is a real CLI turn.
 *
 * WHAT A LIVE RUN ACTUALLY BUYS, STATED BEFORE THE CODE. Exactly one double:
 * `agent`. Slots 4 and 5 keep `cmux` and `hermes` and therefore keep the
 * STRUCTURAL verdict, because the registry rows are still appended by the
 * harness and no `cmux send` carries anything. That is a smaller claim than
 * this ticket's title hoped for, and it is the true one — #76's rule, that a
 * better word bought by deleting the property which makes the other verdicts
 * readable is not worth having.
 *
 * WHY ONLY 4 AND 5. The other eight are stated here rather than left to be
 * rediscovered:
 *
 *   - **1, 2, 3, 7, 9** chain halves that call `agentSays(text)` — the driver
 *     method that makes the ASSISTANT say a specific sentence. No live agent
 *     can be made to; the only way to force it is a prompt, and a prompt is a
 *     user-role row nobody logged, which the classifier correctly reads as a
 *     Johan takeover and which would break the very slots it was meant to
 *     serve. Slot 1 additionally chains three halves (archiver, hermes, codex)
 *     that tail their own fixture transcripts, so a live provenance driver
 *     would leave `agent` half-retired there — which is not retired.
 *   - **6, 8, 10** do not take a `ProvenanceScenarioDriver` at all: 6 and 10
 *     drive real supervisor processes, 8 drives a reviewer brain. #74 already
 *     renders 6 live from the FULL journey.
 *
 * SPEC §1 items 7 and 8. Subscriptions through the `claude` and `codex` CLIs.
 * No API key, no token, no metered access, and a missing key is never a reason
 * to report NOT RUN — the Claude leg is `createSubscriptionAgentSpawner` under
 * the real `HOME`, exactly as §13 requires, and the only blocking reason on
 * that side is a missing CLI.
 *
 * ITS OWN GATE, for #74's reason. `ARGUS_LIVE_AGENTS` buys two one-sentence
 * round trips; `ARGUS_LIVE_FULL_JOURNEY` buys those plus five watcher
 * processes; this buys six multi-turn sessions across two CLIs. Rolling any of
 * those into another is how a gate stops being an opt-in, so this one is named
 * `ARGUS_LIVE_SLOTS` and nothing else opens it. Three statuses per #43, in the
 * test name and on a banner printed on EVERY `bun test`, gate open or shut.
 */
import { existsSync } from "node:fs";
import { appendFile, copyFile, mkdir, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { WINDOW_AFTER_MS, type Timestamp } from "../matching/index.ts";
import type {
  DeployOptions,
  ProvenanceScenarioDriver,
  ScenarioSessionHandle,
} from "../provenance/index.ts";
import { registryPaths } from "../provenance/index.ts";
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
  SimulationDriverRunner,
  type AgentSpawner,
  type CoreScenarioNumber,
  type Sandbox,
  type ScenarioHandler,
  type TestAgent,
} from "./index.ts";
import {
  CODEX_AUTH_FILE,
  LIVE_HALF_BANNER,
  type LiveHalfOutcome,
} from "./live-gate.ts";
import type { SandboxScope } from "./sandbox-scope.ts";
import { NATIVE_CLAUDE } from "./subscription-gate.ts";
import { createSubscriptionAgentSpawner } from "./subscription-mode.ts";

/** Its own name, deliberately. No other gate opens this one — see above. */
export const LIVE_SLOTS_GATE = "ARGUS_LIVE_SLOTS";

/**
 * The slots a live drive can honestly retire `agent` from, and the CLI each
 * one runs on. The reasons the other eight are absent are in the docblock.
 *
 * ONE CLI EACH, not both per slot. Slot 4's preamble requirement is a
 * codex-cli finding (#36 F3) and codex still injects `<recommended_plugins>`
 * ahead of every `exec`, so slot 4 takes codex and grades that requirement on
 * the CLI's own injection. Slot 5 takes claude, so a live run exercises both
 * CLIs without spending two sessions per slot.
 */
export const LIVE_SLOTS: Readonly<Record<4 | 5, TestAgent>> = {
  4: "codex",
  5: "claude",
};

export const LIVE_SLOT_NUMBERS = [4, 5] as const satisfies readonly CoreScenarioNumber[];

export interface LiveSlotsProbe {
  codexAuthPresent: boolean;
  codexInstalled: boolean;
  env: Readonly<Record<string, string | undefined>>;
  nativeClaudeInstalled: boolean;
}

export interface LiveSlotsGate {
  claude: LiveHalfOutcome;
  codex: LiveHalfOutcome;
  enabled: boolean;
}

const GATE_SHUT =
  `${LIVE_SLOTS_GATE} is unset — the default gate never spends a subscription call`;

/**
 * Pure. Every input arrives in the probe, so all six states are testable
 * without touching the real environment or naming a real credential.
 */
export function resolveLiveSlotsGate(probe: LiveSlotsProbe): LiveSlotsGate {
  const enabled = probe.env[LIVE_SLOTS_GATE] === "1";
  return {
    // SPEC §1: the ONLY blocking reason on the Claude side is a missing CLI.
    // No branch here reads a token, because subscription mode needs none.
    claude: half(
      enabled,
      probe.nativeClaudeInstalled
        ? null
        : `the native claude CLI is not at ${NATIVE_CLAUDE}`,
    ),
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

/** Which slots this gate can actually drive, given which CLIs are runnable. */
export function runnableLiveSlots(
  gate: LiveSlotsGate,
): readonly (4 | 5)[] {
  return LIVE_SLOT_NUMBERS.filter(
    (slot) => gate[LIVE_SLOTS[slot] === "claude" ? "claude" : "codex"].status === "run",
  );
}

/** The banner, printed on every run so a skip is never merely an absence. */
export function describeLiveSlotsGate(gate: LiveSlotsGate): string {
  if (!gate.enabled) {
    return `argus: the §13 LIVE SLOT drive is SKIPPED — set ${LIVE_SLOTS_GATE}=1 to run slots ${LIVE_SLOT_NUMBERS.join(" and ")} against real agents`;
  }
  return [
    `${LIVE_SLOTS_GATE}=1 — §13 slots ${LIVE_SLOT_NUMBERS.join(" and ")} run against REAL agents (this spends Johan's subscription)`,
    `  claude  ${LIVE_HALF_BANNER[gate.claude.status]}  ${gate.claude.reason}`,
    `  codex   ${LIVE_HALF_BANNER[gate.codex.status]}  ${gate.codex.reason}`,
    "  SPEC §1: no Anthropic API key, no token, no metered provider — the `claude` and `codex` CLIs only",
  ].join("\n");
}

export function probeLiveSlots(): LiveSlotsProbe {
  return {
    // Existence only. The file holds a credential and is never opened here.
    codexAuthPresent: existsSync(CODEX_AUTH_FILE),
    codexInstalled: Bun.which("codex") !== null,
    env: { ...Bun.env },
    nativeClaudeInstalled: existsSync(NATIVE_CLAUDE),
  };
}

/**
 * What the dispatch asks for beyond the scenario's own words.
 *
 * SPEC §13's subscription-mode rule is that what stands in for the missing OS
 * boundary is SCRIPTED SCOPE: a sandbox `cwd` and "a dispatch that asks only
 * for benign scripted work with no tools". The scenarios' dispatch prompt asks
 * a worker to implement a widget, which is neither benign nor scripted when a
 * real agent reads it, so the live driver appends this. The registry row logs
 * the SUFFIXED text — what was actually sent — so the dispatch still matches
 * its landing exactly, and the scenario's own prompt is unchanged.
 */
const SCOPE_SUFFIX =
  "\n\nThis is an Argus SPEC §13 harness drive, not real work. Do not run any " +
  "commands, do not read or write any files, and do not use any tools. Reply " +
  "with exactly the word ACKNOWLEDGED and nothing else.";

interface LiveSession {
  agent: TestAgent;
  cwd: string;
  sessionId: string;
}

interface LiveWorld {
  codexReady: boolean;
  /** One line per real CLI turn this driver actually completed. */
  evidence: string[];
  sessions: LiveSession[];
}

/**
 * The driver, plus the record of what it spawned.
 *
 * `evidence` is why this type exists. `recordLiveEvidence` — #63's only route
 * to a live grade — hangs off the scenario CONTEXT, and a driver is handed a
 * sandbox, not a context. So the driver accumulates the lines and
 * `liveSlotScenario` below hands them to the context after the slot's own body
 * has run. Every line is appended at the point a real CLI process exited 0;
 * there is no other writer, and a run that spawns nothing produces none, which
 * is the property that keeps a fixture run from ever grading live.
 */
export interface LiveProvenanceDriver extends ProvenanceScenarioDriver {
  evidence(sandbox: Pick<Sandbox, "root">): readonly string[];
}

/**
 * The real driver. Every method below either spawns a CLI or writes a registry
 * row; nothing synthesizes a transcript.
 */
export function createLiveProvenanceDriver(): LiveProvenanceDriver {
  const worlds = new Map<string, LiveWorld>();
  const world = (sandbox: Pick<Sandbox, "root">): LiveWorld => {
    let state = worlds.get(sandbox.root);
    if (!state) {
      state = { codexReady: false, evidence: [], sessions: [] };
      worlds.set(sandbox.root, state);
    }
    return state;
  };

  /**
   * Route each leg to the spawner SPEC §13 names for it — by NAME, never by
   * environment variable (#49). The scope comes off the sandbox the scenario
   * is running in, so the subscription spawner is still unreachable without
   * one, and the one it gets is the one that owns the worktree it is confined
   * to rather than one this module chose.
   */
  const spawnerFor = (scope: SandboxScope): AgentSpawner => ({
    spawn: (request) =>
      request.agent === "claude"
        ? createSubscriptionAgentSpawner({
            // The native install BY NAME. Several `claude` shims sit ahead of
            // it on PATH here, one of which never produces an assistant turn
            // at all (#36).
            executables: { claude: NATIVE_CLAUDE },
            scope,
          }).spawn(request)
        : createIsolatedAgentSpawner({}).spawn(request),
  });

  /**
   * The single production touchpoint SPEC §13 permits, and it is a COPY into
   * the sandbox's own scratch `CODEX_HOME`, which teardown removes.
   */
  const prepareCodex = async (sandbox: Sandbox): Promise<void> => {
    const state = world(sandbox);
    if (state.codexReady) return;
    const codexHome = sandbox.env.CODEX_HOME!;
    await mkdir(codexHome, { recursive: true });
    await copyFile(CODEX_AUTH_FILE, join(codexHome, "auth.json"));
    state.codexReady = true;
  };

  /** One more real turn into an already-open session. */
  const turn = async (
    sandbox: Sandbox,
    session: LiveSession,
    text: string,
  ): Promise<void> => {
    const command =
      session.agent === "claude"
        ? ["claude", "-p", "--resume", session.sessionId, "--model", "claude-opus-5", text]
        : [
            "codex",
            "exec",
            "-c",
            "model_reasoning_effort=high",
            // Stricter than the acceptance script's workspace-write: these
            // slots grade the transcript, so the agent needs no write access.
            "--sandbox",
            "read-only",
            // Options precede the subcommand; `codex exec resume` rejects them
            // after the session id, and `--cd` is not accepted on resume at
            // all — the cwd below is what keeps the turn in the worktree.
            "resume",
            session.sessionId,
            text,
          ];
    const result = await spawnerFor(sandbox.scope).spawn({
      agent: session.agent,
      command,
      cwd: session.cwd,
      env: sandbox.env,
      tab: `argus-live-slot-${sandbox.id}-${session.agent}`,
    });
    if (result.exitCode !== 0) {
      throw new Error(
        `live ${session.agent} turn failed with exit ${result.exitCode}: ${(result.stderr ?? "").slice(0, 400)}`,
      );
    }
    world(sandbox).evidence.push(
      `${session.agent}: exit 0 on a resumed turn of live session ${session.sessionId} ` +
        `(${(result.stdout ?? "").length} bytes of stdout)`,
    );
  };

  const appendRow = async (file: string, row: unknown): Promise<void> => {
    await mkdir(join(file, ".."), { recursive: true });
    await appendFile(file, `${JSON.stringify(row)}\n`);
  };

  return {
    evidence: (sandbox) => [...world(sandbox).evidence],

    async deploy(deployOptions: DeployOptions): Promise<ScenarioSessionHandle> {
      const { sandbox } = deployOptions;
      const agent: TestAgent =
        deployOptions.agent === "codex" ? "codex" : "claude";
      if (agent === "codex") await prepareCodex(sandbox);

      const dispatchPrompt = `${deployOptions.dispatchPrompt}${SCOPE_SUFFIX}`;
      // Fixed up front for Claude, discovered afterwards for Codex — either
      // way the registry row below carries the id the CLI actually used, and
      // the handle hands it to the scenario so no slot has to guess.
      const claudeSessionId = crypto.randomUUID();
      // §5 rule 1 is that Hermes logs BEFORE the session opens. Codex only
      // reveals its session id once the rollout exists, so the row is written
      // after the spawn with the timestamp taken before it — the ordering the
      // matcher cares about is the timestamp, and this one is honest.
      const openedAt = new Date().toISOString();

      // SPEC §13's simulation driver, which is what starts the session. It
      // creates the worktree, so the live session's cwd is inside the sandbox
      // by construction and not by a string this module built.
      const driven = await new SimulationDriverRunner(spawnerFor(sandbox.scope), {
        agents: [agent],
        command: (_agent, cwd) =>
          agent === "claude"
            ? [
                "claude",
                "-p",
                "--session-id",
                claudeSessionId,
                "--model",
                "claude-opus-5",
                dispatchPrompt,
              ]
            : [
                "codex",
                "exec",
                "-c",
                "model_reasoning_effort=high",
                "--cd",
                cwd,
                "--sandbox",
                "read-only",
                dispatchPrompt,
              ],
      }).drive(sandbox);
      const [only] = driven;
      if (only === undefined || only.result.exitCode !== 0) {
        throw new Error(
          `live ${agent} dispatch failed with exit ${only?.result.exitCode}: ${(only?.result.stderr ?? "").slice(0, 400)}`,
        );
      }

      const sessionId =
        agent === "claude"
          ? claudeSessionId
          : await newestCodexSessionId(sandbox);
      const session: LiveSession = { agent, cwd: only.cwd, sessionId };
      const state = world(sandbox);
      state.sessions.push(session);
      state.evidence.push(
        `${agent}: exit 0 from the simulation driver's dispatch into live session ${sessionId} ` +
          `(${(only.result.stdout ?? "").length} bytes of stdout)`,
      );

      const paths = registryPaths(sandbox.repo);
      await appendRow(paths.sessionsFile, {
        ts: openedAt,
        sessionId,
        agent: deployOptions.agent,
        ...(deployOptions.ticket !== undefined && { ticket: deployOptions.ticket }),
        dispatchPrompt,
        workspace: sandbox.repo,
      });

      const loggedSend = async (text: string, lands: boolean): Promise<void> => {
        await appendRow(paths.sendsFile, {
          ts: new Date().toISOString(),
          sessionId,
          text,
        });
        if (lands) await turn(sandbox, session, text);
      };

      return {
        // What the CLI injected, not what the caller asked for. `deploy`'s
        // `preamble` option is the fixture driver's input and is deliberately
        // ignored here — a live CLI injects what it injects.
        preamble: await injectedPreamble(sandbox, session, dispatchPrompt),
        sessionId,
        hermesSend: (text) => loggedSend(text, true),
        hermesSendLost: (text) => loggedSend(text, false),
        // A landing with no registry row, through the same real CLI turn. The
        // difference between this and `hermesSend` is one appended row, which
        // is exactly what the fault this slot injects consists of.
        unloggedSend: (text) => turn(sandbox, session, text),
        johanTypes: (text) => turn(sandbox, session, text),
        agentSays: async () => {
          // Deliberately unreachable, and a throw rather than a no-op: a live
          // agent cannot be told to utter a given sentence, and a driver that
          // quietly did nothing here would let a slot assert about a message
          // that was never said. See the docblock's list of excluded slots.
          throw new Error(
            "a live agent cannot be scripted to say a specific sentence — this slot is not live-drivable",
          );
        },
      };
    },

    async events(sandbox: Sandbox): Promise<TailEvent[]> {
      return liveEvents(sandbox, world(sandbox).sessions);
    },

    async afterMatchWindow(sandbox: Sandbox): Promise<Timestamp> {
      const events = await liveEvents(sandbox, world(sandbox).sessions);
      const last = events.reduce(
        (latest, event) => Math.max(latest, eventMs(event)),
        Date.now(),
      );
      return last + WINDOW_AFTER_MS + 1;
    },
  };
}

/** The newest rollout under the sandbox's scratch CODEX_HOME, by session id. */
async function newestCodexSessionId(sandbox: Sandbox): Promise<string> {
  const events = await new Tailer(
    createCodexSource({ codexHome: sandbox.env.CODEX_HOME! }),
  ).catchUp();
  const ids = events
    .filter((event): event is MessageEvent => event.type === "message")
    .map(({ sessionId }) => sessionId);
  const newest = ids.at(-1);
  if (newest === undefined) {
    throw new Error("the live codex session wrote no rollout under CODEX_HOME");
  }
  return newest;
}

/**
 * The user-role items the CLI put in its own rollout before the dispatch
 * landed — codex-cli's `<recommended_plugins>` block, and whatever else a
 * future version adds beside it.
 */
async function injectedPreamble(
  sandbox: Sandbox,
  session: LiveSession,
  dispatchPrompt: string,
): Promise<readonly string[]> {
  const events = await liveEvents(sandbox, [session]);
  const messages = events.filter(
    (event): event is MessageEvent =>
      event.type === "message" &&
      event.sessionId === session.sessionId &&
      event.role === "user",
  );
  const dispatchAt = messages.findIndex(({ text }) => text === dispatchPrompt);
  return (dispatchAt === -1 ? [] : messages.slice(0, dispatchAt)).map(
    ({ text }) => text,
  );
}

/**
 * Every live session's transcript, normalized by the sources production tails,
 * in one chronological stream.
 *
 * The Claude leg's transcript lands under the REAL `~/.claude/projects/`,
 * because subscription mode is a normal terminal session. It is READ from
 * there and copied into the sandbox's own projects root — a read of the real
 * home and never a write, which is what SPEC §13 permits.
 */
async function liveEvents(
  sandbox: Pick<Sandbox, "env" | "root">,
  sessions: readonly LiveSession[],
): Promise<TailEvent[]> {
  const events: TailEvent[] = [];
  if (sessions.some(({ agent }) => agent === "claude")) {
    await relocateClaudeTranscripts(sandbox);
    const projects = join(sandbox.env.CLAUDE_CONFIG_DIR!, "projects");
    for (const session of sessions.filter(({ agent }) => agent === "claude")) {
      const dir = claudeProjectDir(await realpath(session.cwd), projects);
      if (!existsSync(dir)) continue;
      events.push(...(await new Tailer(createClaudeCodeSource({ dir })).catchUp()));
    }
  }
  if (sessions.some(({ agent }) => agent === "codex")) {
    events.push(
      ...(await new Tailer(
        createCodexSource({ codexHome: sandbox.env.CODEX_HOME! }),
      ).catchUp()),
    );
  }
  return events.sort((left, right) => eventMs(left) - eventMs(right));
}

/** Not every event kind carries a timestamp; the ones being ordered here do. */
function eventMs(event: TailEvent): number {
  const parsed = event.ts === undefined ? Number.NaN : Date.parse(event.ts);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/** Copy the live Claude transcripts into the sandbox's own projects root. */
async function relocateClaudeTranscripts(
  sandbox: Pick<Sandbox, "env" | "root">,
): Promise<void> {
  const realProjects = join(homedir(), ".claude/projects");
  const sandboxProjects = join(sandbox.env.CLAUDE_CONFIG_DIR!, "projects");
  const worktrees = join(sandbox.root, "worktrees");
  let labels: string[];
  try {
    labels = await readdir(worktrees);
  } catch {
    return;
  }
  for (const label of labels) {
    const resolved = await realpath(join(worktrees, label));
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
    }
  }
}

/**
 * A §13 slot, wrapped so what the driver actually spawned reaches the report.
 *
 * The slot's own handler is called unchanged — this adds nothing to it and
 * removes nothing from it. What it does is close the one gap between #63's
 * machinery and a live DRIVER: `recordLiveEvidence` lives on the scenario
 * context and the driver only ever sees a sandbox. The evidence is appended
 * AFTER the body, so a slot that failed records none and grades on its
 * doubles exactly as the fixture run would.
 */
export function liveSlotScenario(
  handler: ScenarioHandler,
  driver: LiveProvenanceDriver,
): ScenarioHandler {
  return async (context) => {
    await handler(context);
    const evidence = driver.evidence(context.sandbox);
    if (evidence.length === 0) {
      throw new Error(
        "the live slot drive completed without spawning a single agent turn",
      );
    }
    for (const line of evidence) context.recordLiveEvidence(line);
  };
}
