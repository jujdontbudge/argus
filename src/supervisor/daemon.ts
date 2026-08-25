import { supervisorConfiguration } from "./control.ts";
import {
  WatcherSupervisor,
  type SpawnWatcher,
  type WatcherProcess,
} from "./runtime.ts";

export function createWatcherSpawner(
  commandPrefix: readonly string[],
  env?: Readonly<Record<string, string>>,
): SpawnWatcher {
  return ({ eye, repo }) => {
    const child = Bun.spawn(
      [...commandPrefix, "watch", eye, "--repo", repo],
      {
        cwd: repo,
        ...(env !== undefined && { env }),
        stderr: "ignore",
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
    registryPath: configuration.job.registryPath,
    restartDelayMilliseconds: positiveInteger(
      env.ARGUS_SUPERVISOR_RESTART_MS,
      1_000,
    ),
    spawn: createWatcherSpawner([
      configuration.job.bunPath,
      configuration.job.cliPath,
    ]),
    statusPath: configuration.job.statusPath,
  });

  try {
    await supervisor.run(
      controller.signal,
      positiveInteger(env.ARGUS_SUPERVISOR_POLL_MS, 1_000),
    );
    return 0;
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
  }
}
