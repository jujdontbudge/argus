import { afterEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const sandboxes: string[] = [];

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
  const repo = join(root, "repo");
  await Promise.all([mkdir(home), mkdir(repo)]);
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
});
