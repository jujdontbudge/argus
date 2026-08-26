import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  readFile,
  readlink,
  readdir,
  realpath,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { resolveArgusRepo } from "../events/hooks.ts";

export interface HonchoWorkspaceInput {
  id: string;
  metadata: { repo: string };
}

export interface HonchoPeerInput {
  configuration?: { observe_me: false };
  id: "johan" | "claude-code" | "codex" | "hermes";
}

export type HonchoPeerId = HonchoPeerInput["id"];

export interface HonchoSessionInput {
  id: string;
  metadata: Record<string, string>;
  peers: Record<HonchoPeerId, Record<string, never>>;
}

export interface HonchoMessageInput {
  peer_id: HonchoPeerId;
  content: string;
  metadata: Record<string, string | number | boolean | null>;
}

export interface HonchoClient {
  ensureWorkspace(
    input: HonchoWorkspaceInput,
  ): Promise<"created" | "existing">;
  ensurePeer(
    workspace: string,
    input: HonchoPeerInput,
  ): Promise<"created" | "existing">;
}

/** The same binding client, extended with the watcher-side ingest operations. */
export interface HonchoIngestionClient extends HonchoClient {
  ensureSession(
    workspace: string,
    input: HonchoSessionInput,
  ): Promise<"created" | "existing">;
  createMessages(
    workspace: string,
    session: string,
    messages: readonly HonchoMessageInput[],
  ): Promise<void>;
}

export class HttpHonchoClient implements HonchoIngestionClient {
  readonly #baseUrl: string;

  constructor(
    baseUrl: string,
    private readonly apiKey: string,
    private readonly timeoutMilliseconds = 1_500,
  ) {
    this.#baseUrl = baseUrl.replace(/\/+$/, "");
  }

  async #ensure(
    path: string,
    body: HonchoWorkspaceInput | HonchoPeerInput | HonchoSessionInput,
  ): Promise<"created" | "existing"> {
    const response = await fetch(`${this.#baseUrl}${path}`, {
      body: JSON.stringify(body),
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json",
      },
      method: "POST",
      signal: AbortSignal.timeout(this.timeoutMilliseconds),
    });
    if (response.status === 200) return "existing";
    if (response.status === 201) return "created";
    const detail = (await response.text()).trim();
    throw new Error(
      `Honcho ${response.status}${detail.length > 0 ? `: ${detail}` : ""}`,
    );
  }

  ensureWorkspace(
    input: HonchoWorkspaceInput,
  ): Promise<"created" | "existing"> {
    return this.#ensure("/v3/workspaces", input);
  }

  ensurePeer(
    workspace: string,
    input: HonchoPeerInput,
  ): Promise<"created" | "existing"> {
    return this.#ensure(
      `/v3/workspaces/${encodeURIComponent(workspace)}/peers`,
      input,
    );
  }

  ensureSession(
    workspace: string,
    input: HonchoSessionInput,
  ): Promise<"created" | "existing"> {
    return this.#ensure(
      `/v3/workspaces/${encodeURIComponent(workspace)}/sessions`,
      input,
    );
  }

  async createMessages(
    workspace: string,
    session: string,
    messages: readonly HonchoMessageInput[],
  ): Promise<void> {
    const response = await fetch(
      `${this.#baseUrl}/v3/workspaces/${encodeURIComponent(workspace)}/sessions/${encodeURIComponent(session)}/messages`,
      {
        body: JSON.stringify({ messages }),
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          "content-type": "application/json",
        },
        method: "POST",
        signal: AbortSignal.timeout(this.timeoutMilliseconds),
      },
    );
    if (response.status === 201) return;
    const detail = (await response.text()).trim();
    throw new Error(
      `Honcho ${response.status}${detail.length > 0 ? `: ${detail}` : ""}`,
    );
  }
}

