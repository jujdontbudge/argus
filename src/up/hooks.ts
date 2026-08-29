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

/**
 * Drop Argus's marker comments wherever they sit.
 *
 * The markers are comments, and TOML does not honour comments as scope, so the
 * region between them is not a region the parser agrees exists: a comment-
 * preserving TOML writer is free to append a `[table]` before the trailing
 * marker, and any text-level append lands after it. Argus therefore never
 * deletes a SPAN. It deletes only the marker lines here and, in
 * `removeRootNotify`, the one root-level `notify` assignment it wrote. Foreign
 * keys, tables and comments survive wherever they ended up. The real boundary
 * is the first `[table]` header — a construct the parser does honour — and
 * that is the boundary `removeRootNotify` uses.
 */
function removeManagedNotify(config: string): string {
  return config
    .split(/\r?\n/)
    .filter((line) => {
      const text = line.trim();
      return text !== ARGUS_CODEX_BEGIN && text !== ARGUS_CODEX_END;
    })
    .join("\n");
}

function notifyCommand(config: string): string[] | null {
  if (config.trim() === "") return null;
  const parsed = object(Bun.TOML.parse(config));
  const notify = parsed.notify;
  if (notify === undefined) return null;
  if (!Array.isArray(notify) || !notify.every((part) => typeof part === "string")) {
    throw new Error("argus up: Codex root notify must be an array of strings");
  }
  return notify;
}

function decodeDelegate(command: readonly string[], script: string): string[] | null {
  if (command[1] !== script) return [...command];
  const flag = command.indexOf("--delegate");
  if (flag === -1) return null;
  const encoded = command[flag + 1];
  if (!encoded) throw new Error("argus up: managed Codex notify delegate is missing");
  try {
    const parsed = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || !parsed.every((part) => typeof part === "string")) {
      throw new Error("not a string array");
    }
    return parsed;
  } catch (error) {
    throw new Error(
      `argus up: managed Codex notify delegate is invalid: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
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
  const delegate = decodeDelegate(notifyCommand(existing) ?? [], script);
  const cleaned = removeRootNotify(removeManagedNotify(existing));
  const lines = cleaned.split(/\r?\n/);
  const firstTable = lines.findIndex((line) => /^\s*\[/.test(line));
  const root = (firstTable === -1 ? lines : lines.slice(0, firstTable))
    .join("\n")
    .trimEnd();
  const tables = (firstTable === -1 ? [] : lines.slice(firstTable))
    .join("\n")
    .trim();
  const command = [
    bunExecutable,
    script,
    ...(delegate && delegate.length > 0
      ? ["--delegate", Buffer.from(JSON.stringify(delegate)).toString("base64url")]
      : []),
  ];
  const block = `${ARGUS_CODEX_BEGIN}\nnotify = ${JSON.stringify(command)}\n${ARGUS_CODEX_END}`;
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
