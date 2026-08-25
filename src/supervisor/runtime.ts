import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

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
  kill(signal?: number | string): void;
}

export interface WatcherSpawnRequest {
  eye: EyeName;
  repo: string;
}

export type SpawnWatcher = (request: WatcherSpawnRequest) => WatcherProcess;

export interface WatcherSupervisorOptions {
  registryPath: string;
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

async function enabledRepos(registryPath: string): Promise<string[]> {
  const file = Bun.file(registryPath);
  if (!(await file.exists())) return [];
  return [...new Set((await file.text()).split(/\r?\n/).map((line) => line.trim()).filter(Boolean))];
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
    const repos = await enabledRepos(this.#options.registryPath);
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
        this.#children.set(key, {
          eye,
          process: this.#options.spawn({ eye, repo }),
          repo,
        });
      }
    }

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
    await Bun.write(this.#options.statusPath, `${JSON.stringify(status, null, 2)}\n`);
  }
}
