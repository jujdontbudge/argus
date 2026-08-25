import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { readEnabledRepos } from "./supervisor/registry.ts";
import { EYE_NAMES, type EyeName } from "./supervisor/runtime.ts";

function isEyeName(value: string | undefined): value is EyeName {
  return EYE_NAMES.some((eye) => eye === value);
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

  console.error(`argus watch ${eye}: watcher composition is unavailable`);
  return 1;
}
