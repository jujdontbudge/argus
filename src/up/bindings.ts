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
import { createHash } from "node:crypto";
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
  hermesProfile?: HermesCronRun;
  hermesRoot: string;
  honcho: HonchoClient;
  honchoUrl: string;
  repo: string;
  skillDirectories?: readonly string[];
}

export interface AgentBindingReport {
  cron: "created" | "existing" | "not-configured" | "unavailable" | "updated";
  cronError: string | null;
  honcho: "created" | "existing" | "unavailable";
  honchoError: string | null;
  profile: string;
  /**
   * Whether the profile just written is actually reachable through the name it
   * was written under. "unavailable" means the `hermes` binary could not be
   * run at all, which is not evidence either way.
   */
  profileVerified: "failed" | "ok" | "unavailable";
  profileError: string | null;
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

/**
 * Hermes refuses any profile name that does not match
 * `^[a-z0-9][a-z0-9_-]{0,63}$` (hermes_cli/profiles.py), i.e. 64 characters
 * total. It is a regex bound, not a length check, so the error it produces
 * reads "Invalid profile name" rather than "too long" (#102).
 */
const HERMES_PROFILE_MAX = 64;

/**
 * Bytes of the repo digest kept in a profile name. 16 hex characters = 64 bits.
 *
 * The digest is what keeps two repos with the same basename apart under one
 * HOME (SPEC §13.9), so shortening it is a real trade and not a formatting
 * change. What it has to survive: a user's own repos, on their own disk,
 * colliding by accident. Two repos collide only if they share BOTH the
 * 41-character slug and the 64-bit digest prefix; at a thousand same-basename
 * repos under one HOME that is ~2.7e-14. The input is a local filesystem path
 * the user chose, not attacker-supplied, so collision resistance against a
 * chosen-prefix attack is not the property in play here.
 */
const REPO_DIGEST_LENGTH = 16;

/** `argus-` + slug + `-` + digest must fit HERMES_PROFILE_MAX. */
const REPO_SLUG_LENGTH =
  HERMES_PROFILE_MAX - "argus-".length - 1 - REPO_DIGEST_LENGTH;

function repoIdentity(canonicalRepo: string): string {
  const digest = createHash("sha256")
    .update(canonicalRepo)
    .digest("hex")
    .slice(0, REPO_DIGEST_LENGTH);
  const slug = repoSlug(canonicalRepo).slice(0, REPO_SLUG_LENGTH) || "repo";
  const identity = `argus-${slug}-${digest}`;
  /* c8 ignore start -- arithmetic above makes this unreachable; it is here so
     that a future edit to either constant fails loudly at the write instead of
     silently at some later `hermes profile use`. */
  if (identity.length > HERMES_PROFILE_MAX) {
    throw new Error(
      `argus up: generated profile name ${identity} is ${identity.length} characters, over Hermes' ${HERMES_PROFILE_MAX}-character limit`,
    );
  }
  /* c8 ignore stop */
  return identity;
}

/**
 * The over-long name `argus up` generated before #102: the full 64-hex digest
 * and an 80-character slug, so 72 characters at the shortest. Hermes refuses
 * it, which is why every profile written under this scheme is inert — present
 * on disk, absent from `hermes profile list`, and rejected by
 * `hermes profile use`. Recomputed here only so those profiles can be found
 * and renamed rather than left as a trap for whoever looks next.
 */
function legacyRepoIdentity(canonicalRepo: string): string {
  const digest = createHash("sha256").update(canonicalRepo).digest("hex");
  const slug = repoSlug(canonicalRepo).slice(0, 80) || "repo";
  return `argus-${slug}-${digest}`;
}

/**
 * Rename an inert over-long profile onto the name Hermes will accept.
 *
 * Deleting it was the alternative and it is worse: the directory holds the
 * `memories` symlink plus whatever config.yaml/.env/SOUL.md were copied in, and
 * on an adopted repo it is the only record that a binding was ever made.
 * Leaving it is worse still — that is precisely the trap this ticket describes.
 * We rename only when the profile proves it belongs to this repo by its
 * `memories` symlink, the same ownership proof the legacy-adoption path already
 * relies on; anything else is left untouched and reported, never clobbered.
 */
async function migrateOverlongProfile(
  hermesRoot: string,
  staleName: string,
  freshName: string,
  memoryDirectory: string,
): Promise<void> {
  if (staleName === freshName) return;
  const stale = join(hermesRoot, "profiles", staleName);
  if (!(await exists(stale))) return;
  const owner = await profileOwner(stale, memoryDirectory);
  if (owner.status !== "owned") {
    const detail =
      owner.status === "other"
        ? `it points at ${owner.target}`
        : owner.status === "missing"
          ? "it has no memories symlink to prove ownership"
          : owner.reason;
    throw new Error(
      `argus up: cannot rename the inert profile ${staleName} onto ${freshName}: ${detail}; refusing to touch it`,
    );
  }
  const fresh = join(hermesRoot, "profiles", freshName);
  if (await exists(fresh)) {
    // The usable name is already populated — the stale copy is redundant, and
    // merging two profile directories is not something we can do safely.
    throw new Error(
      `argus up: both ${staleName} and ${freshName} exist under ${hermesRoot}/profiles; remove the inert ${staleName} by hand`,
    );
  }
  await rename(stale, fresh);
}

interface StoredRepoIdentity {
  canonicalRepo: string;
  identity: string;
  profile: string;
  version: 1;
  workspace: string;
}

function storedRepoIdentity(value: unknown, path: string): StoredRepoIdentity {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !("version" in value) ||
    value.version !== 1 ||
    !("canonicalRepo" in value) ||
    typeof value.canonicalRepo !== "string" ||
    !("identity" in value) ||
    typeof value.identity !== "string" ||
    !("workspace" in value) ||
    typeof value.workspace !== "string" ||
    value.workspace === "" ||
    !("profile" in value) ||
    typeof value.profile !== "string" ||
    value.profile === ""
  ) {
    throw new Error(
      `argus up: repo identity at ${path} is invalid; refusing to create a second binding`,
    );
  }
  return value as StoredRepoIdentity;
}

