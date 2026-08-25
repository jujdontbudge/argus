import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface Sandbox {
  env: Readonly<Record<string, string>>;
  home: string;
  repo: string;
  root: string;
  teardown(): Promise<void>;
  up: CommandResult;
}

export interface SandboxOptions {
  checkout: string;
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

    const up = await run(
      [process.execPath, join(options.checkout, "src/cli.ts"), "up"],
      repo,
      env,
    );

    return {
      env,
      home,
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
