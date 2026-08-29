import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createWatcherSpawner, sampleProcessRss } from "./daemon.ts";

const roots: string[] = [];
const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("supervisor daemon", () => {
  test("spawns the opaque argus watch command in the enabled repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-watcher-command-"));
    roots.push(root);
    const repoPath = join(root, "repo");
    const record = join(root, "record.json");
    await mkdir(repoPath);
    const repo = await realpath(repoPath);
    const spawn = createWatcherSpawner([
      process.execPath,
      "-e",
      `await Bun.write(${JSON.stringify(record)}, JSON.stringify({ argv: Bun.argv.slice(1), cwd: process.cwd() })); await new Promise(() => {});`,
    ]);

    const watcher = spawn({ eye: "digest", repo });
    for (let attempt = 0; !(await Bun.file(record).exists()) && attempt < 20; attempt += 1) {
      await Bun.sleep(5);
    }
    watcher.kill("SIGTERM");
    await watcher.exited;

    expect(await Bun.file(record).json()).toEqual({
      argv: ["watch", "digest", "--repo", repo],
      cwd: repo,
    });
  });

  test("samples the whole watcher fleet RSS in one external call", async () => {
    const readings = await sampleProcessRss([process.pid]);
    expect(readings.get(process.pid)).toBeGreaterThan(0);
  });

  test("externally kills and brakes over-limit watchers without replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-supervisor-brake-"));
    roots.push(root);
    const repoPath = join(root, "repo");
    const home = join(root, "home");
    const registryPath = join(root, "repos");
    const statusPath = join(root, "status.json");
    await Promise.all([
      mkdir(join(repoPath, ".argus", "events"), { recursive: true }),
      mkdir(join(repoPath, ".argus", "registry"), { recursive: true }),
      mkdir(home, { recursive: true }),
    ]);
    const repo = await realpath(repoPath);
    await Promise.all([
      Bun.write(registryPath, `${repo}\n`),
      Bun.write(join(repo, ".argus", "config.yaml"), ""),
      Bun.write(
        join(repo, ".argus", "honcho.yaml"),
        "url: http://127.0.0.1:1\nworkspace: argus-brake-test\n",
      ),
    ]);
    const supervisor = Bun.spawn([process.execPath, cli, "supervisor"], {
      env: {
        ...Bun.env,
        ARGUS_REPOS_FILE: registryPath,
        ARGUS_SUPERVISOR_POLL_MS: "5",
        ARGUS_SUPERVISOR_RESTART_LIMIT: "2",
        ARGUS_SUPERVISOR_RESTART_MAX_MS: "4",
        ARGUS_SUPERVISOR_RESTART_MS: "1",
        ARGUS_SUPERVISOR_RESTART_WINDOW_MS: "60000",
        ARGUS_SUPERVISOR_STATUS_FILE: statusPath,
        ARGUS_SUPERVISOR_WATCH_MAX_RSS_MB: "1",
        ARGUS_WATCH_MAX_RSS_MB: "4096",
        ARGUS_WATCH_POLL_MS: "5",
        CLAUDE_CONFIG_DIR: join(root, "claude"),
        CODEX_HOME: join(root, "codex"),
        HERMES_HOME: join(root, "hermes"),
        HOME: home,
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    try {
      await Bun.sleep(500);
      supervisor.kill("SIGTERM");
      await supervisor.exited;
      const stderr = await new Response(supervisor.stderr).text();

      expect(stderr).toContain("RSS ceiling exceeded externally");
      expect(stderr).toContain("SIGKILL and restart brake engaged");
      expect(stderr).not.toContain("restart 1/2");
    } finally {
      supervisor.kill("SIGTERM");
      await supervisor.exited;
    }
  });
});
