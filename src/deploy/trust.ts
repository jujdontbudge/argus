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
import { chmod, mkdir, rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

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

/**
 * Mark `directory` trusted for Claude Code. Merges into the existing config —
 * every other project and every unrelated key survives, because this file is
 * the user's, not Argus's.
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

  const file = Bun.file(configPath);
  let config: Record<string, unknown> = {};
  if (await file.exists()) {
    try {
      config = (await file.json()) as Record<string, unknown>;
    } catch (error) {
      // A config Argus cannot parse is a config Argus must not rewrite: the
      // alternative is replacing a user's whole file with a two-key object.
      return {
        configPath,
        project,
        reason: `${configPath} is not readable JSON, so it was left untouched: ${message(error)}`,
        status: "failed",
      };
    }
    if (typeof config !== "object" || config === null || Array.isArray(config)) {
      return {
        configPath,
        project,
        reason: `${configPath} is not a JSON object, so it was left untouched`,
        status: "failed",
      };
    }
  }

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
    await mkdir(join(configPath, ".."), { recursive: true });
    const mode = await stat(configPath)
      .then(({ mode }) => mode & 0o777)
      .catch(() => 0o600);
    await Bun.write(temporary, `${JSON.stringify(next, null, 2)}\n`);
    await chmod(temporary, mode);
    await rename(temporary, configPath);
  } catch (error) {
    // `force` still throws when the PATH itself is unusable (a parent that is
    // a file, not a directory), and a failed cleanup must not mask the reason.
    await rm(temporary, { force: true }).catch(() => {});
    return {
      configPath,
      project,
      reason: `${project} could not be pre-trusted in ${configPath}: ${message(error)}`,
      status: "failed",
    };
  }
  return { configPath, project, status: "trusted" };
}
