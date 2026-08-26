import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

import { readEnabledRepos } from "./registry.ts";

export const EYE_NAMES = [
  "reviewer",
  "archiver",
  "honcho",
  "digest",
  "retro",
] as const;

export type EyeName = (typeof EYE_NAMES)[number];

export interface WatcherProcess {
  readonly exited: Promise<number>;
  readonly pid: number;
  kill(signal?: NodeJS.Signals | number): void;
}

export interface WatcherSpawnRequest {
  eye: EyeName;
  repo: string;
}

export type SpawnWatcher = (request: WatcherSpawnRequest) => WatcherProcess;

export interface WatcherSupervisorOptions {
  fleetLockPath?: string;
  now?: () => number;
  registryPath: string;
  restartDelayMilliseconds?: number;
  restartLimit?: number;
  restartMaxDelayMilliseconds?: number;
  restartWindowMilliseconds?: number;
  sleep?: (milliseconds: number) => Promise<void>;
  spawn: SpawnWatcher;
  statusPath: string;
}

export interface WatcherStatus {
  eye: EyeName;
  pid: number;
  repo: string;
  state: "running";
}

export interface SupervisorStatus {
  updatedAt: string;
  watchers: WatcherStatus[];
}

function watcherKey(repo: string, eye: EyeName): string {
  return JSON.stringify([repo, eye]);
}

interface RestartState {
  braked: boolean;
  nextSpawnAt: number;
  restarts: number[];
}