export interface AgentBindingOptions {
  argusCli?: string;
  bunExecutable?: string;
  hermesCron?: HermesCronRun;
  hermesRoot: string;
  honcho: HonchoClient;
  honchoUrl: string;
  repo: string;
}

export interface AgentBindingReport {
  cron: "created" | "existing" | "not-configured" | "unavailable" | "updated";
  cronError: string | null;
  honcho: "created" | "existing" | "unavailable";
  honchoError: string | null;
  profile: string;
  workspace: string;
}

export interface HermesCronRunResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export type HermesCronRun = (
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
) => Promise<HermesCronRunResult>;

export const runHermesCron: HermesCronRun = async (args, env) => {
  const child = Bun.spawn(["hermes", ...args], {
    env: { ...Bun.env, ...env },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
};

const PEERS: readonly HonchoPeerInput[] = [
  { id: "johan" },
  { configuration: { observe_me: false }, id: "claude-code" },
  { configuration: { observe_me: false }, id: "codex" },
  { configuration: { observe_me: false }, id: "hermes" },
];

function repoSlug(repo: string): string {
  return basename(repo)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function honchoBinding(url: string, workspace: string): string {
  return `url: ${url}
workspace: ${workspace}
peers:
  johan:
    observe_me: true
  claude-code:
    observe_me: false
  codex:
    observe_me: false
  hermes:
    observe_me: false
`;
}

function convergeYamlValues(
  source: string,
  section: string,
  values: Readonly<Record<string, string>>,
  shouldReplace: (key: string, currentValue: string) => boolean = () => false,
): string {
  const hadTrailingNewline = source.endsWith("\n");
  const lines = source.length === 0 ? [] : source.split("\n");
  if (hadTrailingNewline) lines.pop();
  const sectionIndex = lines.findIndex(
    (line) => line.trimEnd() === `${section}:`,
  );

  if (sectionIndex === -1) {
    lines.push(`${section}:`);
    for (const [key, value] of Object.entries(values)) {
      lines.push(`  ${key}: ${value}`);
    }
    return `${lines.join("\n")}\n`;
  }

  let sectionEnd = sectionIndex + 1;
  while (
    sectionEnd < lines.length &&
    (lines[sectionEnd]?.trim() === "" ||
      lines[sectionEnd]?.trimStart().startsWith("#") ||
      /^\s/.test(lines[sectionEnd] ?? ""))
  ) {
    sectionEnd += 1;
  }
  const missing: Array<[string, string]> = [];
  for (const [key, value] of Object.entries(values)) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const valuePattern = new RegExp(
      `^(\\s+)${escapedKey}\\s*:\\s*([^#]*?)(?:\\s+#.*)?$`,
    );
    let found = false;
    for (let index = sectionIndex + 1; index < sectionEnd; index += 1) {
      const match = lines[index]?.match(valuePattern);
      if (!match) continue;
      found = true;
      if (shouldReplace(key, match[2]?.trim() ?? "")) {
        lines[index] = `${match[1]}${key}: ${value}`;
      }
      break;
    }
    if (!found) missing.push([key, value]);
  }
  lines.splice(
    sectionEnd,
    0,
    ...missing.map(([key, value]) => `  ${key}: ${value}`),
  );
  return `${lines.join("\n")}\n`;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function availableHermesImportDirectory(
  memoryDirectory: string,
): Promise<string> {
  for (let suffix = 1; ; suffix += 1) {
    const name = suffix === 1 ? "hermes-imported" : `hermes-imported-${suffix}`;
    const candidate = join(memoryDirectory, name);
    if (!(await exists(candidate))) return candidate;
  }
}

async function mergeProfileMemories(
  source: string,
  destination: string,
  importDirectory: string,
  relativePath: string[] = [],
): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourceEntry = join(source, entry.name);
    const destinationEntry = join(destination, entry.name);
    if (!(await exists(destinationEntry))) {
      await rename(sourceEntry, destinationEntry);
      continue;
    }

    const destinationMetadata = await lstat(destinationEntry);
    if (entry.isDirectory() && destinationMetadata.isDirectory()) {
      await mergeProfileMemories(sourceEntry, destinationEntry, importDirectory, [
        ...relativePath,
        entry.name,
      ]);
      await rm(sourceEntry, { recursive: true });
      continue;
    }

    const importedEntry = join(importDirectory, ...relativePath, entry.name);
    await mkdir(dirname(importedEntry), { recursive: true });
    await rename(sourceEntry, importedEntry);
  }
}

async function ensureHermesProfile(
  hermesRoot: string,
  profileName: string,
  memoryDirectory: string,
): Promise<void> {
  const profile = join(hermesRoot, "profiles", profileName);
  await Promise.all([
    mkdir(profile, { recursive: true }),
    mkdir(memoryDirectory, { recursive: true }),
  ]);

  for (const name of ["config.yaml", ".env", "SOUL.md"] as const) {
    const source = join(hermesRoot, name);
    const destination = join(profile, name);
    if (!(await exists(destination)) && (await exists(source))) {
      await copyFile(source, destination);
    }
  }

  const configPath = join(profile, "config.yaml");
  const config = (await exists(configPath))
    ? await readFile(configPath, "utf8")
    : "";
  const memoryLimits = {
    memory_char_limit: "12000",
    user_char_limit: "6000",
  } as const;
  const withMemoryLimits = convergeYamlValues(
    config,
    "memory",
    memoryLimits,
    (key, currentValue) => {
      const current = Number(currentValue);
      return Number.isFinite(current) && current < Number(memoryLimits[key as keyof typeof memoryLimits]);
    },
  );
  const withCuratorDisabled = convergeYamlValues(
    withMemoryLimits,
    "curator",
    { enabled: "false" },
    (_key, currentValue) => currentValue !== "false",
  );
  if (withCuratorDisabled !== config) {
    await Bun.write(configPath, withCuratorDisabled);
  }

  const memories = join(profile, "memories");
  if (await exists(memories)) {
    const metadata = await lstat(memories);
    if (metadata.isSymbolicLink()) {
      const target = resolve(dirname(memories), await readlink(memories));
      if ((await realpath(target)) !== (await realpath(memoryDirectory))) {
        throw new Error(
          `argus up: Hermes memories already points to ${target}; refusing to replace it`,
        );
      }
      return;
    }
    if (!metadata.isDirectory()) {
      throw new Error(
        `argus up: Hermes memories path ${memories} is not a directory`,
      );
    }
    if ((await readdir(memories)).length > 0) {
      await mergeProfileMemories(
        memories,
        memoryDirectory,
        await availableHermesImportDirectory(memoryDirectory),
      );
    }
    await rm(memories, { recursive: true });
    await symlink(memoryDirectory, memories);
  } else {
    await symlink(memoryDirectory, memories);
  }
}

const SIGNAL_CRON_NAME = "argus-signal-poll";
const SIGNAL_CRON_SCHEDULE = "every 5m";
const SIGNAL_CRON_SCRIPT = "argus-signal-poll.sh";
const SIGNAL_CRON_PROMPT =
  "Act on each Argus terminal signal from the script output. Use the repo's " +
  "argus-orchestrator skill; never implement worker tickets yourself.";

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

interface StoredCronJob {
  enabled?: unknown;
  id?: unknown;
  name?: unknown;
  schedule_display?: unknown;
  script?: unknown;
  workdir?: unknown;
}

async function storedCronJobs(profile: string): Promise<StoredCronJob[]> {
  try {
    const value = (await Bun.file(join(profile, "cron", "jobs.json")).json()) as {
      jobs?: unknown;
    };
    return Array.isArray(value.jobs)
      ? value.jobs.filter(
          (job): job is StoredCronJob =>
            typeof job === "object" && job !== null && !Array.isArray(job),
        )
      : [];
  } catch {
    return [];
  }
}

async function ensureHermesSignalCron(
  profile: string,
  repo: string,
  argusCli: string,
  bunExecutable: string,
  run: HermesCronRun,
): Promise<{ status: "created" | "existing" | "unavailable" | "updated"; error: string | null }> {
  const scripts = join(profile, "scripts");
  await mkdir(scripts, { recursive: true });
  const script = join(scripts, SIGNAL_CRON_SCRIPT);
  const contents =
    `#!/bin/sh\nexec ${shellQuote(bunExecutable)} ${shellQuote(argusCli)} signals --repo ${shellQuote(repo)}\n`;
  if (!(await exists(script)) || (await readFile(script, "utf8")) !== contents) {
    await Bun.write(script, contents);
  }
  await chmod(script, 0o755);

  const existing = (await storedCronJobs(profile)).find(
    ({ name }) => name === SIGNAL_CRON_NAME,
  );
  if (
    existing?.enabled !== false &&
    existing?.schedule_display === SIGNAL_CRON_SCHEDULE &&
    existing?.script === SIGNAL_CRON_SCRIPT &&
    existing?.workdir === repo
  ) {
    return { error: null, status: "existing" };
  }

  const common = [
    "--name",
    SIGNAL_CRON_NAME,
    "--script",
    SIGNAL_CRON_SCRIPT,
    "--workdir",
    repo,
  ] as const;
  const updating = typeof existing?.id === "string" && existing.id !== "";
  const args = updating
    ? [
        "cron",
        "edit",
        existing.id as string,
        "--schedule",
        SIGNAL_CRON_SCHEDULE,
        "--prompt",
        SIGNAL_CRON_PROMPT,
        ...common,
        "--agent",
      ]
    : [
        "cron",
        "create",
        SIGNAL_CRON_SCHEDULE,
        SIGNAL_CRON_PROMPT,
        ...common,
      ];
  try {
    const result = await run(args, { HERMES_HOME: profile });
    if (result.exitCode !== 0) {
      return {
        error: result.stderr.trim() || `hermes cron exited ${result.exitCode}`,
        status: "unavailable",
      };
    }
    return { error: null, status: updating ? "updated" : "created" };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      status: "unavailable",
    };
  }
}

