/**
 * Launching a grill session INTO a cmux workspace (ticket #62).
 *
 * SPEC §7.2 step 3 is "Johan answers in the terminal directly", and that one
 * sentence rules out every spawn shape #55 and #56 use. A `Bun.spawn` child of
 * the CLI has no terminal Johan can attach to; `claude -p` has no turn after
 * the first. The session has to be a real interactive process in a real cmux
 * workspace, which means SOMETHING has to start it there.
 *
 * cmux 0.62.2 offers exactly two ways, and only one of them is legal here:
 *
 * - `cmux new-workspace --cwd <repo> --command <claude …>` starts the session
 *   at workspace-creation time. That is BEFORE the registry row can exist —
 *   the ref does not exist until the create returns, and the row needs the ref
 *   — so it inverts SPEC §5 rule 1 and the opening prompt would land in a
 *   transcript the registry cannot yet explain. Refused.
 * - typing the launch line into the fresh workspace's shell, after the row is
 *   durable. Slower, uglier, and correct.
 *
 * So this module is the second one, and it goes through `createCmuxSend` —
 * #7's resolve-guard, the production seam, not a copy. On 0.62.2 an
 * unresolvable handle exits 0 and acts on the FOCUSED workspace, which once
 * put a stray line into Johan's live session; a launch line is a shell command
 * and would have RUN there.
 *
 * The launch line is deliberately NOT logged to `sends.jsonl`. §5 rule 2 is
 * about sends into a session — text that lands in a transcript and would
 * otherwise masquerade as Johan. This lands in a shell that has no transcript,
 * before the session it starts exists. Logging it would put a Hermes
 * attribution in the matcher's window that nothing can ever match
 * (`send-expired`), and if Johan later typed those same words they would stop
 * being his: the exact phantom `sendToWorker` refuses to create. The prompt
 * the launch line CARRIES is covered by rule 1 instead — it is the row's
 * `dispatchPrompt`, and it classifies `hermes`/`dispatch-prompt` when it
 * lands.
 */
