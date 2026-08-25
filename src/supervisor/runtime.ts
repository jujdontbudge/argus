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
  registryPath: string;
  restartDelayMilliseconds?: number;
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

export class WatcherSupervisor {
  readonly #children = new Map<
    string,
    { eye: EyeName; process: WatcherProcess; repo: string }
  >();
  readonly #options: WatcherSupervisorOptions;

  constructor(options: WatcherSupervisorOptions) {
    this.#options = options;
  }

  async reconcile(): Promise<void> {
    const repos = await readEnabledRepos(this.#options.registryPath);
    const desired = new Set(
      repos.flatMap((repo) => EYE_NAMES.map((eye) => watcherKey(repo, eye))),
    );

    for (const [key, child] of this.#children) {
      if (desired.has(key)) continue;
      child.process.kill("SIGTERM");
      this.#children.delete(key);
    }

    for (const repo of repos) {
      for (const eye of EYE_NAMES) {
        const key = watcherKey(repo, eye);
        if (this.#children.has(key)) continue;
        const process = this.#options.spawn({ eye, repo });
        this.#children.set(key, {
          eye,
          process,
          repo,
        });
        void process.exited
          .then(() => this.#restartAfterExit(key, process))
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
    for (const child of this.#children.values()) child.process.kill("SIGTERM");
    this.#children.clear();
    await this.#writeStatus();
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
    process: WatcherProcess,
  ): Promise<void> {
    if (this.#children.get(key)?.process !== process) return;
    this.#children.delete(key);
    await this.#writeStatus();
    await Bun.sleep(this.#options.restartDelayMilliseconds ?? 1_000);
    await this.reconcile();
  }
}
