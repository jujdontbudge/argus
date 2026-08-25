import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EYE_NAMES,
  WatcherSupervisor,
  type SpawnWatcher,
  type WatcherProcess,
} from "./runtime.ts";

const roots: string[] = [];

class FakeProcess implements WatcherProcess {
  killed = false;
  readonly exited: Promise<number>;
  #resolveExit!: (code: number) => void;

  constructor(readonly pid: number) {
    this.exited = new Promise<number>((resolve) => {
      this.#resolveExit = resolve;
    });
  }

  crash(): void {
    this.#resolveExit(1);
  }

  kill(): void {
    this.killed = true;
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("watcher supervisor", () => {
  test("starts all five opaque eyes for two repos and stops only a removed repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-supervisor-"));
    roots.push(root);
    const registryPath = join(root, "repos");
    const statusPath = join(root, "status.json");
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");
    await Bun.write(registryPath, `${repoA}\n${repoB}\n`);
    let nextPid = 100;
    const spawned: Array<{
      eye: string;
      process: FakeProcess;
      repo: string;
    }> = [];
    const spawn: SpawnWatcher = ({ eye, repo }) => {
      const process = new FakeProcess(nextPid++);
      spawned.push({ eye, process, repo });
      return process;
    };
    const supervisor = new WatcherSupervisor({ registryPath, spawn, statusPath });

    await supervisor.reconcile();

    expect(EYE_NAMES).toEqual(["reviewer", "archiver", "honcho", "digest", "retro"]);
    expect(spawned.map(({ eye, repo }) => `${repo}:${eye}`).sort()).toEqual(
      [repoA, repoB]
        .flatMap((repo) => EYE_NAMES.map((eye) => `${repo}:${eye}`))
        .sort(),
    );
    expect((await Bun.file(statusPath).json()).watchers).toHaveLength(10);

    await Bun.write(registryPath, `${repoB}\n`);
    await supervisor.reconcile();

    expect(
      spawned.filter(({ repo }) => repo === repoA).every(({ process }) => process.killed),
    ).toBe(true);
    expect(
      spawned.filter(({ repo }) => repo === repoB).every(({ process }) => !process.killed),
    ).toBe(true);
    expect((await Bun.file(statusPath).json()).watchers).toHaveLength(5);
  });

  test("restarts a crashed watcher without interpreting the eye", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-supervisor-"));
    roots.push(root);
    const registryPath = join(root, "repos");
    const statusPath = join(root, "status.json");
    const repo = join(root, "repo");
    await Bun.write(registryPath, `${repo}\n`);
    let nextPid = 200;
    const spawned: FakeProcess[] = [];
    const supervisor = new WatcherSupervisor({
      registryPath,
      restartDelayMilliseconds: 0,
      spawn: () => {
        const process = new FakeProcess(nextPid++);
        spawned.push(process);
        return process;
      },
      statusPath,
    });
    await supervisor.reconcile();

    const crashedPid = spawned[0]!.pid;
    spawned[0]!.crash();
    for (let attempt = 0; spawned.length === 5 && attempt < 20; attempt += 1) {
      await Bun.sleep(5);
    }

    expect(spawned).toHaveLength(6);
    const status = await Bun.file(statusPath).json();
    expect(status.watchers).toHaveLength(5);
    expect(status.watchers.some(({ pid }: { pid: number }) => pid === crashedPid)).toBe(
      false,
    );
  });
});
