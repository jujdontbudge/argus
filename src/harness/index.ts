import { randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readdir, readlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";

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
  teardown(): Promise<void>;
  up: CommandResult;
}

export interface SandboxOptions {
  checkout: string;
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
}

export interface AgentSpawner {
  spawn(request: AgentSpawnRequest): Promise<AgentSpawnResult>;
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
  const home = join(root, "home");
  const repo = join(root, "repo");
  const id = basename(root);
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
      name !== "CODEX_SESSION_ID" &&
      name !== "CODEX_THREAD_ID"
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
      teardown: () => rm(root, { force: true, recursive: true }),
      up,
    };
  } catch (error) {
    await rm(root, { force: true, recursive: true });
    throw error;
  }
}

const AGENT_COMMANDS: Readonly<Record<TestAgent, readonly string[]>> = {
  claude: ["claude", "--model", "claude-opus-5"],
  codex: ["codex", "-c", "model_reasoning_effort=high"],
};

export class SimulationDriverRunner {
  constructor(private readonly spawner: AgentSpawner) {}

  async spawnTestAgents(sandbox: Sandbox): Promise<AgentSpawnResult[]> {
    const agents: TestAgent[] = ["claude", "codex"];
    return Promise.all(
      agents.map(async (agent) => {
        const cwd = await sandbox.createWorktree(agent);
        return this.spawner.spawn({
          agent,
          command: AGENT_COMMANDS[agent],
          cwd,
          env: sandbox.env,
          tab: `argus-test-${sandbox.id}-${agent}`,
        });
      }),
    );
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

export interface ScenarioContext {
  assert(condition: boolean, description: string): void;
  assertSandboxed(path: string, description: string): void;
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
  registry.register(10, blastRadiusZeroScenario);
  return registry;
}

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
  name: string;
  sandboxRoot: string;
  status: "failed" | "passed";
  teardown: "completed" | "failed";
  up: CommandResult;
}

export interface ScenarioRunResult extends ScenarioReport {
  reportPath: string;
}

function isWithin(parent: string, child: string): boolean {
  const pathFromParent = relative(resolve(parent), resolve(child));
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent))
  );
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

    await rm(join(sandbox.repo, ".argus"), { force: true, recursive: true });

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
    name: options.name,
    sandboxRoot: sandbox.root,
    status,
    teardown,
    up: sandbox.up,
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
