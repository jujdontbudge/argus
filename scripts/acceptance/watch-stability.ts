import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSandbox,
  createSandboxWatcherSpawner,
} from "../../src/harness/index.ts";
import {
  EYE_NAMES,
  WatcherSupervisor,
  type SupervisorStatus,
} from "../../src/supervisor/runtime.ts";

const checkout = fileURLToPath(new URL("../..", import.meta.url));
const sandbox = await createSandbox({ checkout });
const statusPath = join(sandbox.root, "state", "stability-status.json");
const supervisor = new WatcherSupervisor({
  registryPath: sandbox.env.ARGUS_REPOS_FILE!,
  restartDelayMilliseconds: 25,
  spawn: createSandboxWatcherSpawner(
    [process.execPath, join(checkout, "src", "cli.ts")],
    sandbox,
  ),
  statusPath,
});
const controller = new AbortController();
const pids = new Set<number>();
const byEye = new Map(EYE_NAMES.map((eye) => [eye, new Set<number>()]));
const startedAt = Date.now();
const smoke = Bun.env.ARGUS_ACCEPTANCE_SMOKE === "1";
const observationMilliseconds = smoke ? 350 : 3_000;
let samples = 0;
let parseFailures = 0;

try {
  const running = supervisor.run(controller.signal, 50);
  while (Date.now() - startedAt < observationMilliseconds) {
    await Bun.sleep(10);
    try {
      const status = (await Bun.file(statusPath).json()) as SupervisorStatus;
      samples += 1;
      for (const watcher of status.watchers) {
        pids.add(watcher.pid);
        byEye.get(watcher.eye)!.add(watcher.pid);
      }
    } catch {
      parseFailures += 1;
    }
  }
  controller.abort();
  await running;
  console.log(
    JSON.stringify(
      {
        durationMs: Date.now() - startedAt,
        expectedEyes: EYE_NAMES.length,
        distinctPids: pids.size,
        mode: smoke ? "smoke" : "full",
        pidsByEye: Object.fromEntries(
          [...byEye].map(([eye, values]) => [eye, values.size]),
        ),
        samples,
        parseFailures,
      },
      null,
      2,
    ),
  );
} finally {
  controller.abort();
  await supervisor.stop();
  await sandbox.teardown();
}
