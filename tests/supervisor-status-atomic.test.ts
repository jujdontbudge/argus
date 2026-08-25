import { describe, expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWatcherSpawner } from "../src/supervisor/daemon.ts";
import {
  WatcherSupervisor,
  type WatcherProcess,
} from "../src/supervisor/runtime.ts";

class CrashableWatcher implements WatcherProcess {
  readonly exited: Promise<number>;
  #exit!: (code: number) => void;

  constructor(
    readonly pid: number,
    onBackgroundFailure: (error: unknown) => void,
  ) {
    const exited = new Promise<number>((resolve) => {
      this.#exit = resolve;
    });
    const then = exited.then.bind(exited);
    exited.then = ((...arguments_: Parameters<typeof exited.then>) => {
      const handled = then(...arguments_);
      void handled.catch(onBackgroundFailure);
      return handled;
    }) as typeof exited.then;
    this.exited = exited;
  }

  crash(): void {
    this.#exit(1);
  }

  kill(): void {}
}

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
  test("a background status failure is reported without disabling reconciliation", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-status-failure-"));
    const statusPath = join(root, "state", "status.json");
    const registryPath = join(root, "argus-repos");
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    await Bun.write(registryPath, `${repo}\n`);

    let nextPid = 2_000;
    const backgroundFailures: unknown[] = [];
    const spawned: CrashableWatcher[] = [];
    const supervisor = new WatcherSupervisor({
      registryPath,
      restartDelayMilliseconds: 0,
      spawn: () => {
        const watcher = new CrashableWatcher(nextPid++, (error) => {
          backgroundFailures.push(error);
        });
        spawned.push(watcher);
        return watcher;
      },
      statusPath,
    });
    const errorLog = spyOn(console, "error").mockImplementation(() => {});

    try {
      await supervisor.reconcile();
      await rm(statusPath);
      await mkdir(statusPath);
      spawned[0]!.crash();
      for (
        let attempt = 0;
        backgroundFailures.length === 0 && attempt < 20;
        attempt += 1
      ) {
        await Bun.sleep(5);
      }

      expect(backgroundFailures).toHaveLength(1);
      expect(errorLog).toHaveBeenCalledTimes(1);
      expect(String(errorLog.mock.calls[0]?.[0])).toContain("watcher exit");
      expect(errorLog.mock.calls[0]?.[1]).toBe(backgroundFailures[0]);
      expect(await readdir(join(root, "state"))).toEqual(["status.json"]);

      await rm(statusPath, { recursive: true });
      await supervisor.reconcile();
      expect((await Bun.file(statusPath).json()).watchers).toHaveLength(5);
    } finally {
      errorLog.mockRestore();
      await supervisor.stop().catch(() => {});
      await rm(root, { force: true, recursive: true });
    }
  });

  test("concurrent reconciliation and crash restarts never collide or expose torn status", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-status-concurrent-"));
    const statusPath = join(root, "state", "status.json");
    const registryPath = join(root, "argus-repos");
    const repo = join(root, "repo");
    await mkdir(repo, { recursive: true });
    await Bun.write(registryPath, `${repo}\n`);

    let nextPid = 1_000;
    const spawned: CrashableWatcher[] = [];
    const backgroundFailures: unknown[] = [];
    const supervisor = new WatcherSupervisor({
      registryPath,
      restartDelayMilliseconds: 0,
      spawn: () => {
        const watcher = new CrashableWatcher(nextPid++, (error) => {
          backgroundFailures.push(error);
        });
        spawned.push(watcher);
        return watcher;
      },
      statusPath,
    });

    let polling = true;
    const parseFailures: unknown[] = [];
    let snapshotsRead = 0;

    try {
      await supervisor.reconcile();
      const reader = (async () => {
        while (polling) {
          try {
            const status = JSON.parse(await Bun.file(statusPath).text()) as {
              watchers?: unknown;
            };
            if (!Array.isArray(status.watchers)) {
              throw new Error("status snapshot has no complete watchers array");
            }
            snapshotsRead += 1;
          } catch (error) {
            parseFailures.push(error);
          }
          await Bun.sleep(0);
        }
      })();

      for (const watcher of spawned.slice(0, 5)) watcher.crash();
      const reconciliations = await Promise.allSettled(
        Array.from({ length: 64 }, () => supervisor.reconcile()),
      );
      await Bun.sleep(25);
      polling = false;
      await reader;

      const foregroundFailures = reconciliations.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      const writeFailures = [...foregroundFailures, ...backgroundFailures];
      expect(
        writeFailures.filter(
          (error) => error instanceof Error && error.message.includes("ENOENT"),
        ),
      ).toHaveLength(0);
      expect(writeFailures).toEqual([]);
      expect(parseFailures).toEqual([]);
      expect(snapshotsRead).toBeGreaterThan(0);
    } finally {
      polling = false;
      await supervisor.stop().catch(() => {});
      await rm(root, { force: true, recursive: true });
    }
  });

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
