import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  convergeSupervisorJob,
  unloadSupervisorJob,
  type Launchctl,
  type SupervisorJobOptions,
} from "./launchd.ts";
import { disableRepo, readEnabledRepos } from "./registry.ts";
import { EYE_NAMES, type EyeName, type SupervisorStatus } from "./runtime.ts";

interface CommandResult {
  exitCode: number;
  stderr: string;
}

async function command(executable: string, args: string[]): Promise<CommandResult> {
  const child = Bun.spawn([executable, ...args], {
    stderr: "pipe",
    stdout: "ignore",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr };
}

export class CommandLaunchctl implements Launchctl {
  constructor(
    private readonly executable: string,
    private readonly domain: string,
    private readonly label: string,
  ) {}

  async #run(args: string[]): Promise<void> {
    const result = await command(this.executable, args);
    if (result.exitCode !== 0) {
      throw new Error(
        `launchctl ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim()}`,
      );
    }
  }

  bootstrap(plistPath: string): Promise<void> {
    return this.#run(["bootstrap", this.domain, plistPath]);
  }

  bootout(): Promise<void> {
    return this.#run(["bootout", `${this.domain}/${this.label}`]);
  }

  async isLoaded(): Promise<boolean> {
    const result = await command(this.executable, [
      "print",
      `${this.domain}/${this.label}`,
    ]);
    if (result.exitCode === 0) return true;
    if (result.exitCode === 3 || result.exitCode === 113) return false;
    throw new Error(
      `launchctl print failed (${result.exitCode}): ${result.stderr.trim()}`,
    );
  }

  kickstart(): Promise<void> {
    return this.#run(["kickstart", "-k", `${this.domain}/${this.label}`]);
  }
}

export interface SupervisorConfiguration {
  job: SupervisorJobOptions;
  launchctl: Launchctl;
  manageLaunchd: boolean;
}

export function supervisorConfiguration(
  env: Readonly<Record<string, string | undefined>> = process.env,
): SupervisorConfiguration {
  const home = env.HOME;
  if (!home) throw new Error("HOME is not set");
  const label = env.ARGUS_SUPERVISOR_LABEL ?? "dev.argus.supervisor";
  const domain =
    env.ARGUS_LAUNCHD_DOMAIN ?? `gui/${process.getuid?.() ?? 0}`;
  const registryPath = env.ARGUS_REPOS_FILE ?? join(home, ".argus-repos");
  const statusPath =
    env.ARGUS_SUPERVISOR_STATUS_FILE ??
    join(home, "Library", "Caches", "Argus", "supervisor-status.json");
  const plistPath =
    env.ARGUS_SUPERVISOR_PLIST ??
    join(home, "Library", "LaunchAgents", `${label}.plist`);
  const launchctlExecutable = env.ARGUS_LAUNCHCTL ?? "/bin/launchctl";
  const customRegistry = env.ARGUS_REPOS_FILE !== undefined;
  const manageLaunchd =
    env.ARGUS_SUPERVISOR_CONTROL !== "disabled" &&
    (!customRegistry || env.ARGUS_LAUNCHCTL !== undefined);

  return {
    job: {
      bunPath: process.execPath,
      cliPath: fileURLToPath(new URL("../cli.ts", import.meta.url)),
      label,
      plistPath,
      registryPath,
      statusPath,
    },
    launchctl: new CommandLaunchctl(launchctlExecutable, domain, label),
    manageLaunchd,
  };
}

export async function startSupervisor(
  configuration = supervisorConfiguration(),
): Promise<void> {
  if (!configuration.manageLaunchd) return;
  await convergeSupervisorJob(configuration.job, configuration.launchctl);
}

export async function stopRepo(
  repo: string,
  configuration = supervisorConfiguration(),
): Promise<{ remaining: string[]; unloaded: boolean }> {
  const remaining = await disableRepo(configuration.job.registryPath, repo);
  if (!configuration.manageLaunchd) return { remaining, unloaded: false };
  if (remaining.length === 0) {
    return {
      remaining,
      unloaded: await unloadSupervisorJob(configuration.launchctl),
    };
  }
  await convergeSupervisorJob(configuration.job, configuration.launchctl);
  return { remaining, unloaded: false };
}

export interface ProcessStatusRow {
  eye: EyeName;
  pid: number | null;
  repo: string;
  state: "running" | "stopped";
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function cachedStatus(path: string): Promise<SupervisorStatus | null> {
  try {
    return (await Bun.file(path).json()) as SupervisorStatus;
  } catch {
    return null;
  }
}

export async function supervisorStatus(
  configuration = supervisorConfiguration(),
): Promise<ProcessStatusRow[]> {
  const [repos, status] = await Promise.all([
    readEnabledRepos(configuration.job.registryPath),
    cachedStatus(configuration.job.statusPath),
  ]);
  return repos.flatMap((repo) =>
    EYE_NAMES.map((eye) => {
      const watcher = status?.watchers.find(
        (candidate) => candidate.repo === repo && candidate.eye === eye,
      );
      const running = watcher !== undefined && isAlive(watcher.pid);
      return {
        eye,
        pid: running ? watcher.pid : null,
        repo,
        state: running ? "running" : "stopped",
      };
    }),
  );
}

export function formatSupervisorStatus(rows: readonly ProcessStatusRow[]): string {
  const values = [
    ["REPO", "EYE", "STATE", "PID"],
    ...rows.map((row) => [row.repo, row.eye, row.state, row.pid?.toString() ?? "-"]),
  ];
  const widths = values[0]!.map((_, column) =>
    Math.max(...values.map((row) => row[column]!.length)),
  );
  return `${values
    .map((row) =>
      row
        .map((value, column) =>
          column === row.length - 1 ? value : value.padEnd(widths[column]!),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n")}\n`;
}
