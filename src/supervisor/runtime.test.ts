import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
  killSignal: NodeJS.Signals | number | undefined;
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

  kill(signal?: NodeJS.Signals | number): void {
    this.killed = true;
    this.killSignal = signal;
    if (signal === "SIGKILL") this.#resolveExit(137);
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

  test("an external RSS breach kills once and brakes before replaying bad input", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-supervisor-"));
    roots.push(root);
    const registryPath = join(root, "repos");
    const statusPath = join(root, "status.json");
    const repo = join(root, "repo");
    await Bun.write(registryPath, `${repo}\n`);
    let now = 0;
    let nextPid = 225;
    let overLimitPid: number | null = null;
    const spawned: Array<{ eye: string; process: FakeProcess }> = [];
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    const supervisor = new WatcherSupervisor({
      maxWatcherRssBytes: 512,
      now: () => now,
      registryPath,
      restartLimit: 2,
      restartWindowMilliseconds: 1_000,
      sampleRss: async (pids) =>
        new Map(
          pids.map((pid) => [pid, pid === overLimitPid ? 513 : 100]),
        ),
      spawn: ({ eye }) => {
        const process = new FakeProcess(nextPid++);
        spawned.push({ eye, process });
        return process;
      },
      statusPath,
    });
    try {
      await supervisor.reconcile();
      const retro = spawned.find(({ eye }) => eye === "retro")!;
      overLimitPid = retro.process.pid;

      await supervisor.reconcile();
      await Bun.sleep(1);
      await supervisor.reconcile();

      expect(retro.process.killed).toBe(true);
      expect(retro.process.killSignal).toBe("SIGKILL");
      expect(spawned).toHaveLength(5);
      expect((await Bun.file(statusPath).json()).watchers).toHaveLength(4);
      expect(errorLog.mock.calls.map((call) => String(call[0]))).toContainEqual(
        expect.stringContaining("RSS ceiling exceeded externally"),
      );

      now = 1_001;
      overLimitPid = null;
      await supervisor.reconcile();
      expect(spawned).toHaveLength(6);
    } finally {
      errorLog.mockRestore();
      await supervisor.stop();
    }
  });

  test("backs off exponentially and gives up after the restart-window limit", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-supervisor-"));
    roots.push(root);
    const registryPath = join(root, "repos");
    const statusPath = join(root, "status.json");
    const repo = join(root, "repo");
    await Bun.write(registryPath, `${repo}\n`);
    let nextPid = 250;
    let now = 0;
    const delays: number[] = [];
    const spawned: FakeProcess[] = [];
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    const supervisor = new WatcherSupervisor({
      now: () => now,
      registryPath,
      restartDelayMilliseconds: 10,
      restartLimit: 3,
      restartMaxDelayMilliseconds: 100,
      restartWindowMilliseconds: 1_000,
      sleep: async (milliseconds) => {
        delays.push(milliseconds);
        now += milliseconds;
      },
      spawn: () => {
        const process = new FakeProcess(nextPid++);
        spawned.push(process);
        return process;
      },
      statusPath,
    });
    try {
      await supervisor.reconcile();
      for (let crash = 0; crash < 4; crash += 1) {
        spawned.at(-1)!.crash();
        const expected = 6 + Math.min(crash, 2);
        for (
          let attempt = 0;
          (spawned.length < expected || errorLog.mock.calls.length < crash + 1) &&
          attempt < 20;
          attempt += 1
        ) {
          await Bun.sleep(1);
        }
      }

      expect(delays).toEqual([10, 20, 40]);
      expect(spawned).toHaveLength(8);
      expect((await Bun.file(statusPath).json()).watchers).toHaveLength(4);
      const messages = errorLog.mock.calls.map((call) => String(call[0]));
      expect(messages).toContainEqual(
        expect.stringContaining("restart 1/3 in 10ms"),
      );
      expect(messages).toContainEqual(
        expect.stringContaining("restart 2/3 in 20ms"),
      );
      expect(messages).toContainEqual(
        expect.stringContaining("restart 3/3 in 40ms"),
      );
      expect(messages).toContainEqual(
        expect.stringContaining("restart limit reached; giving up"),
      );
    } finally {
      errorLog.mockRestore();
      await supervisor.stop();
    }
  });

  test("the daemon observes registry removal and terminates every child on shutdown", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-supervisor-"));
    roots.push(root);
    const registryPath = join(root, "repos");
    const repo = join(root, "repo");
    await Bun.write(registryPath, `${repo}\n`);
    let nextPid = 300;
    const spawned: FakeProcess[] = [];
    const supervisor = new WatcherSupervisor({
      registryPath,
      spawn: () => {
        const process = new FakeProcess(nextPid++);
        spawned.push(process);
        return process;
      },
      statusPath: join(root, "status.json"),
    });
    const controller = new AbortController();
    const running = supervisor.run(controller.signal, 5);
    for (let attempt = 0; spawned.length < 5 && attempt < 20; attempt += 1) {
      await Bun.sleep(5);
    }

    await Bun.write(registryPath, "");
    for (
      let attempt = 0;
      spawned.some((process) => !process.killed) && attempt < 20;
      attempt += 1
    ) {
      await Bun.sleep(5);
    }
    controller.abort();
    await running;

    expect(spawned).toHaveLength(5);
    expect(spawned.every((process) => process.killed)).toBe(true);
  });

  test("a second live watcher fleet queues on the cross-process lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-supervisor-"));
    roots.push(root);
    const registryPath = join(root, "repos");
    const repo = join(root, "repo");
    const fleetLockPath = join(root, "live-watcher-fleet.lock");
    await Bun.write(registryPath, `${repo}\n`);
    let nextPid = 400;
    const firstSpawned: FakeProcess[] = [];
    const secondSpawned: FakeProcess[] = [];
    const first = new WatcherSupervisor({
      fleetLockPath,
      registryPath,
      spawn: () => {
        const process = new FakeProcess(nextPid++);
        firstSpawned.push(process);
        return process;
      },
      statusPath: join(root, "first-status.json"),
    });
    const second = new WatcherSupervisor({
      fleetLockPath,
      registryPath,
      spawn: () => {
        const process = new FakeProcess(nextPid++);
        secondSpawned.push(process);
        return process;
      },
      statusPath: join(root, "second-status.json"),
    });
    try {
      await first.reconcile();
      const queued = second.reconcile();
      await Bun.sleep(25);

      expect(firstSpawned).toHaveLength(5);
      expect(secondSpawned).toHaveLength(0);

      await first.stop();
      await queued;
      expect(secondSpawned).toHaveLength(5);
    } finally {
      await first.stop();
      await second.stop();
    }
  });
  /**
   * #116's topology: one supervisor, N repos, 5xN watchers. The two properties
   * below are what "the supervisor correctly attributes each of the 5xN
   * watchers to its own repo" means when read off the status file, which is the
   * only surface the soak sampler and `argus status` actually have.
   */
  test("attributes all 5xN watchers to their own repo in the status file", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-supervisor-"));
    roots.push(root);
    const registryPath = join(root, "repos");
    const statusPath = join(root, "status.json");
    const repos = [0, 1, 2].map((index) => join(root, `repo-${index}`));
    await Bun.write(registryPath, `${repos.join("\n")}\n`);
    let nextPid = 100;
    const spawn: SpawnWatcher = () => new FakeProcess(nextPid++);
    const supervisor = new WatcherSupervisor({ registryPath, spawn, statusPath });

    await supervisor.reconcile();

    const watchers = (await Bun.file(statusPath).json()).watchers as Array<{
      eye: string;
      pid: number;
      repo: string;
    }>;
    expect(watchers).toHaveLength(repos.length * EYE_NAMES.length);
    // Every (repo, eye) pair present exactly once...
    expect(watchers.map(({ eye, repo }) => `${repo}:${eye}`).sort()).toEqual(
      repos.flatMap((repo) => EYE_NAMES.map((eye) => `${repo}:${eye}`)).sort(),
    );
    // ...every repo carrying exactly its own five eyes...
    for (const repo of repos) {
      expect(
        watchers.filter((watcher) => watcher.repo === repo).map(({ eye }) => eye).sort(),
      ).toEqual([...EYE_NAMES].sort());
    }
    // ...and no pid claimed by two repos, which is what would make a sampler
    // attribute one repo's RSS to another.
    expect(new Set(watchers.map(({ pid }) => pid)).size).toBe(watchers.length);

    await supervisor.stop();
  });

  test("a crash storm in one repo does not brake another repo's watchers", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-supervisor-"));
    roots.push(root);
    const registryPath = join(root, "repos");
    const statusPath = join(root, "status.json");
    const noisy = join(root, "repo-noisy");
    const quiet = join(root, "repo-quiet");
    await Bun.write(registryPath, `${noisy}\n${quiet}\n`);
    let nextPid = 100;
    const spawned: Array<{ eye: string; process: FakeProcess; repo: string }> = [];
    const spawn: SpawnWatcher = ({ eye, repo }) => {
      const process = new FakeProcess(nextPid++);
      spawned.push({ eye, process, repo });
      return process;
    };
    const supervisor = new WatcherSupervisor({
      registryPath,
      restartDelayMilliseconds: 1,
      restartLimit: 2,
      sleep: () => Promise.resolve(),
      spawn,
      statusPath,
    });

    await supervisor.reconcile();
    const spawnedFor = (repo: string): number =>
      spawned.filter((entry) => entry.repo === repo).length;
    expect(spawnedFor(noisy)).toBe(EYE_NAMES.length);

    // Crash the noisy repo's reviewer past its restart limit. The restart state
    // is keyed by (repo, eye), so the brake must land on that one watcher only.
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const live = spawned
        .filter((entry) => entry.repo === noisy && entry.eye === "reviewer")
        .at(-1);
      if (live === undefined) break;
      live.process.crash();
      // `#restartAfterExit` runs off `process.exited`, so let its microtasks
      // drain before asking the supervisor what it now believes.
      await Bun.sleep(5);
      await supervisor.reconcile();
    }

    const watchers = (await Bun.file(statusPath).json()).watchers as Array<{
      eye: string;
      repo: string;
    }>;
    // The quiet repo still has all five eyes, never restarted once.
    expect(
      watchers.filter((watcher) => watcher.repo === quiet).map(({ eye }) => eye).sort(),
    ).toEqual([...EYE_NAMES].sort());
    expect(spawnedFor(quiet)).toBe(EYE_NAMES.length);
    // And the noisy repo's OTHER four eyes are untouched by their neighbour's brake.
    expect(
      watchers
        .filter((watcher) => watcher.repo === noisy && watcher.eye !== "reviewer")
        .map(({ eye }) => eye)
        .sort(),
    ).toEqual(EYE_NAMES.filter((eye) => eye !== "reviewer").sort());

    await supervisor.stop();
  });
});
