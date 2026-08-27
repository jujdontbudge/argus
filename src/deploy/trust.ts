/**
 * The first-run trust dialog, answered before it is asked (#96, half 1).
 *
 * #89's third live drive stopped here:
 *
 *   Quick safety check: Is this a project you created or one you trust?
 *   ❯ 1. Yes, I trust this folder   2. No, exit
 *
 * and stayed there — with a durable registry row, five live watchers, and no
 * transcript. It bites the FIRST session in any directory Claude Code has not
 * seen, which is every adopted repo and every ticket worktree.
 *
 * WHAT PRODUCTION DOES: it pre-trusts the directory it is about to run in,
 * in the config file the session will read, before the process is spawned.
 * The contract is Claude Code's own, quoted from the 2.1.246 binary:
 *
 *   "Run Claude Code interactively here once and accept the trust dialog, or
 *    set projects[<dir>].hasTrustDialogAccepted: true in <config file>."
 *
 * and the config file is `$CLAUDE_CONFIG_DIR/.claude.json` when that variable
 * is set, `$HOME/.claude.json` otherwise — probed live against 2.1.246 under a
 * scratch HOME, never against Johan's real config.
 *
 * WHAT WAS REJECTED:
 *   - Answering the modal, the way #89's driver does (`read-screen` until the
 *     prompt appears, then `send-key enter`). It needs a cmux surface, and the
 *     headless routes in `./routes.ts` have none; it is a poll race against a
 *     TUI that renders whatever it likes; and it can only ever answer AFTER
 *     the session is already blocked. It is a harness answer, which is exactly
 *     what the ticket says production must stop borrowing.
 *   - Detect-and-surface only. Half 2 of this ticket already surfaces the
 *     whole CLASS of silent deployments, of which this dialog is one instance.
 *     Surfacing without fixing would leave the first grill in every new
 *     worktree blocked by design.
 *
 * ON THE SEND SEAM (§5 rule 2): this bypasses it, and must. Rule 2 exists so a
 * message that lands in a transcript can be attributed to Hermes rather than
 * to Johan. A config key is not a message: nothing is typed, nothing reaches a
 * transcript, and there is nothing for the classifier to misattribute. It is a
 * precondition of the process — the same kind of thing as `cwd`, `PATH`, or
 * the subscription env — and it is recorded where preconditions are recorded,
 * in the deployment row's own result, not in `sends.jsonl`. #89 measured that
 * the alternative (the menu keystroke) does not reach a transcript either, so
 * neither choice is a rule 2 send; this one at least leaves a durable artifact
 * a human can read afterwards.
 *
 * Trust is best effort, never fatal: a deployment whose pre-trust failed still
 * runs (the directory may be trusted by an ancestor entry — Claude Code walks
 * parents up to the git root), and if it does block, half 2's silent-deployment
 * check is what makes that visible.
 */
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";

export interface TrustOptions {
  env?: Readonly<Record<string, string | undefined>>;
}

export type TrustResult =
  | { configPath: string; project: string; status: "already-trusted" }
  | { configPath: string; project: string; status: "trusted" }
  | { configPath: string; project: string; reason: string; status: "failed" };

