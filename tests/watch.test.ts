import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function watchWorld() {
  const root = await mkdtemp(join(tmpdir(), "argus-watch-"));
  const repoPath = join(root, "repo");
  const home = join(root, "home");
  const registry = join(root, "state", "argus-repos");
  await Promise.all([
    mkdir(join(repoPath, ".argus", "registry"), { recursive: true }),
    mkdir(join(repoPath, ".argus", "events"), { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(join(root, "state"), { recursive: true }),
  ]);
  const repo = await realpath(repoPath);
  await Promise.all([
    Bun.write(registry, `${repo}\n`),
    Bun.write(join(repo, ".argus", "config.yaml"), ""),
    Bun.write(
      join(repo, ".argus", "honcho.yaml"),
      "url: http://127.0.0.1:1\nworkspace: argus-watch-test\n",
    ),
  ]);
  return {
    env: {
      ...Bun.env,
      ARGUS_REPOS_FILE: registry,
      CLAUDE_CONFIG_DIR: join(root, "state", "claude"),
      CODEX_HOME: join(root, "state", "codex"),
      HERMES_HOME: join(root, "state", "hermes"),
      HOME: home,
      HONCHO_CONFIG_FILE: join(root, "state", "missing-honcho.json"),
    },
    repo,
    root,
  };
}

describe("argus watch", () => {
  test("all five eye commands stay alive and stop cleanly on SIGTERM", async () => {
    const world = await watchWorld();
    try {
      for (const eye of ["reviewer", "digest", "retro", "archiver", "honcho"]) {
        const child = Bun.spawn(
          [process.execPath, cli, "watch", eye, "--repo", world.repo],
          { env: world.env, stderr: "pipe", stdout: "pipe" },
        );
        const earlyExit = await Promise.race([
          child.exited.then((exitCode) => ({ exitCode })),
          Bun.sleep(150).then(() => null),
        ]);
        expect({ eye, earlyExit }).toEqual({ eye, earlyExit: null });

        child.kill("SIGTERM");
        expect({ eye, exitCode: await child.exited }).toEqual({
          eye,
          exitCode: 0,
        });
      }
    } finally {
      await rm(world.root, { force: true, recursive: true });
    }
  }, 30_000);
});
