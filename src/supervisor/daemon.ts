import { supervisorConfiguration } from "./control.ts";
import {
  WatcherSupervisor,
  type SampleWatcherRss,
  type SpawnWatcher,
  type WatcherProcess,
} from "./runtime.ts";

export function createWatcherSpawner(
  commandPrefix: readonly string[],
  env?: Readonly<Record<string, string>>,
  options: { stderr?: "ignore" | "inherit" } = {},
): SpawnWatcher {
  return ({ eye, repo }) => {
    const child = Bun.spawn(
      [...commandPrefix, "watch", eye, "--repo", repo],
      {
        cwd: repo,
        ...(env !== undefined && { env }),
        stderr: options.stderr ?? "inherit",
        stdout: "ignore",
      },
    );
    const process: WatcherProcess = {
      exited: child.exited,
      kill(signal) {
        child.kill(signal);
      },
      pid: child.pid,
    };
    return process;
  };
}

/** One `ps` call samples the whole fleet; values are returned in bytes. */
export const sampleProcessRss: SampleWatcherRss = async (pids) => {
  if (pids.length === 0) return new Map();
  const child = Bun.spawn(
    ["/bin/ps", "-o", "pid=,rss=", "-p", pids.join(",")],
    { stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  // `ps` can return non-zero when every sampled pid exited between reconcile
  // and spawn. An empty result is then accurate, not a supervisor failure.
  if (exitCode !== 0 && stdout.trim() === "") {
    if (stderr.trim() === "") return new Map();
    throw new Error(stderr.trim());
  }
  const readings = new Map<number, number>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    readings.set(Number(match[1]), Number(match[2]) * 1024);
  }
  return readings;
};

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export async function runSupervisorDaemon(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<number> {
  const configuration = supervisorConfiguration(env);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const supervisor = new WatcherSupervisor({
    maxWatcherRssBytes:
      positiveInteger(
        env.ARGUS_SUPERVISOR_WATCH_MAX_RSS_MB ?? env.ARGUS_WATCH_MAX_RSS_MB,
        512,
      ) *
      1024 *
      1024,
    registryPath: configuration.job.registryPath,
    restartDelayMilliseconds: positiveInteger(
      env.ARGUS_SUPERVISOR_RESTART_MS,
      1_000,
    ),
    restartLimit: positiveInteger(env.ARGUS_SUPERVISOR_RESTART_LIMIT, 5),
    restartMaxDelayMilliseconds: positiveInteger(
      env.ARGUS_SUPERVISOR_RESTART_MAX_MS,
      60_000,
    ),
    restartWindowMilliseconds: positiveInteger(
      env.ARGUS_SUPERVISOR_RESTART_WINDOW_MS,
      5 * 60_000,
    ),
    sampleRss: sampleProcessRss,
    spawn: createWatcherSpawner([
      configuration.job.bunPath,
      configuration.job.cliPath,
    ]),
    statusPath: configuration.job.statusPath,
  });

  try {
    await supervisor.run(
      controller.signal,
      positiveInteger(env.ARGUS_SUPERVISOR_POLL_MS, 250),
    );
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
