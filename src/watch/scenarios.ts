import { realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type { ScenarioHandler, ScenarioRegistry } from "../harness/index.ts";
import { disableRepo } from "../supervisor/registry.ts";

export const watcherUnenrollmentScenario: ScenarioHandler = async ({
  assert,
  sandbox,
}) => {
  const repo = await realpath(sandbox.repo);
  const cursorPath = join(
    repo,
    ".argus",
    "eyes",
    "reviewer",
    "cursors.json",
  );
  await rm(cursorPath, { force: true });
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("../cli.ts", import.meta.url)),
      "watch",
      "reviewer",
      "--repo",
      repo,
    ],
    {
      cwd: repo,
      env: sandbox.env,
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  try {
    for (let attempt = 0; !(await Bun.file(cursorPath).exists()) && attempt < 1_500; attempt += 1) {
      await Bun.sleep(20);
    }
    await disableRepo(sandbox.env.ARGUS_REPOS_FILE!, repo);
    const exitCode = await Promise.race([
      child.exited,
      Bun.sleep(30_000).then(() => null),
    ]);
    assert(
      exitCode === 0,
      "a removed repo made its real watcher exit cleanly",
    );
  } finally {
    child.kill("SIGTERM");
    await child.exited;
  }
};

/** Extend the load-bearing watcher-death slot; never replace its prior halves. */
export function registerWatchScenarios(registry: ScenarioRegistry): void {
  const existing = registry.get(6);
  registry.register(6, async (context) => {
    if (existing !== undefined) await existing(context);
    await watcherUnenrollmentScenario(context);
  });
}