export async function convergeAgentBindings(
  options: AgentBindingOptions,
): Promise<AgentBindingReport> {
  const workspace = `argus-${repoSlug(options.repo)}`;
  const canonicalRepo =
    (await resolveArgusRepo(options.repo)) ?? (await realpath(options.repo));
  await mkdir(join(options.repo, ".argus"), { recursive: true });
  await Bun.write(
    join(options.repo, ".argus", "honcho.yaml"),
    honchoBinding(options.honchoUrl, workspace),
  );
  await ensureHermesProfile(
    options.hermesRoot,
    workspace,
    join(options.repo, ".argus", "memory"),
  );

  let cron: AgentBindingReport["cron"] = "not-configured";
  let cronError: string | null = null;
  if (options.argusCli !== undefined && options.bunExecutable !== undefined) {
    const result = await ensureHermesSignalCron(
      join(options.hermesRoot, "profiles", workspace),
      canonicalRepo,
      options.argusCli,
      options.bunExecutable,
      options.hermesCron ?? runHermesCron,
    );
    cron = result.status;
    cronError = result.error;
  }

  let honcho: AgentBindingReport["honcho"];
  let honchoError: string | null = null;
  try {
    honcho = await options.honcho.ensureWorkspace({
      id: workspace,
      metadata: { repo: options.repo },
    });
    for (const peer of PEERS) {
      await options.honcho.ensurePeer(workspace, peer);
    }
  } catch (error) {
    honcho = "unavailable";
    honchoError = error instanceof Error ? error.message : String(error);
  }

  return { cron, cronError, honcho, honchoError, profile: workspace, workspace };
}
