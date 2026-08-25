import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createSandbox } from "../../src/harness/index.ts";
import { createWatcherSpawner } from "../../src/supervisor/daemon.ts";
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
  spawn: createWatcherSpawner(
    [process.execPath, join(checkout, "src", "cli.ts")],
    sandbox.env,
  ),
  statusPath,
});
const controller = new AbortController();
const pids = new Set<number>();
const byEye = new Map(EYE_NAMES.map((eye) => [eye, new Set<number>()]));
const startedAt = Date.now();
let samples = 0;
let parseFailures = 0;

try {
  const running = supervisor.run(controller.signal, 50);
  while (Date.now() - startedAt < 3_000) {
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