/** Where the session Argus is about to spawn will look for its config. */
export function claudeConfigFile(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): string {
  const directory = env.CLAUDE_CONFIG_DIR ?? env.HOME;
  if (directory === undefined || directory === "") {
    throw new Error(
      "neither CLAUDE_CONFIG_DIR nor HOME is set, so there is no config file to pre-trust in",
    );
  }
  return join(directory, ".claude.json");
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const code = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;

interface ConfigVersion {
  mode: number;
  signature: string | null;
}

async function configVersion(configPath: string): Promise<ConfigVersion> {
  try {
    const details = await stat(configPath, { bigint: true });
    return {
      mode: Number(details.mode & 0o777n),
      signature: [
        details.dev,
        details.ino,
        details.size,
        details.mtimeNs,
        details.ctimeNs,
      ].join(":"),
    };
  } catch (error) {
    if (code(error) === "ENOENT") return { mode: 0o600, signature: null };
    throw error;
  }
}

const versionsMatch = (left: ConfigVersion, right: ConfigVersion): boolean =>
  left.signature === right.signature;

const LOCK_RETRIES = 200;
const WRITE_RETRIES = 8;

async function acquireConfigLock(configPath: string): Promise<() => Promise<void>> {
  const lockPath = `${configPath}.argus.lock`;
  for (let attempt = 0; attempt < LOCK_RETRIES; attempt += 1) {
    try {
      const handle = await open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${process.pid} ${randomUUID()}\n`);
      } catch (error) {
        await handle.close().catch(() => {});
        await rm(lockPath, { force: true }).catch(() => {});
        throw error;
      }
      return async () => {
        await handle.close();
        await rm(lockPath, { force: true });
      };
    } catch (error) {
      if (code(error) !== "EEXIST") throw error;
      await Bun.sleep(10);
    }
  }
  throw new Error(`timed out waiting for ${lockPath}`);
}

type ConfigRead =
  | { config: Record<string, unknown>; status: "read"; version: ConfigVersion }
  | { status: "changed" }
  | { reason: string; status: "invalid" };

async function readConfig(configPath: string): Promise<ConfigRead> {
  const before = await configVersion(configPath);
  let text = "{}";
  if (before.signature !== null) {
    try {
      text = await readFile(configPath, "utf8");
    } catch (error) {
      if (code(error) === "ENOENT") return { status: "changed" };
      throw error;
    }
  }
  const after = await configVersion(configPath);
  if (!versionsMatch(before, after)) return { status: "changed" };

  let config: unknown;
  try {
    config = JSON.parse(text);
  } catch (error) {
    return {
      reason: `${configPath} is not readable JSON, so it was left untouched: ${message(error)}`,
      status: "invalid",
    };
  }
  if (typeof config !== "object" || config === null || Array.isArray(config)) {
    return {
      reason: `${configPath} is not a JSON object, so it was left untouched`,
      status: "invalid",
    };
  }
  return { config: config as Record<string, unknown>, status: "read", version: after };
}

/**
 * Mark `directory` trusted for Claude Code. Merges into the existing config —
 * every other project and every unrelated key survives, because this file is
 * the user's, not Argus's. Argus writers serialize on an adjacent lock. Claude
 * Code does not honor that lock, so the version is checked again after the
 * replacement is ready; a changed file is re-read and merged instead of being
 * replaced from a stale snapshot.
 */
export async function trustDirectory(
  directory: string,
  options: TrustOptions = {},
): Promise<TrustResult> {
  const project = resolve(directory);
  let configPath: string;
  try {
    configPath = claudeConfigFile(options.env ?? Bun.env);
  } catch (error) {
    return { configPath: "", project, reason: message(error), status: "failed" };
  }

  let release: (() => Promise<void>) | undefined;
  try {
    await mkdir(dirname(configPath), { recursive: true });
    release = await acquireConfigLock(configPath);

    for (let attempt = 0; attempt < WRITE_RETRIES; attempt += 1) {
      const read = await readConfig(configPath);
      if (read.status === "changed") continue;
      if (read.status === "invalid") {
        return { configPath, project, reason: read.reason, status: "failed" };
      }

      const { config, version } = read;
      const projects =
        typeof config.projects === "object" &&
        config.projects !== null &&
        !Array.isArray(config.projects)
          ? (config.projects as Record<string, Record<string, unknown>>)
          : {};
      const existing = projects[project] ?? {};
      if (existing.hasTrustDialogAccepted === true) {
        return { configPath, project, status: "already-trusted" };
      }

      const next = {
        ...config,
        projects: {
          ...projects,
          [project]: { ...existing, hasTrustDialogAccepted: true },
        },
      };
      const temporary = `${configPath}.argus.${process.pid}.${randomUUID()}.tmp`;
      try {
        await Bun.write(temporary, `${JSON.stringify(next, null, 2)}\n`);
        await chmod(temporary, version.mode);
        if (!versionsMatch(version, await configVersion(configPath))) {
          await rm(temporary, { force: true });
          continue;
        }
        await rename(temporary, configPath);
        return { configPath, project, status: "trusted" };
      } catch (error) {
        await rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
    }
    throw new Error(`${configPath} kept changing during ${WRITE_RETRIES} write attempts`);
  } catch (error) {
    return {
      configPath,
      project,
      reason: `${project} could not be pre-trusted in ${configPath}: ${message(error)}`,
      status: "failed",
    };
  } finally {
    await release?.().catch(() => {});
  }
}
