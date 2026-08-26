import { randomUUID } from "node:crypto";
import {
  appendFile,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  realpath,
  rm,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";

import {
  convergeAgentBindings,
  type HonchoClient,
  type HonchoPeerInput,
  type HonchoWorkspaceInput,
} from "../up/bindings.ts";
import { createWatcherSpawner } from "../supervisor/daemon.ts";
import {
  EYE_NAMES,
  WatcherSupervisor,
  type SpawnWatcher,
  type SupervisorStatus,
} from "../supervisor/runtime.ts";
import { claudeProjectDir } from "../tailing/claude-code.ts";
import {
  adoptSandboxWatchers,
  isWithin,
  SandboxScope,
} from "./sandbox-scope.ts";

export interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface Sandbox {
  createPeer(): Promise<Sandbox>;
  createWorktree(label: string): Promise<string>;
  env: Readonly<Record<string, string>>;
  home: string;
  id: string;
  repo: string;
  root: string;
  /**
   * Ticket #49 — the sandbox's own destructive-op guard.
   *
   * Subscription mode runs the session under the real HOME, so the scenarios'
   * blast radius is no longer an OS boundary. Every wipe and every kill goes
   * through here instead, and `sandbox-scope.test.ts` is what proves it.
   */
  scope: SandboxScope;
  teardown(): Promise<void>;
  up: CommandResult;
}

export interface SandboxOptions {
  checkout: string;
}

/**
 * The watcher spawner for throwaway harness state.
 *
 * Production deliberately lets `createWatcherSpawner` inherit the daemon's
 * environment. A harness watcher must instead receive its sandbox explicitly:
 * omitting it makes the child resolve enrolment against the caller's real
 * state and turns a correct refusal into an apparent restart storm.
 */
export function createSandboxWatcherSpawner(
  commandPrefix: readonly string[],
  sandbox: Pick<Sandbox, "env">,
): SpawnWatcher {
  return createWatcherSpawner(commandPrefix, sandbox.env);
}

export type TestAgent = "claude" | "codex";

export interface AgentSpawnRequest {
  agent: TestAgent;
  command: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  tab: string;
}

export interface AgentSpawnResult {
  exitCode: number;
  stderr?: string;
  stdout?: string;
}

export interface AgentSpawner {
  spawn(request: AgentSpawnRequest): Promise<AgentSpawnResult>;
}

export interface IsolatedAgentSpawnerOptions {
  /**
   * A long-lived inference-only token generated out of band by
   * `claude setup-token`. The harness never provisions, prints or persists it.
   *
   * Optional since #43, because a Codex-only drive needs no Claude credential
   * and must not be made to invent one. A Claude spawn without it is refused
   * by name rather than started with an empty token, which would surface as an
   * opaque auth failure from inside the CLI.
   */
  claudeOauthToken?: string | undefined;
  /** Override command resolution, chiefly to bypass local shell wrappers. */
  executables?: Partial<Record<TestAgent, string>>;
}

/**
 * Real subprocess implementation of the harness seam. Claude subscription
 * auth is injected only into the child environment; the scratch
 * `CLAUDE_CONFIG_DIR` never points at or copies the user's live config.
 */
export function createIsolatedAgentSpawner(
  options: IsolatedAgentSpawnerOptions,
): AgentSpawner {
  return {
    async spawn(request) {
      const env: Record<string, string> = { ...request.env };
      if (request.agent === "claude") {
        const scratchHome = env.HOME;
        const scratchConfig = env.CLAUDE_CONFIG_DIR;
        if (
          scratchHome === undefined ||
          scratchConfig === undefined ||
          isWithin(homedir(), scratchHome) ||
          isWithin(homedir(), scratchConfig)
        ) {
          throw new Error(
            "isolated Claude HOME and CLAUDE_CONFIG_DIR must be outside the real home",
          );
        }
        // Only AFTER the isolation refusal above: a caller who is both
        // untokened and pointed at the real home must be told about the home,
        // so provisioning a token can never be the way to silence that.
        const token = options.claudeOauthToken;
        if (token === undefined || token === "") {
          throw new Error(
            "a live Claude drive needs a provisioned CLAUDE_CODE_OAUTH_TOKEN",
          );
        }
        // These outrank CLAUDE_CODE_OAUTH_TOKEN in Claude's documented auth
        // precedence, so inherited values must not silently change providers.
        delete env.ANTHROPIC_API_KEY;
        delete env.ANTHROPIC_AUTH_TOKEN;
        env.CLAUDE_CODE_OAUTH_TOKEN = token;
      }
      const executable = options.executables?.[request.agent] ?? request.command[0];
      if (executable === undefined) throw new Error("agent command is empty");
      const child = Bun.spawn([executable, ...request.command.slice(1)], {
        cwd: request.cwd,
        env,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stderr, stdout };
    },
  };
}

async function run(
  command: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<CommandResult> {
  const child = Bun.spawn(command, {
    cwd,
    env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);

  return { exitCode, stderr, stdout };
}

export async function createSandbox(
  options: SandboxOptions,
): Promise<Sandbox> {
  const root = await mkdtemp(join(tmpdir(), "argus-harness-"));
  const scope = new SandboxScope(root);
  const home = join(root, "home");
  const id = basename(root);
  const repo = join(root, `scratch-${id}`);
  const state = {
    ARGUS_REPOS_FILE: join(root, "state/argus-repos"),
    CLAUDE_CONFIG_DIR: join(root, "state/claude"),
    CMUX_SOCKET_PATH: join(root, "state/cmux/cmux.sock"),
    CMUX_SOCKET_DIR: join(root, "state/cmux"),
    CODEX_HOME: join(root, "state/codex"),
    GIT_AUTHOR_EMAIL: "harness@invalid.example",
    GIT_AUTHOR_NAME: "Argus Harness",
    GIT_COMMITTER_EMAIL: "harness@invalid.example",
    GIT_COMMITTER_NAME: "Argus Harness",
    HERMES_HOME: join(root, "state/hermes"),
    HOME: home,
    XDG_CACHE_HOME: join(root, "state/cache"),
    XDG_CONFIG_HOME: join(root, "state/config"),
    XDG_DATA_HOME: join(root, "state/data"),
    XDG_STATE_HOME: join(root, "state/state"),
  };
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(Bun.env)) {
    if (
      value !== undefined &&
      !name.startsWith("CMUX_") &&
      name !== "ANTHROPIC_API_KEY" &&
      name !== "ANTHROPIC_AUTH_TOKEN" &&
      name !== "CLAUDE_CODE_OAUTH_TOKEN" &&
      name !== "CODEX_SESSION_ID" &&
      name !== "CODEX_THREAD_ID" &&
      name !== "HONCHO_API_KEY" &&
      name !== "HONCHO_CONFIG_FILE" &&
      name !== "HONCHO_URL"
    ) {
      env[name] = value;
    }
  }
  Object.assign(env, state);

  try {
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(repo, { recursive: true }),
      ...Object.entries(state)
        .filter(
          ([name]) =>
            name !== "CMUX_SOCKET_PATH" &&
            name !== "ARGUS_REPOS_FILE" &&
            !name.startsWith("GIT_"),
        )
        .map(([, path]) => path)
        .filter((path) => path !== home)
        .map((path) => mkdir(path, { recursive: true })),
    ]);

    const initialized = await run(["git", "init", "--quiet"], repo, env);
    if (initialized.exitCode !== 0) {
      throw new Error(`git init failed: ${initialized.stderr}`);
    }

    const committed = await run(
      ["git", "commit", "--quiet", "--allow-empty", "-m", "harness sandbox"],
      repo,
      {
        ...env,
        GIT_AUTHOR_EMAIL: "harness@invalid.example",
        GIT_AUTHOR_NAME: "Argus Harness",
        GIT_COMMITTER_EMAIL: "harness@invalid.example",
        GIT_COMMITTER_NAME: "Argus Harness",
      },
    );
    if (committed.exitCode !== 0) {
      throw new Error(`initial git commit failed: ${committed.stderr}`);
    }

    const up = await run(
      [process.execPath, join(options.checkout, "src/cli.ts"), "up"],
      repo,
      env,
    );

    return {
      createPeer: () => createSandbox(options),
      async createWorktree(label) {
        const worktree = join(root, "worktrees", label);
        await mkdir(join(root, "worktrees"), { recursive: true });
        const result = await run(
          ["git", "worktree", "add", "--quiet", "--detach", worktree],
          repo,
          env,
        );
        if (result.exitCode !== 0) {
          throw new Error(`git worktree add failed: ${result.stderr}`);
        }
        return worktree;
      },
      env,
      home,
      id,
      repo,
      root,
      scope,
      teardown: () => scope.remove(root),
      up,
    };
  } catch (error) {
    await scope.remove(root);
    throw error;
  }
}

const AGENT_COMMANDS: Readonly<Record<TestAgent, readonly string[]>> = {
  claude: ["claude", "--model", "claude-opus-5"],
  codex: ["codex", "-c", "model_reasoning_effort=high"],
};

/**
 * How a driven agent is invoked, per agent, given its scratch worktree.
 *
 * ADDITIVE, #63. The defaults stay `AGENT_COMMANDS`, which are the INTERACTIVE
 * invocations SPEC §13 names — and which no caller could ever have driven to
 * completion, because an interactive session never exits. That is a large part
 * of why `SimulationDriverRunner` had no caller outside its own unit test:
 * starting it was possible, finishing it was not. These hooks let the full
 * real-driver journey issue the headless forms (`claude -p`, `codex exec`) and
 * hand Codex its scratch `CODEX_HOME`, without changing what the class is or
 * what any existing caller gets.
 */
export interface SimulationDriverOptions {
  /** Which agents to drive. Defaults to both, as SPEC §13 names both. */
  agents?: readonly TestAgent[];
  command?(agent: TestAgent, cwd: string): readonly string[];
}

/** One driven agent: what ran, where, and what it returned. */
export interface DrivenAgent {
  agent: TestAgent;
  command: readonly string[];
  cwd: string;
  result: AgentSpawnResult;
  tab: string;
}

export class SimulationDriverRunner {
  constructor(
    private readonly spawner: AgentSpawner,
    private readonly options: SimulationDriverOptions = {},
  ) {}

  /** The full record of the drive — worktrees, commands and results. */
  async drive(sandbox: Sandbox): Promise<DrivenAgent[]> {
    const agents = this.options.agents ?? (["claude", "codex"] as TestAgent[]);
    return Promise.all(
      agents.map(async (agent): Promise<DrivenAgent> => {
        const cwd = await sandbox.createWorktree(agent);
        const command =
          this.options.command?.(agent, cwd) ?? AGENT_COMMANDS[agent];
        const tab = `argus-test-${sandbox.id}-${agent}`;
        const result = await this.spawner.spawn({
          agent,
          command,
          cwd,
          env: sandbox.env,
          tab,
        });
        return { agent, command, cwd, result, tab };
      }),
    );
  }

  async spawnTestAgents(sandbox: Sandbox): Promise<AgentSpawnResult[]> {
    return (await this.drive(sandbox)).map(({ result }) => result);
  }
}

const CORE_SCENARIOS = [
  "Autonomous batch, zero human input",
  "Fake-Johan takeover",
  "Rogue session",
  "The poisoning test",
  "Fault injection: the unlogged send",
  "Watcher death",
  "Signal paths",
  "Self-learning loop",
  "Semantic isolation",
  "Blast-radius zero",
] as const;

export type CoreScenarioNumber = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export interface ScenarioAssertion {
  description: string;
  passed: boolean;
}

/**
 * Ticket #63 — what a scenario's pass is actually worth.
 *
 * STRUCTURAL: real code paths over substituted components — fixture brains, a
 * fake `gh`, an in-memory Honcho, a stub `cmux`, hand-authored hook payloads.
 * LIVE: a real agent ran under this scenario and its own output was graded.
 *
 * Deliberately NOT a declaration. A report is LIVE only if the scenario called
 * `recordLiveEvidence`, and the only thing that can honestly call it is code
 * that spawned an agent, so the verdict cannot be improved by editing a
 * manifest. `verdicts.ts` narrows it further with the slot's declared doubles.
 */
export type ScenarioVerdict = "LIVE" | "STRUCTURAL";

export interface ScenarioContext {
  assert(condition: boolean, description: string): void;
  assertSandboxed(path: string, description: string): void;
  /**
   * Record that a real agent ran, and what it produced. This is the ONLY way
   * a report reaches the LIVE verdict; a scenario that never spawns an agent
   * has nothing truthful to pass here, which is exactly the point.
   */
  recordLiveEvidence(evidence: string): void;
  sandbox: Sandbox;
}

export type ScenarioHandler = (
  context: ScenarioContext,
) => Promise<void> | void;

export interface ScenarioSlot {
  number: CoreScenarioNumber;
  status: "implemented" | "unimplemented";
  title: (typeof CORE_SCENARIOS)[number];
}

export class ScenarioRegistry {
  private readonly implementations = new Map<
    CoreScenarioNumber,
    ScenarioHandler
  >();

  get(number: CoreScenarioNumber): ScenarioHandler | undefined {
    return this.implementations.get(number);
  }

  list(): ScenarioSlot[] {
    return CORE_SCENARIOS.map((title, index) => {
      const number = (index + 1) as CoreScenarioNumber;
      return {
        number,
        status: this.implementations.has(number)
          ? "implemented"
          : "unimplemented",
        title,
      };
    });
  }

  register(number: CoreScenarioNumber, scenario: ScenarioHandler): void {
    this.implementations.set(number, scenario);
  }
}

export function createScenarioRegistry(): ScenarioRegistry {
  const registry = new ScenarioRegistry();
  registry.register(2, fakeJohanBindingScenario);
  registry.register(6, watcherDeathScenario);
  registry.register(9, semanticIsolationScenario);
  registry.register(10, blastRadiusZeroScenario);
  return registry;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function supervisorSnapshot(path: string): Promise<SupervisorStatus> {
  return (await Bun.file(path).json()) as SupervisorStatus;
}

export const watcherDeathScenario: ScenarioHandler = async ({ assert, sandbox }) => {
  assert(sandbox.up.exitCode === 0, "sandbox was converged by argus up");
  const repo = await realpath(sandbox.repo);
  const statusPath = join(sandbox.root, "state", "watcher-death-status.json");
  const supervisor = new WatcherSupervisor({
    registryPath: envPath(sandbox, "ARGUS_REPOS_FILE"),
    restartDelayMilliseconds: 25,
    spawn: createSandboxWatcherSpawner(
      [process.execPath, fileURLToPath(new URL("../cli.ts", import.meta.url))],
      sandbox,
    ),
    statusPath,
  });
  const observedPids = new Set<number>();
  /**
   * #49: read the snapshot and adopt in one step, so no pid this scenario
   * has seen is killable until it has been checked against the sandbox repo.
   * The production dispatcher supervises the real `~/argus` on this machine.
   */
  const snapshot = async (): Promise<SupervisorStatus> => {
    const status = await supervisorSnapshot(statusPath);
    adoptSandboxWatchers(sandbox.scope, repo, status);
    return status;
  };

  try {
    await supervisor.reconcile();
    for (const eye of EYE_NAMES) {
      const readyPath =
        eye === "archiver"
          ? join(repo, ".argus", "archive.db")
          : join(repo, ".argus", "eyes", eye, "cursors.json");
      for (let attempt = 0; !(await Bun.file(readyPath).exists()) && attempt < 500; attempt += 1) {
        await Bun.sleep(20);
      }
    }
    const initial = await snapshot();
    for (const watcher of initial.watchers) observedPids.add(watcher.pid);
    assert(
      initial.watchers.length === EYE_NAMES.length &&
        initial.watchers.every(({ pid }) => processIsAlive(pid)),
      "all five real eye commands started",
    );

    let replacementArchiver: SupervisorStatus["watchers"][number] | undefined;
    for (const eye of EYE_NAMES) {
      const before = (await snapshot()).watchers.find(
        (watcher) => watcher.eye === eye && watcher.repo === repo,
      );
      if (!before) throw new Error(`missing ${eye} watcher fixture`);
      sandbox.scope.kill(before.pid, "SIGKILL");

      let replacement: SupervisorStatus["watchers"][number] | undefined;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        await Bun.sleep(5);
        replacement = (await snapshot()).watchers.find(
          (watcher) =>
            watcher.eye === eye &&
            watcher.repo === repo &&
            watcher.pid !== before.pid &&
            processIsAlive(watcher.pid),
        );
        if (replacement) break;
      }
      assert(replacement !== undefined, `${eye} restarted after death`);
      if (replacement !== undefined) observedPids.add(replacement.pid);
      if (eye === "archiver") replacementArchiver = replacement;
    }

    if (replacementArchiver === undefined) {
      throw new Error("the replacement archiver never started");
    }
    const sessionId = "scenario-6-live-replacement";
    const text = "A replacement watcher observed this post-restart signal.";
    await appendFile(
      join(repo, ".argus", "registry", "sessions.jsonl"),
      `${JSON.stringify({
        ts: "2026-08-25T16:00:00.000Z",
        sessionId,
        agent: "claude",
        dispatchPrompt: text,
      })}\n`,
    );
    const claudeRoot = envPath(sandbox, "CLAUDE_CONFIG_DIR");
    const transcriptDirectory = claudeProjectDir(repo, join(claudeRoot, "projects"));
    await mkdir(transcriptDirectory, { recursive: true });
    await Bun.write(
      join(transcriptDirectory, `${sessionId}.jsonl`),
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: text },
        timestamp: "2026-08-25T16:00:00.000Z",
        promptSource: "typed",
        uuid: "scenario-6-live-u-1",
        sessionId,
        cwd: repo,
        version: "test",
      })}\n`,
    );
    let archived = 0;
    for (let attempt = 0; attempt < 500; attempt += 1) {
      await Bun.sleep(20);
      try {
        const database = new Database(join(repo, ".argus", "archive.db"), {
          readonly: true,
        });
        archived = database
          .query<{ count: number }, [string]>(
            "SELECT count(*) AS count FROM archive_messages WHERE content = ?",
          )
          .get(text)!.count;
        database.close();
      } catch {
        // The replacement may be opening the archive or committing its batch.
      }
      if (archived === 1) break;
    }
    assert(
      archived === 1 && processIsAlive(replacementArchiver.pid),
      "the replacement archiver observed a transcript written after restart",
    );
  } finally {
    await supervisor.stop();
    for (let attempt = 0; attempt < 1_500; attempt += 1) {
      if ([...observedPids].every((pid) => !processIsAlive(pid))) break;
      await Bun.sleep(20);
    }
  }

  assert(
    (await snapshot()).watchers.length === 0 &&
      [...observedPids].every((pid) => !processIsAlive(pid)),
    "supervisor stopped every real eye command",
  );
};

export interface ScenarioRunOptions {
  checkout: string;
  name: string;
  reportDirectory: string;
  scenario: ScenarioHandler;
}

export interface ScenarioReport {
  assertions: ScenarioAssertion[];
  error: string | null;
  id: string;
  /** Everything a live agent actually produced under this run. Usually empty. */
  liveEvidence: string[];
  name: string;
  sandboxRoot: string;
  status: "failed" | "passed";
  teardown: "completed" | "failed";
  up: CommandResult;
  /** #63: no scenario reports a bare pass. See `ScenarioVerdict`. */
  verdict: ScenarioVerdict;
}

export interface ScenarioRunResult extends ScenarioReport {
  reportPath: string;
}

function envPath(sandbox: Sandbox, name: string): string {
  const path = sandbox.env[name];
  if (!path) throw new Error(`sandbox environment is missing ${name}`);
  return path;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function snapshotTree(root: string): Promise<string> {
  const entries: Array<{ content?: string; path: string; type: string }> = [];

  const visit = async (directory: string, prefix = ""): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const relativePath = join(prefix, entry.name);
      if (entry.isDirectory()) {
        entries.push({ path: relativePath, type: "directory" });
        await visit(path, relativePath);
      } else if (entry.isSymbolicLink()) {
        entries.push({
          content: await readlink(path),
          path: relativePath,
          type: "symlink",
        });
      } else {
        entries.push({
          content: Buffer.from(await Bun.file(path).arrayBuffer()).toString("base64"),
          path: relativePath,
          type: "file",
        });
      }
    }
  };

  await visit(root);
  return JSON.stringify(entries);
}

class FixtureHoncho implements HonchoClient {
  readonly #messages = new Map<
    string,
    Array<{ content: string; peer: string }>
  >();
  readonly #peers = new Map<string, Map<string, HonchoPeerInput>>();
  readonly #workspaces = new Map<string, HonchoWorkspaceInput>();

  async ensureWorkspace(
    input: HonchoWorkspaceInput,
  ): Promise<"created" | "existing"> {
    const result = this.#workspaces.has(input.id) ? "existing" : "created";
    this.#workspaces.set(input.id, input);
    return result;
  }

  async ensurePeer(
    workspace: string,
    input: HonchoPeerInput,
  ): Promise<"created" | "existing"> {
    const peers = this.#peers.get(workspace) ?? new Map<string, HonchoPeerInput>();
    const result = peers.has(input.id) ? "existing" : "created";
    peers.set(input.id, input);
    this.#peers.set(workspace, peers);
    return result;
  }

  isObservable(workspace: string, peer: string): boolean {
    const input = this.#peers.get(workspace)?.get(peer);
    return input !== undefined && input.configuration?.observe_me !== false;
  }

  observe(workspace: string, peer: string, content: string): void {
    if (!this.isObservable(workspace, peer)) {
      throw new Error(`fixture peer ${peer} is not observable in ${workspace}`);
    }
    this.ingest(workspace, peer, content);
  }

  ingest(workspace: string, peer: string, content: string): void {
    if (!this.#peers.get(workspace)?.has(peer)) {
      throw new Error(`fixture peer ${peer} is missing from ${workspace}`);
    }
    const messages = this.#messages.get(workspace) ?? [];
    messages.push({ content, peer });
    this.#messages.set(workspace, messages);
  }

  messageCount(workspace: string): number {
    return this.#messages.get(workspace)?.length ?? 0;
  }

  read(workspace: string, peer: string): readonly string[] {
    if (!this.isObservable(workspace, peer)) return [];
    return (this.#messages.get(workspace) ?? [])
      .filter((message) => message.peer === peer)
      .map((message) => message.content);
  }
}

async function bindFixtureSandbox(
  sandbox: Sandbox,
  honcho: HonchoClient,
) {
  return convergeAgentBindings({
    hermesRoot: envPath(sandbox, "HERMES_HOME"),
    honcho,
    honchoUrl: "http://honcho.fixture",
    repo: sandbox.repo,
  });
}

export const fakeJohanBindingScenario: ScenarioHandler = async ({
  assert,
  sandbox,
}) => {
  assert(sandbox.up.exitCode === 0, "sandbox was converged by argus up");
  const honcho = new FixtureHoncho();
  const binding = await bindFixtureSandbox(sandbox, honcho);
  assert(
    honcho.isObservable(binding.workspace, "johan"),
    "Johan is the observable Honcho peer",
  );
  honcho.observe(binding.workspace, "johan", "Fake Johan attached mid-ticket");
  assert(
    honcho.read(binding.workspace, "johan").includes(
      "Fake Johan attached mid-ticket",
    ),
    "user-peer observation was logged",
  );
};

export const semanticIsolationScenario: ScenarioHandler = async ({
  assert,
  sandbox,
}) => {
  const peer = await sandbox.createPeer();
  try {
    assert(sandbox.up.exitCode === 0, "primary sandbox was converged by argus up");
    assert(peer.up.exitCode === 0, "peer sandbox was converged by argus up");
    const honcho = new FixtureHoncho();
    const primaryBinding = await bindFixtureSandbox(sandbox, honcho);
    const peerBinding = await bindFixtureSandbox(peer, honcho);

    assert(
      primaryBinding.workspace !== peerBinding.workspace,
      "repos bind separate Honcho workspaces",
    );
    assert(
      primaryBinding.profile !== peerBinding.profile,
      "repos bind separate Hermes profiles",
    );

    const primaryMemories = join(
      envPath(sandbox, "HERMES_HOME"),
      "profiles",
      primaryBinding.profile,
      "memories",
    );
    const peerMemories = join(
      envPath(peer, "HERMES_HOME"),
      "profiles",
      peerBinding.profile,
      "memories",
    );
    const primaryTarget = resolve(
      dirname(primaryMemories),
      await readlink(primaryMemories),
    );
    const peerTarget = resolve(dirname(peerMemories), await readlink(peerMemories));
    assert(
      (await realpath(primaryTarget)) ===
        (await realpath(join(sandbox.repo, ".argus", "memory"))) &&
        (await realpath(peerTarget)) ===
          (await realpath(join(peer.repo, ".argus", "memory"))) &&
        primaryTarget !== peerTarget,
      "Hermes memories resolve only inside each repo",
    );

    honcho.observe(primaryBinding.workspace, "johan", "primary-johan");
    honcho.ingest(primaryBinding.workspace, "codex", "agent-decoy");
    honcho.observe(peerBinding.workspace, "johan", "peer-johan");
    assert(
      JSON.stringify(honcho.read(primaryBinding.workspace, "johan")) ===
        JSON.stringify(["primary-johan"]) &&
        honcho.read(primaryBinding.workspace, "codex").length === 0 &&
        honcho.messageCount(primaryBinding.workspace) === 2,
      "primary Johan reads exclude agent and peer-repo observations",
    );
    assert(
      JSON.stringify(honcho.read(peerBinding.workspace, "johan")) ===
        JSON.stringify(["peer-johan"]),
      "peer Johan reads exclude primary-repo observations",
    );
  } finally {
    await peer.teardown();
  }
};

export const blastRadiusZeroScenario: ScenarioHandler = async ({
  assert,
  sandbox,
}) => {
  const peer = await sandbox.createPeer();
  try {
    assert(sandbox.up.exitCode === 0, "primary sandbox was converged by argus up");
    assert(peer.up.exitCode === 0, "peer sandbox was converged by argus up");
    const peerArgus = join(peer.repo, ".argus");
    const peerStateBefore = await snapshotTree(peerArgus);
    const peerSupervisor = envPath(peer, "ARGUS_REPOS_FILE");
    const peerSupervisorBefore = await Bun.file(peerSupervisor).text();

    await sandbox.scope.remove(join(sandbox.repo, ".argus"));

    assert(
      !(await exists(join(sandbox.repo, ".argus"))),
      "primary .argus state was removed",
    );
    assert(
      (await snapshotTree(peerArgus)) === peerStateBefore,
      "peer .argus state stayed byte-identical",
    );
    assert(
      (await Bun.file(peerSupervisor).text()) === peerSupervisorBefore,
      "peer supervisor state stayed byte-identical",
    );
  } finally {
    await peer.teardown();
  }
};

export const mechanicsScenario: ScenarioHandler = ({
  assertSandboxed,
  sandbox,
}) => {
  assertSandboxed(
    join(sandbox.home, ".local/bin"),
    "real ~/.local/bin is outside the sandbox boundary",
  );
  assertSandboxed(
    envPath(sandbox, "ARGUS_REPOS_FILE"),
    "real ~/.argus-repos is outside the sandbox boundary",
  );
  assertSandboxed(
    envPath(sandbox, "CLAUDE_CONFIG_DIR"),
    "real ~/.claude is outside the sandbox boundary",
  );
  assertSandboxed(
    envPath(sandbox, "HERMES_HOME"),
    "real ~/.hermes is outside the sandbox boundary",
  );
  assertSandboxed(
    join(sandbox.home, "argus"),
    "real ~/argus is outside the sandbox boundary",
  );
  assertSandboxed(
    envPath(sandbox, "CMUX_SOCKET_DIR"),
    "production cmux is outside the sandbox boundary",
  );
};

export async function runScenario(
  options: ScenarioRunOptions,
): Promise<ScenarioRunResult> {
  await mkdir(options.reportDirectory, { recursive: true });
  const id = randomUUID();
  const sandbox = await createSandbox({ checkout: options.checkout });
  const assertions: ScenarioAssertion[] = [];
  const liveEvidence: string[] = [];
  let error: string | null = null;
  let status: ScenarioReport["status"] = "passed";
  let teardown: ScenarioReport["teardown"] = "completed";

  const assert = (condition: boolean, description: string): void => {
    assertions.push({ description, passed: condition });
    if (!condition) throw new Error(`scenario assertion failed: ${description}`);
  };

  try {
    await options.scenario({
      assert,
      assertSandboxed(path, description) {
        assert(isWithin(sandbox.root, path), description);
      },
      recordLiveEvidence(evidence) {
        liveEvidence.push(evidence);
      },
      sandbox,
    });
  } catch (caught) {
    status = "failed";
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    try {
      await sandbox.teardown();
    } catch (caught) {
      status = "failed";
      teardown = "failed";
      error = caught instanceof Error ? caught.message : String(caught);
    }
  }

  const report: ScenarioReport = {
    assertions,
    error,
    id,
    liveEvidence,
    name: options.name,
    sandboxRoot: sandbox.root,
    status,
    teardown,
    up: sandbox.up,
    // Evidence, never assertion: a run that spawned no agent has no evidence
    // to record, so it cannot claim to have covered the live system.
    verdict: liveEvidence.length > 0 ? "LIVE" : "STRUCTURAL",
  };
  const reportPath = join(options.reportDirectory, `${id}.json`);
  await Bun.write(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  return { ...report, reportPath };
}

export interface ScenarioBatchOptions {
  checkout: string;
  reportDirectory: string;
  scenarios: Array<Pick<ScenarioRunOptions, "name" | "scenario">>;
}

export function runScenarios(
  options: ScenarioBatchOptions,
): Promise<ScenarioRunResult[]> {
  return Promise.all(
    options.scenarios.map(({ name, scenario }) =>
      runScenario({
        checkout: options.checkout,
        name,
        reportDirectory: options.reportDirectory,
        scenario,
      }),
    ),
  );
}