async function configuredWorkspace(path: string): Promise<string | null> {
  if (!(await exists(path))) return null;
  const match = (await readFile(path, "utf8")).match(/^workspace:\s*(\S+)\s*$/m);
  if (!match?.[1]) {
    throw new Error(
      `argus up: existing Honcho binding at ${path} has no workspace; refusing to create a second binding`,
    );
  }
  return match[1];
}

type ProfileOwner =
  | { status: "missing" }
  | { status: "owned" }
  | { status: "other"; target: string }
  | { status: "ambiguous"; reason: string };

async function profileOwner(
  profile: string,
  memoryDirectory: string,
): Promise<ProfileOwner> {
  if (!(await exists(profile))) return { status: "missing" };
  const memories = join(profile, "memories");
  if (!(await exists(memories))) {
    return { reason: `${memories} is missing`, status: "ambiguous" };
  }
  const metadata = await lstat(memories);
  if (!metadata.isSymbolicLink()) {
    return {
      reason: `${memories} is not a symbolic link`,
      status: "ambiguous",
    };
  }
  const target = resolve(dirname(memories), await readlink(memories));
  const [canonicalTarget, canonicalMemory] = await Promise.all([
    realpath(target),
    realpath(memoryDirectory),
  ]);
  return canonicalTarget === canonicalMemory
    ? { status: "owned" }
    : { status: "other", target: canonicalTarget };
}

