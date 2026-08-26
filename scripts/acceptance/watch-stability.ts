import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createSandbox,
  createSandboxWatcherSpawner,
  LIVE_WATCHER_FLEET_LOCK_PATH,
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
  fleetLockPath: LIVE_WATCHER_FLEET_LOCK_PATH,
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
const configuredObservation = Number(Bun.env.ARGUS_WATCH_STABILITY_MS);
const configuredWarmup = Number(Bun.env.ARGUS_WATCH_STABILITY_WARMUP_MS);
const observationMilliseconds = smoke
  ? 350
  : Number.isSafeInteger(configuredObservation) && configuredObservation > 0
    ? configuredObservation
    : 3_000;
const warmupMilliseconds =
  !smoke && Number.isSafeInteger(configuredWarmup) && configuredWarmup > 0
    ? configuredWarmup
    : 0;
let samples = 0;
let parseFailures = 0;
let firstSampleAt: number | null = null;
let firstStatus: SupervisorStatus | null = null;
let firstRssKiB: Record<string, number> | null = null;

async function rssKiB(pid: number): Promise<number> {
  const child = Bun.spawn(["/bin/ps", "-o", "rss=", "-p", String(pid)], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
  ]);
  if (exitCode !== 0) return 0;
  return Number(stdout.trim()) || 0;
}

async function rssByEye(
  status: SupervisorStatus | null,
): Promise<Record<string, number>> {
  if (status === null) return {};
  return Object.fromEntries(
    await Promise.all(
      status.watchers.map(async ({ eye, pid }) => [eye, await rssKiB(pid)]),
    ),
  );
}

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
      if (
        firstStatus === null &&
        Date.now() - startedAt >= warmupMilliseconds &&
        status.watchers.length === EYE_NAMES.length
      ) {
        firstStatus = status;
        firstSampleAt = Date.now();
        firstRssKiB = await rssByEye(status);
      }
    } catch {
      parseFailures += 1;
    }
  }
  const finalStatus = (await Bun.file(statusPath).json()) as SupervisorStatus;
  const rssStartKiB = firstRssKiB ?? {};
  const rssEndKiB = await rssByEye(finalStatus);
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
        rssSampleGapMs:
          firstSampleAt === null ? 0 : Date.now() - firstSampleAt,
        rssStartKiB,
        rssEndKiB,
        rssGrowthKiB: Object.fromEntries(
          EYE_NAMES.map((eye) => [
            eye,
            (rssEndKiB[eye] ?? 0) - (rssStartKiB[eye] ?? 0),
          ]),
        ),
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
