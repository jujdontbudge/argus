import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const sandboxes: string[] = [];

setDefaultTimeout(30_000);

async function run(
  command: string[],
  cwd: string,
  env: Record<string, string>,
) {
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

async function createScratchRepo(): Promise<{
  env: Record<string, string>;
  repo: string;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "argus-up-"));
  sandboxes.push(root);
  const home = join(root, "home");
  const repoPath = join(root, "repo");
  await Promise.all([mkdir(home), mkdir(repoPath)]);
  const repo = await realpath(repoPath);
  const env = {
    ARGUS_REPOS_FILE: join(root, "state", "argus-repos"),
    CLAUDE_CONFIG_DIR: join(root, "state", "claude"),
    HOME: home,
  };
  expect((await run(["git", "init", "--quiet"], repo, env)).exitCode).toBe(0);
  expect(
    (
      await run(
        ["git", "commit", "--quiet", "--allow-empty", "-m", "initial"],
        repo,
        {
          ...env,
          GIT_AUTHOR_EMAIL: "test@invalid.example",
          GIT_AUTHOR_NAME: "Argus Test",
          GIT_COMMITTER_EMAIL: "test@invalid.example",
          GIT_COMMITTER_NAME: "Argus Test",
        },
      )
    ).exitCode,
  ).toBe(0);
  return { env, repo, root };
}

async function runUp(repo: string, env: Record<string, string>) {
  return run([process.execPath, cli, "up"], repo, env);
}

afterEach(async () => {
  await Promise.all(
    sandboxes.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

describe("argus up", () => {
  test("scaffolds the per-repo Argus layout and commits its ignore entry", async () => {
    const { env, repo } = await createScratchRepo();

    const result = await runUp(repo, env);

    expect(result.exitCode).toBe(0);
    for (const directory of [
      "registry",
      "memory",
      "skills",
      "sessions",
      "events",
    ]) {
      expect((await lstat(join(repo, ".argus", directory))).isDirectory()).toBe(
        true,
      );
    }
    expect(await Bun.file(join(repo, ".argus/config.yaml")).text()).toContain(
      "# brain:",
    );
    expect(await Bun.file(join(repo, ".gitignore")).text()).toBe(".argus/\n");
    expect(
      (
        await run(
          ["git", "show", "HEAD:.gitignore"],
          repo,
          env,
        )
      ).stdout,
    ).toContain(".argus/\n");
  });

  test("moves Claude project memory into Argus and symlinks it back", async () => {
    const { env, repo } = await createScratchRepo();
    const claudeMemory = join(
      env.CLAUDE_CONFIG_DIR!,
      "projects",
      repo.replaceAll("/", "-"),
      "memory",
    );
    await mkdir(join(claudeMemory, "facts"), { recursive: true });
    await Bun.write(join(claudeMemory, "MEMORY.md"), "Claude memory\n");
    await Bun.write(join(claudeMemory, "facts/tooling.md"), "Use Bun\n");

    expect((await runUp(repo, env)).exitCode).toBe(0);

    expect(await Bun.file(join(repo, ".argus/memory/MEMORY.md")).text()).toBe(
      "Claude memory\n",
    );
    expect(
      await Bun.file(join(repo, ".argus/memory/facts/tooling.md")).text(),
    ).toBe("Use Bun\n");
    expect((await lstat(claudeMemory)).isSymbolicLink()).toBe(true);
    expect(await readlink(claudeMemory)).toBe(join(repo, ".argus/memory"));
  });

  test("merges pre-existing Argus and Claude memory without clobbering either", async () => {
    const { env, repo } = await createScratchRepo();
    const claudeMemory = join(
      env.CLAUDE_CONFIG_DIR!,
      "projects",
      repo.replaceAll("/", "-"),
      "memory",
    );
    await mkdir(claudeMemory, { recursive: true });
    await mkdir(join(repo, ".argus/memory"), { recursive: true });
    await Bun.write(join(claudeMemory, "MEMORY.md"), "Claude version\n");
    await Bun.write(join(claudeMemory, "new-fact.md"), "New fact\n");
    await Bun.write(join(repo, ".argus/memory/MEMORY.md"), "Argus version\n");

    expect((await runUp(repo, env)).exitCode).toBe(0);

    expect(await Bun.file(join(repo, ".argus/memory/MEMORY.md")).text()).toBe(
      "Argus version\n",
    );
    expect(await Bun.file(join(repo, ".argus/memory/new-fact.md")).text()).toBe(
      "New fact\n",
    );
    expect(
      await Bun.file(
        join(repo, ".argus/memory/claude-imported/MEMORY.md"),
      ).text(),
    ).toBe("Claude version\n");
    expect((await lstat(claudeMemory)).isSymbolicLink()).toBe(true);
  });

  test("installs Claude skill adapters and an idempotent AGENTS pointer block", async () => {
    const { env, repo } = await createScratchRepo();
    await mkdir(join(repo, ".argus/skills/example"), { recursive: true });
    await Bun.write(join(repo, ".argus/skills/example/SKILL.md"), "# Example\n");
    await Bun.write(join(repo, "AGENTS.md"), "# Repository guidance\n");

    expect((await runUp(repo, env)).exitCode).toBe(0);
    expect(await readlink(join(repo, ".claude/skills"))).toBe(
      "../.argus/skills",
    );
    expect(
      await Bun.file(join(repo, ".claude/skills/example/SKILL.md")).text(),
    ).toBe("# Example\n");
    const firstAgents = await Bun.file(join(repo, "AGENTS.md")).text();
    expect(firstAgents).toContain(".argus/memory/USER.md");
    expect(firstAgents).toContain(".argus/memory/MEMORY.md");
    expect(firstAgents).toContain(".argus/skills/");
    expect(firstAgents).toContain('argus search "<query>"');

    expect((await runUp(repo, env)).exitCode).toBe(0);
    const repeatedAgents = await Bun.file(join(repo, "AGENTS.md")).text();
    expect(repeatedAgents).toBe(firstAgents);
    expect(repeatedAgents.match(/<!-- argus:begin -->/g)).toHaveLength(1);
  });

  test("converges partial adapters and refreshes duplicate pointer blocks", async () => {
    const { env, repo } = await createScratchRepo();
    await mkdir(join(repo, ".claude/skills/local"), { recursive: true });
    await Bun.write(join(repo, ".claude/skills/local/SKILL.md"), "# Local\n");
    await Bun.write(
      join(repo, "AGENTS.md"),
      "Before\n\n<!-- argus:begin -->\nstale one\n<!-- argus:end -->\n\n" +
        "Middle\n\n<!-- argus:begin -->\nstale two\n<!-- argus:end -->\n",
    );

    expect((await runUp(repo, env)).exitCode).toBe(0);

    expect((await lstat(join(repo, ".claude/skills"))).isSymbolicLink()).toBe(
      true,
    );
    expect(
      await Bun.file(join(repo, ".argus/skills/local/SKILL.md")).text(),
    ).toBe("# Local\n");
    const agents = await Bun.file(join(repo, "AGENTS.md")).text();
    expect(agents).toContain("Before");
    expect(agents).toContain("Middle");
    expect(agents).not.toContain("stale one");
    expect(agents).not.toContain("stale two");
    expect(agents.match(/<!-- argus:begin -->/g)).toHaveLength(1);
  });
});
