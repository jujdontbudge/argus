import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { spawnWorker, type WorkerSpawnRequest } from "./spawn.ts";

describe("worker lifecycle observability (#122)", () => {
  test("mirrors both output streams and the exit status to a durable log", async () => {
    const dir = await mkdtemp(join(tmpdir(), "argus-worker-log-"));
    const logFile = join(dir, "worker.log");
    try {
      const request: WorkerSpawnRequest & { logFile: string } = {
        agent: "codex",
        command: [
          "bun",
          "-e",
          "console.log('worker stdout'); console.error('worker stderr'); process.exit(7)",
        ],
        cwd: dir,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        executable: process.execPath,
        logFile,
      };

      const worker = await spawnWorker(request);
      const exit = await worker.exited;
      const log = await readFile(logFile, "utf8");

      expect(exit.exitCode).toBe(7);
      expect(log).toContain("worker stdout");
      expect(log).toContain("worker stderr");
      expect(log).toContain("[argus] worker exited with code 7");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
