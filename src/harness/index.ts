import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

export interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface Sandbox {
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
    env: { ...Bun.env, ...env },
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
  const env = {
    ARGUS_REPOS_DIR: join(root, "state/argus-repos"),
    CLAUDE_CONFIG_DIR: join(root, "state/claude"),
    CMUX_SOCKET_DIR: join(root, "state/cmux"),
    HERMES_HOME: join(root, "state/hermes"),
    HOME: home,
    XDG_CONFIG_HOME: join(root, "state/config"),
    XDG_DATA_HOME: join(root, "state/data"),
    XDG_STATE_HOME: join(root, "state/state"),
  };

  try {
    await Promise.all([
      mkdir(home, { recursive: true }),
      mkdir(repo, { recursive: true }),
      ...Object.values(env)
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
