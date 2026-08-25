import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWatcherSpawner } from "../src/supervisor/daemon.ts";
import { WatcherSupervisor } from "../src/supervisor/runtime.ts";

/**
 * The supervisor's status file is a POLLED surface: §13 scenario 6 reads it
 * every few milliseconds while watchers die and restart, and `argus status`
 * reads it whenever a human asks. A plain write truncates first, so a reader
 * landing in that window gets "Failed to parse JSON" — which is exactly how
 * scenario 6 flaked on a loaded machine while ticket #33 was being built.
 * Every other polled surface in Argus (digests, INDEX.md, eye state) is
 * written temp-then-rename; this pins the same invariant here.
 *
 * The torn-read repro that demonstrated the bug (40 repos, 40 churning
 * reconciles, a reader spinning with no sleep — red 2 runs in 3, green 3 in 3
 * after the fix) takes ~85 seconds and is probabilistic, so what stays in the
 * suite is the cheap, deterministic half: the writer leaves no temp file
 * behind, which holds only if it renames one into place.
 */
describe("supervisor status writes are atomic", () => {
  test("the status file is renamed into place, leaving no temp file behind", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-status-atomic-"));
    const statusDirectory = join(root, "state");
    const statusPath = join(statusDirectory, "status.json");
    const registryPath = join(root, "argus-repos");
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    await Bun.write(registryPath, `${repo}\n`);

    const supervisor = new WatcherSupervisor({
      registryPath,
      restartDelayMilliseconds: 1,
      spawn: createWatcherSpawner([
        process.execPath,
        "-e",
        "await new Promise(() => {});",
      ]),
      statusPath,
    });

    try {
      await supervisor.reconcile();
      expect(await readdir(statusDirectory)).toEqual(["status.json"]);
      const status = (await Bun.file(statusPath).json()) as {
        watchers: unknown[];
      };
      expect(status.watchers.length).toBeGreaterThan(0);

      await supervisor.stop();
      expect(await readdir(statusDirectory)).toEqual(["status.json"]);
    } finally {
      await supervisor.stop();
      await rm(root, { force: true, recursive: true });
    }
  }, 60_000);
});