async function resolveRepoIdentity(
  canonicalRepo: string,
  hermesRoot: string,
): Promise<StoredRepoIdentity> {
  const argusDirectory = join(canonicalRepo, ".argus");
  const identityPath = join(argusDirectory, "identity.json");
  const identity = repoIdentity(canonicalRepo);
  if (await exists(identityPath)) {
    let stored: StoredRepoIdentity;
    try {
      stored = storedRepoIdentity(await Bun.file(identityPath).json(), identityPath);
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error(
          `argus up: repo identity at ${identityPath} is not valid JSON; refusing to create a second binding`,
        );
      }
      throw error;
    }
    if (stored.canonicalRepo !== canonicalRepo) {
      throw new Error(
        `argus up: repo identity at ${identityPath} belongs to ${stored.canonicalRepo}; refusing to create a second binding`,
      );
    }
    if (stored.identity !== identity) {
      // The only identity drift we know how to absorb is #102's: a record
      // written under the over-long scheme, for this same repo. Anything else
      // is a genuine mismatch and still refuses. Without this branch the
      // shortening would turn every previously-adopted repo into a hard
      // "belongs to" error against itself.
      if (stored.identity !== legacyRepoIdentity(canonicalRepo)) {
        throw new Error(
          `argus up: repo identity at ${identityPath} does not match this repo's identity; refusing to create a second binding`,
        );
      }
      await migrateOverlongProfile(
        hermesRoot,
        stored.profile,
        stored.profile === stored.identity ? identity : stored.profile,
        join(argusDirectory, "memory"),
      );
      return {
        ...stored,
        identity,
        // A legacy short profile name (`argus-<slug>`) was always valid and is
        // left alone; only the over-long identity-shaped one is renamed.
        profile: stored.profile === stored.identity ? identity : stored.profile,
        // Honcho workspaces cannot be renamed without abandoning their derived
        // memory, so the workspace id stays whatever it was — the same reason
        // the legacy-adoption path below keeps its own.
        workspace: stored.workspace,
      };
    }
    return stored;
  }

  const legacy = `argus-${repoSlug(canonicalRepo)}`;
  const honchoPath = join(argusDirectory, "honcho.yaml");
  const workspace = await configuredWorkspace(honchoPath);
  const legacyProfile = join(hermesRoot, "profiles", legacy);
  const owner = await profileOwner(
    legacyProfile,
    join(argusDirectory, "memory"),
  );

  if (workspace !== null && workspace !== legacy && workspace !== identity) {
    throw new Error(
      `argus up: existing Honcho workspace ${workspace} does not match this repo's identity; refusing to create a second binding`,
    );
  }

  if (workspace === legacy) {
    // Honcho workspaces cannot be renamed without abandoning their derived
    // memory. The Hermes memory symlink is the ownership proof that lets us
    // adopt both legacy names into the canonical identity record safely.
    if (owner.status !== "owned") {
      const detail =
        owner.status === "other"
          ? `its Hermes profile points to ${owner.target}`
          : owner.status === "missing"
            ? "its Hermes profile is missing"
            : owner.reason;
      throw new Error(
        `argus up: cannot safely migrate legacy binding ${legacy}: ${detail}; refusing to create a second binding`,
      );
    }
    return {
      canonicalRepo,
      identity,
      profile: legacy,
      version: 1,
      workspace: legacy,
    };
  }

  if (workspace === null && owner.status === "owned") {
    return {
      canonicalRepo,
      identity,
      profile: legacy,
      version: 1,
      workspace: legacy,
    };
  }
  if (workspace === null && owner.status === "ambiguous") {
    throw new Error(
      `argus up: cannot safely migrate legacy binding ${legacy}: ${owner.reason}; refusing to create a second binding`,
    );
  }

  // No identity.json, but a past `argus up` may still have left an inert
  // over-long profile behind (the record is written after the profile, so a
  // run that died in between leaves exactly this). Rename it rather than
  // stranding it next to the usable one.
  await migrateOverlongProfile(
    hermesRoot,
    legacyRepoIdentity(canonicalRepo),
    identity,
    join(argusDirectory, "memory"),
  );

  return {
    canonicalRepo,
    identity,
    profile: identity,
    version: 1,
    workspace: identity,
  };
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

