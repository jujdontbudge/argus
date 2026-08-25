import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWatcherSpawner } from "./daemon.ts";

const roots: string[] = [];

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
});
