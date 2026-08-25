import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { readEnabledRepos } from "./supervisor/registry.ts";
import { EYE_NAMES, type EyeName } from "./supervisor/runtime.ts";

interface OpenWatcher {
  readonly resource: unknown;
  close?(): void;
  tick?(): Promise<unknown>;
}

function isEyeName(value: string | undefined): value is EyeName {
  return EYE_NAMES.some((eye) => eye === value);
}

async function openEye(eye: EyeName, repo: string): Promise<OpenWatcher> {
  switch (eye) {
    case "reviewer": {
      const { openReviewer } = await import("./eyes/reviewer/reviewer.ts");
      const resource = await openReviewer(repo);
      return { resource, tick: () => resource.tick() };
    }
    case "digest": {
      const { openDigest } = await import("./eyes/digest/digest.ts");
      const resource = await openDigest(repo);
      return { resource, tick: () => resource.tick() };
    }
    case "retro": {
      const { openRetro } = await import("./eyes/retro/retro.ts");
      const resource = await openRetro(repo);
      return { resource, tick: () => resource.tick() };
    }
    case "archiver": {
      const { openArchiver } = await import("./eyes/archiver/archiver.ts");
      const resource = await openArchiver(repo);
      return { resource, close: () => resource.close() };
    }
    case "honcho": {
      const { openHoncho } = await import("./eyes/honcho/honcho.ts");
      const resource = await openHoncho(repo);
      return { resource };
    }
  }
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function isEnrolled(registryPath: string, repo: string): Promise<boolean> {
  return (await readEnabledRepos(registryPath)).includes(repo);
}

async function runLoop(
  eye: EyeName,
  repo: string,
  registryPath: string,
): Promise<number> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  let watcher: OpenWatcher | undefined;
  const pollMilliseconds = positiveInteger(process.env.ARGUS_WATCH_POLL_MS, 250);
  try {
    while (!controller.signal.aborted) {
      if (!(await isEnrolled(registryPath, repo))) return 0;
      try {
        watcher ??= await openEye(eye, repo);
        await watcher.tick?.();
      } catch (error) {
        console.error(
          `argus watch ${eye}: recoverable error: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await Bun.sleep(pollMilliseconds);
    }
    return 0;
  } finally {
    watcher?.close?.();
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}

export async function runWatcher(args: string[]): Promise<number> {
  const eye = args[0];
  if (!isEyeName(eye)) {
    console.error(
      `argus watch: unknown eye '${eye ?? ""}'; expected one of ${EYE_NAMES.join(", ")}`,
    );
    return 1;
  }

  const repoFlag = args.indexOf("--repo");
  const requestedRepo = repoFlag === -1 ? undefined : args[repoFlag + 1];
  if (!requestedRepo) {
    console.error(`argus watch ${eye}: --repo is required`);
    return 1;
  }

  let repo: string;
  try {
    repo = await realpath(requestedRepo);
  } catch {
    console.error(`argus watch ${eye}: repo does not exist: ${requestedRepo}`);
    return 1;
  }

  const registryPath =
    process.env.ARGUS_REPOS_FILE ??
    (process.env.HOME ? join(process.env.HOME, ".argus-repos") : undefined);
  if (registryPath === undefined) {
    console.error(`argus watch ${eye}: HOME is not set`);
    return 1;
  }
  const enrolled = await readEnabledRepos(registryPath);
  if (!enrolled.includes(repo)) {
    console.error(`argus watch ${eye}: repo is not enrolled: ${repo}`);
    return 1;
  }

  return runLoop(eye, repo, registryPath);
}
