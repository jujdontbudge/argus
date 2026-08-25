import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export interface WatchLease {
  release(): Promise<void>;
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function ownerPid(path: string): Promise<number | null> {
  try {
    const value = (await Bun.file(join(path, "owner.json")).json()) as {
      pid?: unknown;
    };
    return typeof value.pid === "number" ? value.pid : null;
  } catch {
    return null;
  }
}

async function wait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const onAbort = () => resolve();
    signal.addEventListener("abort", onAbort, { once: true });
    void Bun.sleep(milliseconds).then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    });
  });
}

async function moveStaleLease(path: string): Promise<void> {
  const stale = `${path}.stale-${process.pid}-${Date.now()}`;
  try {
    await rename(path, stale);
    await rm(stale, { force: true, recursive: true });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}

/** Atomic one-writer lease, with safe takeover after SIGKILL. */
export async function acquireWatchLease(
  repo: string,
  eye: string,
  signal: AbortSignal,
  pollMilliseconds: number,
): Promise<WatchLease | null> {
  const eyeDirectory = join(repo, ".argus", "eyes", eye);
  const path = join(eyeDirectory, "watch.lock");
  await mkdir(eyeDirectory, { recursive: true });
  let announced = false;
  while (!signal.aborted) {
    try {
      await mkdir(path);
      await Bun.write(
        join(path, "owner.json"),
        `${JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() })}\n`,
      );
      return {
        async release() {
          if ((await ownerPid(path)) !== process.pid) return;
          await moveStaleLease(path);
        },
      };
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
        throw error;
      }
    }

    const owner = await ownerPid(path);
    const missingOwnerIsStale =
      owner === null && Date.now() - (await stat(path)).mtimeMs > 1_000;
    if ((owner !== null && !isAlive(owner)) || missingOwnerIsStale) {
      await moveStaleLease(path);
      continue;
    }
    if (!announced) {
      announced = true;
      console.error(
        `argus watch ${eye}: another watcher owns ${repo}; waiting for its lease`,
      );
    }
    await wait(pollMilliseconds, signal);
  }
  return null;
}
