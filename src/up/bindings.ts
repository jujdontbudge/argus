import {
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

export interface HonchoWorkspaceInput {
  id: string;
  metadata: { repo: string };
}

export interface HonchoPeerInput {
  configuration?: { observe_me: false };
  id: "johan" | "claude-code" | "codex" | "hermes";
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

export class HttpHonchoClient implements HonchoClient {
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
    body: HonchoWorkspaceInput | HonchoPeerInput,
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
}

export interface AgentBindingOptions {
  hermesRoot: string;
  honcho: HonchoClient;
  honchoUrl: string;
  repo: string;
}

export interface AgentBindingReport {
  honcho: "created" | "existing" | "unavailable";
  honchoError: string | null;
  profile: string;
  workspace: string;
}

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

function addMissingYamlValues(
  source: string,
  section: string,
  values: Readonly<Record<string, string>>,
): string {
  const hadTrailingNewline = source.endsWith("\n");
  const lines = source.split("\n");
  if (hadTrailingNewline) lines.pop();
  const sectionIndex = lines.findIndex(
    (line) => line.trimEnd() === `${section}:`,
  );

  if (sectionIndex === -1) {
    if (lines.length > 0 && lines.at(-1) !== "") lines.push(`${section}:`);
    else lines.push(`${section}:`);
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
  const sectionLines = lines.slice(sectionIndex + 1, sectionEnd);
  const missing = Object.entries(values).filter(
    ([key]) =>
      !sectionLines.some((line) =>
        new RegExp(`^\\s+${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*:`).test(
          line,
        ),
      ),
  );
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
  const withMemoryLimits = addMissingYamlValues(config, "memory", {
    memory_char_limit: "12000",
    user_char_limit: "6000",
  });
  const withCuratorDisabled = addMissingYamlValues(
    withMemoryLimits,
    "curator",
    { enabled: "false" },
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

export async function convergeAgentBindings(
  options: AgentBindingOptions,
): Promise<AgentBindingReport> {
  const workspace = `argus-${repoSlug(options.repo)}`;
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

  return { honcho, honchoError, profile: workspace, workspace };
}
