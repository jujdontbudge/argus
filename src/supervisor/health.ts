import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { EyeName } from "./runtime.ts";

export interface EyeHealth {
  backlog: number;
  eye: EyeName;
  lastError: { at: string; message: string } | null;
  lastSuccess: string | null;
  pid: number;
  repo: string;
  updatedAt: string;
}

export function eyeHealthPath(repo: string, eye: EyeName): string {
  return join(repo, ".argus", "eyes", eye, "health.json");
}

export async function readEyeHealth(
  repo: string,
  eye: EyeName,
): Promise<EyeHealth | null> {
  try {
    const health = (await Bun.file(eyeHealthPath(repo, eye)).json()) as EyeHealth;
    return health.repo === repo && health.eye === eye ? health : null;
  } catch {
    return null;
  }
}

export class EyeHealthReporter {
  readonly #path: string;
  #health: EyeHealth;
  #write: Promise<void> = Promise.resolve();

  constructor(repo: string, eye: EyeName) {
    this.#path = eyeHealthPath(repo, eye);
    this.#health = {
      backlog: 0,
      eye,
      lastError: null,
      lastSuccess: null,
      pid: process.pid,
      repo,
      updatedAt: new Date().toISOString(),
    };
  }

  start(): Promise<void> {
    return this.#persist();
  }

  failure(message: string, backlog: number): Promise<void> {
    const at = new Date().toISOString();
    this.#health = {
      ...this.#health,
      backlog,
      lastError: { at, message },
      updatedAt: at,
    };
    return this.#persist();
  }

  success(backlog: number): Promise<void> {
    const at = new Date().toISOString();
    this.#health = {
      ...this.#health,
      backlog,
      lastError: backlog === 0 ? null : this.#health.lastError,
      lastSuccess: at,
      updatedAt: at,
    };
    return this.#persist();
  }

  #persist(): Promise<void> {
    const snapshot = this.#health;
    this.#write = this.#write.then(async () => {
      await mkdir(dirname(this.#path), { recursive: true });
      const temporary = `${this.#path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await Bun.write(temporary, `${JSON.stringify(snapshot, null, 2)}\n`);
        await rename(temporary, this.#path);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    return this.#write;
  }
}