interface FleetLease {
  release(): Promise<void>;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireFleetLease(
  path: string,
  cancelled: () => boolean,
): Promise<FleetLease | null> {
  const token = randomUUID();
  const ownerPath = `${path}/owner.json`;
  while (!cancelled()) {
    try {
      await mkdir(path);
      try {
        await Bun.write(
          ownerPath,
          `${JSON.stringify({ pid: process.pid, token })}\n`,
        );
      } catch (error) {
        await rm(path, { force: true, recursive: true });
        throw error;
      }
      return {
        async release() {
          try {
            const owner = (await Bun.file(ownerPath).json()) as {
              token?: unknown;
            };
            if (owner.token !== token) return;
          } catch {
            return;
          }
          await rm(path, { force: true, recursive: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }

    let ownerPid: number | null = null;
    try {
      const owner = (await Bun.file(ownerPath).json()) as { pid?: unknown };
      if (typeof owner.pid === "number") ownerPid = owner.pid;
    } catch {
      // The lock owner may be between mkdir and its atomic-sized owner write.
    }
    if (ownerPid !== null && !processIsAlive(ownerPid)) {
      await rm(path, { force: true, recursive: true }).catch(() => {});
      continue;
    }
    await Bun.sleep(50);
  }
  return null;
}

export class WatcherSupervisor {
  readonly #children = new Map<
    string,
    { eye: EyeName; process: WatcherProcess; repo: string }
  >();
  #fleetLease: FleetLease | null = null;
  readonly #options: WatcherSupervisorOptions;
  #reconcileQueue: Promise<void> = Promise.resolve();
  readonly #restarts = new Map<string, RestartState>();
  #stopping = false;

  constructor(options: WatcherSupervisorOptions) {
    this.#options = options;
  }

  reconcile(): Promise<void> {
    const scheduled = this.#reconcileQueue.then(() => this.#reconcileOnce());
    this.#reconcileQueue = scheduled.catch(() => {});
    return scheduled;
  }

  async #reconcileOnce(): Promise<void> {
    if (this.#stopping) return;
    if (
      this.#fleetLease === null &&
      this.#options.fleetLockPath !== undefined
    ) {
      this.#fleetLease = await acquireFleetLease(
        this.#options.fleetLockPath,
        () => this.#stopping,
      );
      if (this.#fleetLease === null) return;
    }
    const repos = await readEnabledRepos(this.#options.registryPath);
    const desired = new Set(
      repos.flatMap((repo) => EYE_NAMES.map((eye) => watcherKey(repo, eye))),
    );

    for (const key of this.#restarts.keys()) {
      if (!desired.has(key)) this.#restarts.delete(key);
    }

    for (const [key, child] of this.#children) {
      if (desired.has(key)) continue;
      child.process.kill("SIGTERM");
      this.#children.delete(key);
    }

    for (const repo of repos) {
      for (const eye of EYE_NAMES) {
        const key = watcherKey(repo, eye);
        if (this.#children.has(key)) continue;
        const restart = this.#restarts.get(key);
        if (restart !== undefined) {
          const now = this.#now();
          restart.restarts = restart.restarts.filter(
            (at) => now - at < this.#restartWindowMilliseconds(),
          );
          if (restart.braked && restart.restarts.length < this.#restartLimit()) {
            restart.braked = false;
          }
          if (restart.braked || now < restart.nextSpawnAt) continue;
        }
        const process = this.#options.spawn({ eye, repo });
        const child = {
          eye,
          process,
          repo,
        };
        this.#children.set(key, child);
        void process.exited
          .then((exitCode) => this.#restartAfterExit(key, child, exitCode))
          .catch((error: unknown) => {
            console.error(
              `argus supervisor: failed to handle ${eye} watcher exit for ${repo}`,
              error,
            );
          });
      }
    }

    await this.#writeStatus();
  }

  async run(signal: AbortSignal, pollMilliseconds = 1_000): Promise<void> {
    try {
      while (!signal.aborted) {
        await this.reconcile();
        await Bun.sleep(pollMilliseconds);
      }
    } finally {
      await this.stop();
    }
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    for (const child of this.#children.values()) child.process.kill("SIGTERM");
    this.#children.clear();
    this.#restarts.clear();
    await this.#writeStatus();
    await this.#fleetLease?.release();
    this.#fleetLease = null;
  }

  #now(): number {
    return this.#options.now?.() ?? Date.now();
  }

  #restartLimit(): number {
    return this.#options.restartLimit ?? 5;
  }

  #restartWindowMilliseconds(): number {
    return this.#options.restartWindowMilliseconds ?? 5 * 60_000;
  }

  async #writeStatus(): Promise<void> {
    const watchers = [...this.#children.values()]
      .map(({ eye, process, repo }) => ({ eye, pid: process.pid, repo, state: "running" as const }))
      .sort((left, right) =>
        left.repo.localeCompare(right.repo) || left.eye.localeCompare(right.eye),
      );
    const status: SupervisorStatus = {
      updatedAt: new Date().toISOString(),
      watchers,
    };
    await mkdir(dirname(this.#options.statusPath), { recursive: true });
    // The status file is POLLED — by §13 scenario 6 every few milliseconds and
    // by `argus status` whenever a human asks — so it is written temp-then-
    // rename like every other polled surface in Argus. A plain write truncates
    // first, and a reader that lands in that window gets a torn file.
    const temporary = `${this.#options.statusPath}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await Bun.write(temporary, `${JSON.stringify(status, null, 2)}\n`);
      await rename(temporary, this.#options.statusPath);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  async #restartAfterExit(
    key: string,
    child: { eye: EyeName; process: WatcherProcess; repo: string },
    exitCode: number,
  ): Promise<void> {
    if (this.#children.get(key)?.process !== child.process) return;
    this.#children.delete(key);
    await this.#writeStatus();
    if (this.#stopping) return;

    const now = this.#now();
    const windowMilliseconds = this.#restartWindowMilliseconds();
    const state = this.#restarts.get(key) ?? {
      braked: false,
      nextSpawnAt: 0,
      restarts: [],
    };
    state.restarts = state.restarts.filter((at) => now - at < windowMilliseconds);
    const limit = this.#restartLimit();
    if (state.restarts.length >= limit) {
      state.braked = true;
      state.nextSpawnAt = state.restarts[0]! + windowMilliseconds;
      this.#restarts.set(key, state);
      console.error(
        `argus supervisor: ${child.eye} watcher pid ${child.process.pid} for ${child.repo} exited with code ${exitCode}; restart limit reached; giving up for ${Math.max(0, state.nextSpawnAt - now)}ms`,
      );
      return;
    }

    const attempt = state.restarts.length + 1;
    state.restarts.push(now);
    const baseDelay = this.#options.restartDelayMilliseconds ?? 1_000;
    const maxDelay = this.#options.restartMaxDelayMilliseconds ?? 60_000;
    const delay = Math.min(baseDelay * 2 ** (attempt - 1), maxDelay);
    state.nextSpawnAt = now + delay;
    this.#restarts.set(key, state);
    console.error(
      `argus supervisor: ${child.eye} watcher pid ${child.process.pid} for ${child.repo} exited with code ${exitCode}; restart ${attempt}/${limit} in ${delay}ms`,
    );
    await (this.#options.sleep ?? Bun.sleep)(delay);
    await this.reconcile();
  }
}
