import { randomUUID } from "node:crypto";
import { appendFile, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export async function readEnabledRepos(path: string): Promise<string[]> {
  const file = Bun.file(path);
  if (!(await file.exists())) return [];
  return [
    ...new Set(
      (await file.text())
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    ),
  ];
}

async function writeEnabledRepos(path: string, repos: readonly string[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await Bun.write(temporaryPath, repos.length > 0 ? `${repos.join("\n")}\n` : "");
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Retry budget for the registry lock. `argus up` normally holds it for one read
 * and one rename — microseconds — but a full test suite can starve every
 * contender's scheduler for much longer. The deadline is therefore generous
 * enough for load without making a wedged enrollment wait forever; an error
 * still beats a silent lost update.
 */
const LOCK_TIMEOUT_MILLISECONDS = 30_000;
const LOCK_RETRY_MILLISECONDS = 10;

/**
 * Serialize the registry's destructive rewrite across PROCESSES (#117 item 6).
 *
 * Without this, two concurrent `argus up` runs each read the enrolled set, each
 * append their own repo, and each rename their own uniquely-named temp file
 * over the registry. Both renames succeed, so the second one silently erases
 * the first one's enrollment: a repo whose `argus up` printed success has no
 * watchers and never gets any. #117 measured 8 concurrent writers losing 7.
 *
 * `.claude.json.argus.lock` (#111, src/deploy/trust.ts) does NOT cover this —
 * it guards a different file for a different writer, and nothing in `argus up`'s
 * enrollment path goes through it.
 *
 * Stale-lock takeover is by owner-pid liveness, the same rule the fleet lease
 * uses (src/supervisor/runtime.ts). A chaos ticket cannot ship a lock that a
 * SIGKILL'd `argus up` wedges forever.
 */
async function withRegistryLock<T>(path: string, body: () => Promise<T>): Promise<T> {
  const lockPath = `${path}.lock`;
  const token = randomUUID();
  await mkdir(dirname(path), { recursive: true });
  const deadline = performance.now() + LOCK_TIMEOUT_MILLISECONDS;
  while (performance.now() < deadline) {
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(lockPath, "wx", 0o600);
      await handle.writeFile(`${JSON.stringify({ pid: process.pid, token })}\n`);
    } catch (error) {
      await handle?.close().catch(() => {});
      if (errorCode(error) !== "EEXIST") {
        if (handle !== undefined) await rm(lockPath, { force: true }).catch(() => {});
        throw error;
      }
      // Held. Take it over only if the recorded owner is provably gone; a lock
      // file caught between create and write has no pid yet and is left alone.
      let ownerPid: number | null = null;
      let ownerToken: string | null = null;
      try {
        const owner = JSON.parse(await readFile(lockPath, "utf8")) as {
          pid?: unknown;
          token?: unknown;
        };
        if (typeof owner.pid === "number") ownerPid = owner.pid;
        if (typeof owner.token === "string") ownerToken = owner.token;
      } catch {
        ownerPid = null;
        ownerToken = null;
      }
      if (
        ownerPid !== null &&
        ownerToken !== null &&
        !processIsAlive(ownerPid)
      ) {
        // Several contenders can observe the same dead owner. Serialize the
        // reclaim itself, then verify the owner token again before removing
        // anything: another contender may already have reclaimed this lock
        // and installed a new owner in its place.
        const reclaimPath = `${lockPath}.reclaim`;
        let reclaimHandle: Awaited<ReturnType<typeof open>> | undefined;
        try {
          reclaimHandle = await open(reclaimPath, "wx", 0o600);
          let current: { pid?: unknown; token?: unknown } | undefined;
          try {
            current = JSON.parse(await readFile(lockPath, "utf8")) as {
              pid?: unknown;
              token?: unknown;
            };
          } catch {
            current = undefined;
          }
          if (
            current?.pid === ownerPid &&
            current.token === ownerToken &&
            !processIsAlive(ownerPid)
          ) {
            await rm(lockPath, { force: true });
          }
        } catch (reclaimError) {
          if (errorCode(reclaimError) !== "EEXIST") throw reclaimError;
        } finally {
          await reclaimHandle?.close().catch(() => {});
          if (reclaimHandle !== undefined) {
            await rm(reclaimPath, { force: true }).catch(() => {});
          }
        }
        continue;
      }
      await Bun.sleep(LOCK_RETRY_MILLISECONDS);
      continue;
    }
    try {
      return await body();
    } finally {
      await handle.close().catch(() => {});
      // Release only OUR lock: if a stale-takeover already reclaimed it, the
      // file on disk belongs to someone else and must survive.
      try {
        const owner = JSON.parse(await readFile(lockPath, "utf8")) as { token?: unknown };
        if (owner.token === token) await rm(lockPath, { force: true });
      } catch {
        // Already gone, or torn: nothing of ours left to remove.
      }
    }
  }
  throw new Error(
    `argus registry: timed out after ${LOCK_TIMEOUT_MILLISECONDS}ms waiting for ${lockPath}`,
  );
}

export async function enableRepo(path: string, repo: string): Promise<string[]> {
  // Enrollment is an additive operation. Appending one line with O_APPEND is
  // atomic for the short records this registry stores, so concurrent
  // processes cannot overwrite one another's additions. `readEnabledRepos`
  // deduplicates the only harmless consequence — two simultaneous enrollments
  // of the same repo — while disableRepo continues to use the lock for its
  // whole-file rewrite.
  const append = async (): Promise<string[]> => {
    await mkdir(dirname(path), { recursive: true });
    const repos = await readEnabledRepos(path);
    if (!repos.includes(repo)) await appendFile(path, `${repo}\n`);
    return readEnabledRepos(path);
  };
  // A concurrent disableRepo, or a stale lock left by a killed process, means
  // the rewrite lock is already part of this operation. Join it so an
  // enrollment never ignores an active lock and the stale-lock recovery
  // contract remains observable through enableRepo.
  if (await Bun.file(`${path}.lock`).exists()) {
    return withRegistryLock(path, append);
  }
  return append();
}

export async function disableRepo(path: string, repo: string): Promise<string[]> {
  return withRegistryLock(path, async () => {
    const repos = await readEnabledRepos(path);
    const enabled = repos.filter((candidate) => candidate !== repo);
    if (enabled.length !== repos.length) await writeEnabledRepos(path, enabled);
    return enabled;
  });
}