function convergeYamlStringList(
  source: string,
  section: string,
  key: string,
  requiredValue: string,
): string {
  const parsed = source.trim() === "" ? {} : Bun.YAML.parse(source);
  const sectionValue =
    typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)[section]
      : undefined;
  const configured =
    typeof sectionValue === "object" && sectionValue !== null
      ? (sectionValue as Record<string, unknown>)[key]
      : undefined;
  const values =
    configured === undefined || configured === null
      ? []
      : typeof configured === "string"
        ? [configured]
        : Array.isArray(configured) &&
            configured.every((value) => typeof value === "string")
          ? configured
          : null;
  if (values === null) {
    throw new Error(
      `argus up: Hermes ${section}.${key} must be a string or list of strings`,
    );
  }
  if (values.includes(requiredValue)) return source;
  const replacement = [...values, requiredValue].map(
    (value) => `    - ${JSON.stringify(value)}`,
  );

  const hadTrailingNewline = source.endsWith("\n");
  const lines = source.length === 0 ? [] : source.split("\n");
  if (hadTrailingNewline) lines.pop();
  const sectionIndex = lines.findIndex(
    (line) => line.trimEnd() === `${section}:`,
  );
  if (sectionIndex === -1) {
    lines.push(`${section}:`, `  ${key}:`, ...replacement);
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
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const keyPattern = new RegExp(`^(\\s+)${escapedKey}\\s*:`);
  const keyIndex = lines.findIndex(
    (line, index) =>
      index > sectionIndex && index < sectionEnd && keyPattern.test(line),
  );
  if (keyIndex === -1) {
    lines.splice(sectionEnd, 0, `  ${key}:`, ...replacement);
    return `${lines.join("\n")}\n`;
  }

  const keyIndent = lines[keyIndex]!.match(keyPattern)![1]!.length;
  let keyEnd = keyIndex + 1;
  while (keyEnd < sectionEnd) {
    const line = lines[keyEnd]!;
    if (line.trim() === "" || line.trimStart().startsWith("#")) {
      keyEnd += 1;
      continue;
    }
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (indent < keyIndent) break;
    if (indent === keyIndent && !line.trimStart().startsWith("-")) break;
    keyEnd += 1;
  }
  lines.splice(keyIndex, keyEnd - keyIndex, `  ${key}:`, ...replacement);
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
  skillDirectories: readonly string[],
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
  const withSkills = skillDirectories.reduce(
    (source, directory) =>
      convergeYamlStringList(source, "skills", "external_dirs", directory),
    withCuratorDisabled,
  );
  if (withSkills !== config) {
    await Bun.write(configPath, withSkills);
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

async function removeHermesCronJob(
  home: string,
  id: string,
  run: HermesCronRun,
): Promise<string | null> {
  try {
    const result = await run(["cron", "remove", id], { HERMES_HOME: home });
    return result.exitCode === 0
      ? null
      : result.stderr.trim() || `hermes cron remove exited ${result.exitCode}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function resumeHermesCronJob(
  home: string,
  id: string,
  run: HermesCronRun,
): Promise<string | null> {
  try {
    const result = await run(["cron", "resume", id], { HERMES_HOME: home });
    return result.exitCode === 0
      ? null
      : result.stderr.trim() || `hermes cron resume exited ${result.exitCode}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function ensureHermesSignalCron(
  cronHome: string,
  repo: string,
  argusCli: string,
  bunExecutable: string,
  run: HermesCronRun,
): Promise<{ status: "created" | "existing" | "unavailable" | "updated"; error: string | null }> {
  const scripts = join(cronHome, "scripts");
  await mkdir(scripts, { recursive: true });
  const script = join(scripts, SIGNAL_CRON_SCRIPT);
  const contents =
    `#!/bin/sh\nexec ${shellQuote(bunExecutable)} ${shellQuote(argusCli)} signals --repo ${shellQuote(repo)}\n`;
  if (!(await exists(script)) || (await readFile(script, "utf8")) !== contents) {
    await Bun.write(script, contents);
  }
  await chmod(script, 0o755);

  const existingJobs = (await storedCronJobs(cronHome)).filter(
    ({ name }) => name === SIGNAL_CRON_NAME,
  );
  const existing = existingJobs.find(
    ({ enabled, schedule_display, script: storedScript, workdir }) =>
      enabled !== false &&
      schedule_display === SIGNAL_CRON_SCHEDULE &&
      storedScript === SIGNAL_CRON_SCRIPT &&
      workdir === repo,
  );

  if (existingJobs.some(({ id }) => typeof id !== "string" || id === "")) {
    return {
      error: `Hermes cron job '${SIGNAL_CRON_NAME}' has no removable id`,
      status: "unavailable",
    };
  }

  const updateTarget = existing ?? existingJobs[0];
  const duplicateJobs = existingJobs.filter((job) => job !== updateTarget);

  if (existing && duplicateJobs.length === 0) {
    return { error: null, status: "existing" };
  }

  if (existing && duplicateJobs.length > 0) {
    for (const duplicate of duplicateJobs) {
      const error = await removeHermesCronJob(
        cronHome,
        duplicate.id as string,
        run,
      );
      if (error !== null) {
        return {
          error,
          status: "unavailable",
        };
      }
    }
    return { error: null, status: "updated" };
  }

  const common = [
    "--name",
    SIGNAL_CRON_NAME,
    "--script",
    SIGNAL_CRON_SCRIPT,
    "--workdir",
    repo,
  ] as const;
  const updating = typeof updateTarget?.id === "string" && updateTarget.id !== "";
  const args = updating
    ? [
        "cron",
        "edit",
        updateTarget!.id as string,
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
    const result = await run(args, { HERMES_HOME: cronHome });
    if (result.exitCode !== 0) {
      return {
        error: result.stderr.trim() || `hermes cron exited ${result.exitCode}`,
        status: "unavailable",
      };
    }
    const staleJobs = updating ? duplicateJobs : [];
    if (updating && updateTarget?.enabled === false) {
      const error = await resumeHermesCronJob(
        cronHome,
        updateTarget.id as string,
        run,
      );
      if (error !== null) {
        return {
          error,
          status: "unavailable",
        };
      }
    }
    for (const stale of staleJobs) {
      const error = await removeHermesCronJob(
        cronHome,
        stale.id as string,
        run,
      );
      if (error !== null) {
        return {
          error,
          status: "unavailable",
        };
      }
    }
    return {
      error: null,
      status:
        updating || duplicateJobs.length > 0 ? "updated" : "created",
    };
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      status: "unavailable",
    };
  }
}

async function removeHermesSignalCronCopies(
  profile: string,
  run: HermesCronRun,
): Promise<{ error: string | null; removed: boolean }> {
  const jobs = (await storedCronJobs(profile)).filter(
    ({ name }) => name === SIGNAL_CRON_NAME,
  );
  for (const job of jobs) {
    if (typeof job.id !== "string" || job.id === "") {
      return {
        error: `Hermes cron job '${SIGNAL_CRON_NAME}' in ${profile} has no removable id`,
        removed: false,
      };
    }
    const error = await removeHermesCronJob(profile, job.id, run);
    if (error !== null) {
      return {
        error,
        removed: false,
      };
    }
  }
  return { error: null, removed: jobs.length > 0 };
}

/**
 * Prove the profile is reachable through the name Argus just wrote.
 *
 * #94 shipped a binding that was written, looked right in the config, and could
 * not be used; #102 is the same shape. The fix for both is the same: assert
 * through the configured path, at write time, rather than trusting that the
 * write succeeded.
 *
 * `hermes profile info` is the probe rather than `hermes profile use`, even
 * though `use` is the command a human hits. Both run the same validator and
 * both reject the over-long name with the same message, but `use` also writes
 * `active_profile` — a sticky, global, cross-repo default. `argus up` in one
 * repo silently repointing the user's default Hermes profile is a side effect
 * we should not trade for a check. `info` additionally 404s on a profile that
 * is absent, so it covers "never written" as well as "unusable name".
 * (`profile show` and `profile describe` were the other candidates and are
 * useless here — neither validates the name, so both succeed on the broken one.)
 *
 * On failure this degrades with a readable reason instead of failing the
 * command, matching #96 and #85. A wrong or missing profile binding does not
 * make the rest of `argus up` wrong, and hard-failing would mean a Hermes
 * version bump could brick adoption entirely. The reason is carried on the
 * report so the caller can surface it — silence is what let this survive.
 */
async function verifyHermesProfile(
  hermesRoot: string,
  profile: string,
  run: HermesCronRun,
): Promise<{ error: string | null; status: AgentBindingReport["profileVerified"] }> {
  let result: HermesCronRunResult;
  try {
    result = await run(["profile", "info", profile], { HERMES_HOME: hermesRoot });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      status: "unavailable",
    };
  }
  if (result.exitCode === 0) return { error: null, status: "ok" };
  const detail = `${result.stderr}${result.stdout}`.trim().split("\n")[0] ?? "";
  return {
    error: `hermes profile info ${profile} exited ${result.exitCode}${detail === "" ? "" : `: ${detail}`}`,
    status: "failed",
  };
}

export async function convergeAgentBindings(
  options: AgentBindingOptions,
): Promise<AgentBindingReport> {
  const canonicalRepo =
    (await resolveArgusRepo(options.repo)) ?? (await realpath(options.repo));
  const argusDirectory = join(canonicalRepo, ".argus");
  await Promise.all(
    ["memory", "skills"].map((name) =>
      mkdir(join(argusDirectory, name), { recursive: true }),
    ),
  );
  const binding = await resolveRepoIdentity(canonicalRepo, options.hermesRoot);
  const { profile, workspace } = binding;
  await ensureHermesProfile(
    options.hermesRoot,
    profile,
    join(argusDirectory, "memory"),
    options.skillDirectories ?? [join(argusDirectory, "skills")],
  );
  await Bun.write(
    join(argusDirectory, "honcho.yaml"),
    honchoBinding(options.honchoUrl, workspace),
  );
  await Bun.write(
    join(argusDirectory, "identity.json"),
    `${JSON.stringify(binding, null, 2)}\n`,
  );

  const verified = await verifyHermesProfile(
    options.hermesRoot,
    profile,
    options.hermesProfile ?? runHermesCron,
  );

  let cron: AgentBindingReport["cron"] = "not-configured";
  let cronError: string | null = null;
  if (options.argusCli !== undefined && options.bunExecutable !== undefined) {
    const result = await ensureHermesSignalCron(
      options.hermesRoot,
      canonicalRepo,
      options.argusCli,
      options.bunExecutable,
      options.hermesCron ?? runHermesCron,
    );
    cron = result.status;
    cronError = result.error;
    if (cronError === null) {
      const profilePath = join(options.hermesRoot, "profiles", profile);
      const retired = await removeHermesSignalCronCopies(
        profilePath,
        options.hermesCron ?? runHermesCron,
      );
      cronError = retired.error;
      if (cronError !== null) {
        cron = "unavailable";
      } else if (cron === "existing" && retired.removed) {
        // A same-name job was removed from the old profile. Report the
        // convergence as an update while preserving the existing/created
        // distinction for the scheduler-home job itself.
        cron = "updated";
      }
    }
  }

  let honcho: AgentBindingReport["honcho"];
  let honchoError: string | null = null;
  try {
    honcho = await options.honcho.ensureWorkspace({
      id: workspace,
      metadata: { repo: canonicalRepo },
    });
    for (const peer of PEERS) {
      await options.honcho.ensurePeer(workspace, peer);
    }
  } catch (error) {
    honcho = "unavailable";
    honchoError = error instanceof Error ? error.message : String(error);
  }

  return {
    cron,
    cronError,
    honcho,
    honchoError,
    profile,
    profileError: verified.error,
    profileVerified: verified.status,
    workspace,
  };
}
