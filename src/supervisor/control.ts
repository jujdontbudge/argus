import { accessSync, constants } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  convergeSupervisorJob,
  unloadSupervisorJob,
  type Launchctl,
  type SupervisorJobOptions,
} from "./launchd.ts";
import { readEyeHealth } from "./health.ts";
import { disableRepo, readEnabledRepos } from "./registry.ts";
import { EYE_NAMES, type EyeName, type SupervisorStatus } from "./runtime.ts";
import {
  acknowledgeAudit,
  importLegacyOriginAudits,
  readAudits,
  type DurableAudit,
} from "../audits/store.ts";

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

function executablePath(
  name: string,
  override: string | undefined,
  path: string | undefined,
): string {
  if (override !== undefined && override.trim() !== "") return override;
  for (const directory of (path ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Keep searching the installer's explicit PATH.
    }
  }
  return name;
}

function launchdPath(
  envPath: string | undefined,
  executables: readonly string[],
): string {
  const directories = [
    ...executables.filter(isAbsolute).map(dirname),
    ...(envPath ?? "").split(delimiter),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ].filter((value) => value !== "");
  return [...new Set(directories)].join(delimiter);
}

function isWithin(parent: string, child: string): boolean {
  const pathFromParent = relative(resolve(parent), resolve(child));
  return (
    pathFromParent === "" ||
    (!pathFromParent.startsWith("..") && !isAbsolute(pathFromParent))
  );
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
  const logPath =
    env.ARGUS_SUPERVISOR_LOG_FILE ??
    join(home, "Library", "Logs", "Argus", "supervisor.log");
  const launchctlExecutable = env.ARGUS_LAUNCHCTL ?? "/bin/launchctl";
  const customRegistry = env.ARGUS_REPOS_FILE !== undefined;
  const scratchHome = ["/tmp", "/private/tmp", tmpdir()].some((root) =>
    isWithin(root, home),
  );
  const manageLaunchd =
    env.ARGUS_SUPERVISOR_CONTROL !== "disabled" &&
    (!customRegistry || env.ARGUS_LAUNCHCTL !== undefined) &&
    (!scratchHome || env.ARGUS_ALLOW_SCRATCH_LAUNCHD === "1");
  const bunPath = process.execPath;
  const codexPath = executablePath(
    "codex",
    env.ARGUS_CODEX_EXECUTABLE,
    env.PATH,
  );
  const ghPath = executablePath("gh", env.ARGUS_GH_EXECUTABLE, env.PATH);

  return {
    job: {
      bunPath,
      cliPath: fileURLToPath(new URL("../cli.ts", import.meta.url)),
      codexPath,
      ghPath,
      label,
      logPath,
      path: launchdPath(env.PATH, [bunPath, codexPath, ghPath]),
      plistPath,
      restartDelayMilliseconds: env.ARGUS_SUPERVISOR_RESTART_MS ?? "1000",
      restartLimit: env.ARGUS_SUPERVISOR_RESTART_LIMIT ?? "5",
      restartMaxDelayMilliseconds:
        env.ARGUS_SUPERVISOR_RESTART_MAX_MS ?? "60000",
      restartWindowMilliseconds:
        env.ARGUS_SUPERVISOR_RESTART_WINDOW_MS ?? "300000",
      registryPath,
      statusPath,
      watchMaxRssMiB: env.ARGUS_WATCH_MAX_RSS_MB ?? "512",
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
): Promise<{ managed: boolean; remaining: string[]; unloaded: boolean }> {
  const remaining = await disableRepo(configuration.job.registryPath, repo);
  if (!configuration.manageLaunchd) {
    return { managed: false, remaining, unloaded: false };
  }
  if (remaining.length === 0) {
    return {
      managed: true,
      remaining,
      unloaded: await unloadSupervisorJob(configuration.launchctl),
    };
  }
  await convergeSupervisorJob(configuration.job, configuration.launchctl);
  return { managed: true, remaining, unloaded: false };
}

export interface ProcessStatusRow {
  backlog: number | null;
  eye: EyeName;
  lastError: string | null;
  lastSuccess: string | null;
  pid: number | null;
  repo: string;
  state: "degraded" | "running" | "stopped";
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
  return Promise.all(
    repos.flatMap((repo) =>
      EYE_NAMES.map(async (eye) => {
        const watcher = status?.watchers.find(
          (candidate) => candidate.repo === repo && candidate.eye === eye,
        );
        const running = watcher !== undefined && isAlive(watcher.pid);
        const health = running ? await readEyeHealth(repo, eye) : null;
        const currentHealth = health?.pid === watcher?.pid ? health : null;
        const degraded =
          currentHealth?.lastError !== null && currentHealth !== null;
        return {
          backlog: currentHealth?.backlog ?? null,
          eye,
          lastError:
            currentHealth?.lastError === null || currentHealth === null
              ? null
              : `${currentHealth.lastError.at}: ${currentHealth.lastError.message}`,
          lastSuccess: currentHealth?.lastSuccess ?? null,
          pid: running ? watcher.pid : null,
          repo,
          state: !running ? "stopped" : degraded ? "degraded" : "running",
        };
      }),
    ),
  );
}

export async function auditStatus(
  configuration = supervisorConfiguration(),
): Promise<DurableAudit[]> {
  const repos = await readEnabledRepos(configuration.job.registryPath);
  await importLegacyOriginAudits(configuration.job.registryPath, repos);
  return (await Promise.all(repos.map(readAudits)))
    .flat()
    .filter(({ acknowledgedAt }) => acknowledgedAt === null)
    .sort(
      (left, right) =>
        left.repo.localeCompare(right.repo) || left.id.localeCompare(right.id),
    );
}

export async function acknowledgeAuditStatus(
  id: string,
  configuration = supervisorConfiguration(),
): Promise<boolean> {
  const repos = await readEnabledRepos(configuration.job.registryPath);
  return (await Promise.all(repos.map((repo) => acknowledgeAudit(repo, id)))).some(
    Boolean,
  );
}

export function formatSupervisorStatus(
  rows: readonly ProcessStatusRow[],
  audits: readonly DurableAudit[] = [],
): string {
  const values = [
    [
      "REPO",
      "EYE",
      "STATE",
      "PID",
      "LAST SUCCESS",
      "BACKLOG",
      "LAST ERROR",
    ],
    ...rows.map((row) => [
      row.repo,
      row.eye,
      row.state,
      row.pid?.toString() ?? "-",
      row.lastSuccess ?? "-",
      row.backlog?.toString() ?? "-",
      row.lastError?.replaceAll(/\r?\n/g, " \\n ") ?? "-",
    ]),
  ];
  const widths = values[0]!.map((_, column) =>
    Math.max(...values.map((row) => row[column]!.length)),
  );
  const watchers = values
    .map((row) =>
      row
        .map((value, column) =>
          column === row.length - 1 ? value : value.padEnd(widths[column]!),
        )
        .join("  ")
        .trimEnd(),
    )
    .join("\n");
  const durable = audits
    .map(
      ({ details, firstSeenAt, id, repo, sourceEye, type }) =>
        `${id}  ${repo}  ${sourceEye}  ${firstSeenAt}  ${type}  ${JSON.stringify(details)}`,
    )
    .join("\n");
  return `${watchers}\n${
    durable === ""
      ? ""
      : `\nAUDIT ALERTS (acknowledge one with: argus status --ack <id>)\n${durable}\n`
  }`;
}