import { mkdtemp, open, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { STRIPPED_ENV, type WorkerProcess, type WorkerSpawn } from "../deploy";
import { decodedShellWord } from "../deploy/cmux-command.ts";
import { createCmuxSend, runCmux, type CmuxRun } from "../events";

/**
 * ANSI-C quoting (`$'…'`), because the launch line must be exactly ONE
 * physical line whose argv still contains real newlines.
 *
 * A dispatch prompt is multi-line. A real newline typed into a terminal
 * submits the line, so single-quoting the prompt would run half of it as a
 * shell command and hand the rest to nothing. Escaping the newlines away
 * instead would change the prompt — and a prompt that differs by one byte from
 * the one in `sessions.jsonl` hashes differently, misses the dispatch match,
 * and classifies as JOHAN. That is the USER.md poisoning path reached through
 * a quoting bug, so the shape here is asserted against a real shell in
 * `launch.test.ts` rather than against a reading of the manual.
 *
 * `$'…'` is understood by both zsh (this machine's default) and bash. Inside
 * it, only backslash and the closing quote are special; `$`, backtick and `!`
 * are literal, so no expansion can reach the prompt's contents.
 */
export const shellQuote = decodedShellWord;

/**
 * `cd … && env -u … claude --session-id … $'…'`, as one line a shell accepts.
 *
 * THE `cd` IS NOT COSMETIC (#89). `WorkerSpawnRequest.cwd` is how every other
 * route puts a session in the right directory — `Bun.spawn` takes it as an
 * argument — and this route is typed into a shell, so it has to become a
 * command or it does not happen. Until #95 it did not need to: the grill got
 * `cmux new-workspace --cwd <repo>`, so the shell was BORN in R. #95 replaced
 * that with `new-surface`, which has no `--cwd` and inherits the workspace's
 * directory, and nothing replaced the cwd. A live drive (#89) then measured
 * the consequence: a grill dispatched for a sandbox repo started a real Claude
 * session in `~/argus` instead, because that is where the host workspace was.
 * Every downstream store is repo-scoped, so all five stayed empty while
 * `startGrill` reported `started` — SPEC §7.2's "a cmux workspace in R" lost
 * its "in R" silently.
 *
 * The `env -u` prefix is SPEC §1 item 7 — "Argus never requires Anthropic API
 * access" — carried onto this path. Every other spawn in the tree gets it from
 * `subscriptionEnv`, which builds the child environment itself; a session
 * launched by typing into Johan's own shell inherits HIS environment instead,
 * so the same three names are unset at the command rather than in a child
 * environment this module does not construct. The list is `STRIPPED_ENV`
 * itself, so the two paths cannot drift apart into "subscription mode
 * everywhere except the grill".
 */
export function launchLine(
  executable: string,
  argv: readonly string[],
  cwd?: string,
): string {
  const unset = STRIPPED_ENV.flatMap((name) => ["-u", name]);
  const command = ["env", ...unset, executable, ...argv.slice(1)]
    .map(decodedShellWord)
    .join(" ");
  if (cwd === undefined) return command;
  // `&&`, never `;`: a `cd` that fails must not leave the session starting in
  // whatever directory the shell happened to be in, which is the whole failure
  // this argument exists to close.
  return `cd ${decodedShellWord(cwd)} && ${command}`;
}

export interface CmuxLaunchOptions {
  /** The resolved workspace the session's tab lives in. */
  workspace: string;
  /**
   * The resolved SURFACE — the grill's own tab (#95).
   *
   * Load-bearing, not a refinement. Before #95 the grill got a brand-new
   * workspace with exactly one surface in it, so aiming a send at the
   * WORKSPACE could only ever hit the session being launched. A tab lives in
   * the workspace Johan already has open, next to the dispatcher and whatever
   * else he is running, and `cmux send --workspace` types into that
   * workspace's SELECTED surface. Aiming at the workspace now would run the
   * launch line — a shell command — in whichever tab happened to be in front.
   * That is #7's hazard reintroduced by the fix for #95, so the target is the
   * surface, and `createCmuxSend` resolves it before it types.
   */
  surface: string;
  /** Fresh short ref used only for terminal input on cmux 0.62.2. */
  inputSurface: string;
  /** Defaults to the production cmux runner; injected in tests. */
  cmux?: CmuxRun;
  /** Bounded launch-script handshake; configurable only to keep failure tests fast. */
  startupTimeoutMs?: number;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function waitForLaunch(path: string, surface: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  while (!(await directoryExists(path))) {
    if (Date.now() - started >= timeoutMs) {
      throw new Error(
        `timed out waiting for grill process to start in cmux surface ${surface} after ${timeoutMs}ms`,
      );
    }
    await Bun.sleep(50);
  }
  // The marker is written immediately before `exec`. Yield one polling interval
  // so the shell can complete that handoff before the caller reports started.
  await Bun.sleep(50);
}

/**
 * A `WorkerSpawn` that types the routed command into a cmux workspace instead
 * of forking a child of this process.
 *
 * The returned `WorkerProcess` is honest about what Argus does and does not
 * own here, because both halves are safety rules rather than conveniences:
 *
 * - `exited` never settles. The session belongs to Johan's terminal and
 *   outlives the command that started it; there is no exit for Argus to
 *   observe, and reporting a fabricated one would tell #57's completion loop
 *   that a live planning session had finished. Nothing on the grill path
 *   awaits it.
 * - `kill()` throws. Argus never kills a process it did not spawn, and it did
 *   not spawn this one — cmux's shell did. `deployWorker` only calls `kill()`
 *   on the `announced` route, which this is not, so the refusal is a
 *   statement rather than a hazard.
 */
export function createCmuxLaunch(options: CmuxLaunchOptions): WorkerSpawn {
  const send = createCmuxSend(options.cmux ?? runCmux);
  return async (request): Promise<WorkerProcess> => {
    // `request.cwd` is the repo `deployWorker` resolved (`checkout: "repo"`
    // for a grill). Dropping it is how #89's drive ran in the wrong repo.
    const line = launchLine(request.executable, request.command, request.cwd);
    const launchDirectory = await mkdtemp(join(tmpdir(), "argus-grill-launch-"));
    const launchFile = join(launchDirectory, "launch.zsh");
    const startedDirectory = join(launchDirectory, "started");
    const launchHandle = await open(launchFile, "wx", 0o600);
    try {
      await launchHandle.writeFile(
        [
          "#!/bin/zsh",
          `/bin/mkdir ${decodedShellWord(startedDirectory)} && ${line}`,
          "",
        ].join("\n"),
        "utf8",
      );
      await launchHandle.sync();
    } finally {
      await launchHandle.close();
    }

    try {
      const delivered = await send({
        surface: options.inputSurface,
        text: `/bin/zsh ${decodedShellWord(launchFile)}`,
        workspace: options.workspace,
      });
      if (!delivered.ok) {
        throw new Error(
          delivered.error ??
            `cmux would not deliver the grill launch line to ${options.surface}`,
        );
      }
      await waitForLaunch(
        startedDirectory,
        options.surface,
        options.startupTimeoutMs ?? 5_000,
      );
    } finally {
      await rm(launchDirectory, { force: true, recursive: true });
    }
    return {
      announcedSessionId: async () => null,
      exited: new Promise<never>(() => {}),
      kill: () => {
        throw new Error(
          "a grill session runs in Johan's terminal; Argus never kills a process it did not spawn",
        );
      },
    };
  };
}
