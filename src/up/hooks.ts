import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ARGUS_CLAUDE_MARKER = "ARGUS_HOOK=claude-stop";
const ARGUS_CODEX_BEGIN = "# argus:notify:begin";
const ARGUS_CODEX_END = "# argus:notify:end";

type JsonObject = Record<string, unknown>;

function object(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function readJsonObject(path: string): Promise<JsonObject> {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  try {
    return object(await file.json());
  } catch (error) {
    throw new Error(
      `argus up: could not parse ${path}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function isArgusStopGroup(value: unknown): boolean {
  const group = object(value);
  return Array.isArray(group.hooks) && group.hooks.some((hook) => {
    const command = object(hook).command;
    return typeof command === "string" && command.includes(ARGUS_CLAUDE_MARKER);
  });
}

async function convergeClaudeStop(
  repo: string,
  bunExecutable: string,
  script: string,
): Promise<void> {
  const path = join(repo, ".claude", "settings.local.json");
  const settings = await readJsonObject(path);
  const hooks = object(settings.hooks);
  const stop = Array.isArray(hooks.Stop) ? hooks.Stop : [];
  const command = `env ${ARGUS_CLAUDE_MARKER} ${shellQuote(bunExecutable)} ${shellQuote(script)}`;
  hooks.Stop = [
    ...stop.filter((group) => !isArgusStopGroup(group)),
    {
      hooks: [{ type: "command", command, timeout: 10 }],
    },
  ];
  settings.hooks = hooks;
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, `${JSON.stringify(settings, null, 2)}\n`);
}

function removeManagedNotify(config: string): string {
  const begin = config.indexOf(ARGUS_CODEX_BEGIN);
  if (begin === -1) return config;
  const end = config.indexOf(ARGUS_CODEX_END, begin);
  if (end === -1) {
    throw new Error("argus up: Codex config has an unterminated Argus notify block");
  }
  const after = end + ARGUS_CODEX_END.length;
  return `${config.slice(0, begin)}${config.slice(after).replace(/^\r?\n/, "")}`;
}

/** Remove only a root-level notify assignment; keys inside [profiles] stay put. */
function removeRootNotify(config: string): string {
  const lines = config.split(/\r?\n/);
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const limit = firstTable === -1 ? lines.length : firstTable;
  const kept: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (index >= limit || !/^\s*notify\s*=/.test(line)) {
      kept.push(line);
      continue;
    }
    let brackets = (line.match(/\[/g) ?? []).length - (line.match(/\]/g) ?? []).length;
    while (brackets > 0 && index + 1 < limit) {
      index += 1;
      const continuation = lines[index]!;
      brackets +=
        (continuation.match(/\[/g) ?? []).length -
        (continuation.match(/\]/g) ?? []).length;
    }
  }
  return kept.join("\n");
}

function withCodexNotify(
  existing: string,
  bunExecutable: string,
  script: string,
): string {
  const cleaned = removeRootNotify(removeManagedNotify(existing));
  const lines = cleaned.split(/\r?\n/);
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const root = (firstTable === -1 ? lines : lines.slice(0, firstTable))
    .join("\n")
    .trimEnd();
  const tables = (firstTable === -1 ? [] : lines.slice(firstTable))
    .join("\n")
    .trim();
  const block = `${ARGUS_CODEX_BEGIN}\nnotify = ${JSON.stringify([
    bunExecutable,
    script,
  ])}\n${ARGUS_CODEX_END}`;
  return `${root}${root ? "\n\n" : ""}${block}${tables ? `\n\n${tables}` : ""}\n`;
}

async function convergeCodexNotify(
  codexHome: string,
  bunExecutable: string,
  script: string,
): Promise<void> {
  const path = join(codexHome, "config.toml");
  const file = Bun.file(path);
  const existing = (await file.exists()) ? await file.text() : "";
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, withCodexNotify(existing, bunExecutable, script));
}

export interface PushHookConvergerOptions {
  bunExecutable?: string;
  codexHome: string;
  repo: string;
}

/** Idempotently install both native push adapters for every Argus repo. */
export async function convergePushHooks(
  options: PushHookConvergerOptions,
): Promise<void> {
  const bunExecutable = options.bunExecutable ?? process.execPath;
  const claudeScript = fileURLToPath(
    new URL("../../scripts/claude-stop.ts", import.meta.url),
  );
  const codexScript = fileURLToPath(
    new URL("../../scripts/codex-notify.ts", import.meta.url),
  );
  await Promise.all([
    convergeClaudeStop(options.repo, bunExecutable, claudeScript),
    convergeCodexNotify(options.codexHome, bunExecutable, codexScript),
  ]);
}
