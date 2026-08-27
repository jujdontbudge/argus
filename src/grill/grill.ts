/**
 * `startGrill` — SPEC §7.2, the HITL grill flow (ticket #62).
 *
 * §7.2 in order, and this function is that order:
 *
 *   1. Johan tells Hermes "grill X for repo R."
 *   2. Hermes REGISTERS THE DEPLOYMENT, opens a cmux TAB in R's existing
 *      workspace, spawns Claude Code with the grill skill, and NOTIFIES JOHAN
 *      TO ATTACH. (#95 amended §7.2 from "creates a cmux workspace"; see
 *      `../deploy/tab.ts` for why the SPEC changed rather than the directive.)
 *   3. Johan answers in the terminal directly.
 *
 * AUDIT.md §4 item 9 is why this exists: "§7.2 and v1's planning entry point
 * do not exist even after worker deployment." Everything #55 built dispatches
 * work AT an agent; this is the one flow that opens a session FOR Johan.
 *
 * WHAT MAKES IT DIFFERENT, AND WHAT MUST NOT BE.
 *
 * Different: the session is a terminal Johan types into, so it is launched by
 * typing into a cmux workspace rather than forked as a child of this process
 * (`./launch.ts` has the whole argument); it runs in the repo's own checkout
 * rather than a worktree, because a spec stranded on an unmerged branch is not
 * a spec (§7.2's "in R"); and it carries no ticket, because
 * §7.5 exempts planning and grilling.
 *
 * NOT different, and deliberately so:
 *
 * - **The ordering is `deployWorker`'s.** worktree/checkout → registry row
 *   (fsync) → start. This module does not spawn around the primitive; it
 *   passes it a `spawn` that types instead of forking, so the row is durable
 *   before the first keystroke by exactly the same code that guarantees it for
 *   AFK dispatch. A grill is the session most likely to be typed into by a
 *   human, so it is the last place to relax rule 1.
 * - **The delivery guard is `sendWithCmux`'s.** `./launch.ts` builds its
 *   sender with `createCmuxSend`, which is #7's resolve-guard itself. On cmux
 *   0.62.2 an unresolvable handle exits 0 and acts on the FOCUSED workspace —
 *   the failure that once put a stray line into Johan's live session — and a
 *   grill launch line is a shell command, so it would have RUN there.
 * - **No cmux tab, no grill.** Refused, before anything is written. §7.2
 *   step 3 is the point of the flow, and a headless fallback would be a
 *   planning session with nobody able to answer it. This is not the
 *   cmux-hooks dependency §3 forbids: `cmux hooks setup` is a RESUME
 *   convenience that does not exist on 0.62.2 and is never invoked here or
 *   anywhere below here. `new-surface`, `close-surface`, `tree`, `send`,
 *   `send-key` and `notify` all ship in 0.62.2 and are all this flow uses.
 *   `new-workspace` ships too, and #95 forbids it (R6).
 *
 * THE ONE THING THAT CANNOT HAPPEN. An Argus-injected prompt must never
 * classify as Johan — that is scenario 4's poisoning path with Argus itself as
 * the poisoner, and USER.md is downstream of it. Both injected texts on this
 * path are covered by the registry: the opening prompt is the row's
 * `dispatchPrompt` (§5 rule 1 → `hermes`/`dispatch-prompt`) and every
 * follow-up goes through `sendToWorker` (§5 rule 2 → `hermes`/`registry-send`).
 * `grill.test.ts` asserts both against the real classifier, with a line Johan
 * types into the same session as the control.
 */
import {
  deployWorker,
  openWorkerTab,
  type GitRun,
} from "../deploy";
import { runCmux, type CmuxRun } from "../events";
import { CLAUDE_GRILL_ROUTE } from "./route.ts";
import { createCmuxLaunch } from "./launch.ts";
import { resolveGrillDispatch } from "./dispatch.ts";
import { grillPrompt } from "./prompt.ts";
import { type GrillMode } from "./skills.ts";

export interface GrillRequest {
  /** SPEC §7.2's "repo R": the repo the grill is about and runs in. */
  repo: string;
  /** SPEC §7.2's "X": what Johan wants to be grilled about. */
  topic: string;
  /** Which planning skill to route to; SPEC §1's table. Default `grilling`. */
  mode?: GrillMode;
  model?: string;
  /**
   * Override the `claude` executable. Named because PATH is not trustworthy
   * for `claude` on this machine: several wrappers sit ahead of the native
   * install (#41), one of which #36 measured hanging without an assistant turn.
   */
  executable?: string;
}

export interface GrillOptions {
  /** The one cmux seam: workspace creation, the launch send, the notify. */
  cmux?: CmuxRun;
  /**
   * The `installed_plugins.json` the routed skill is resolved against (#97).
   * Defaults to this machine's. Named so a test can describe a machine instead
   * of reading the developer's real plugin cache, which passes or fails for
   * reasons that have nothing to do with this repo.
   */
  manifestFile?: string;
  env?: Readonly<Record<string, string | undefined>>;
  git?: GitRun;
  newSessionId?: () => string;
  now?: () => Date;
}

export type GrillResult =
  | {
      status: "started";
      sessionId: string;
      workspace: string;
      /** The registry's copy of the opening prompt, byte for byte. */
      prompt: string;
      skill: string;
      /** What to tell Johan, whether or not the notification got through. */
      attach: string;
      notified: boolean;
      /** Everything that went wrong without stopping the grill (ADR-0001). */
      degraded: string[];
    }
  /** Nothing was written and nothing was typed. */
  | { status: "refused"; reason: string }
  /**
   * The deployment row is durable but the session never started. Loud on
   * purpose: #55's rule is that a row is never retracted, and the classifier's
   * `dispatch-expired` audit is the standing answer to a prompt that never
   * lands.
   */
  | { status: "failed"; reason: string; sessionId?: string; workspace: string };

export async function startGrill(
  request: GrillRequest,
  options: GrillOptions = {},
): Promise<GrillResult> {
  const cmux = options.cmux ?? runCmux;

  // 0. CAN THIS MODE WORK AT ALL? (#97) Before the tab, before the row, before
  //    the prompt exists — because the failure being refused here is not a
  //    crash, it is a session that starts, cannot honour its first sentence,
  //    and does something adjacent instead. #89 measured two modes in that
  //    state on this machine. A refusal that names the mode, the id and the
  //    reason is the only outcome an operator can act on; starting anyway is
  //    the silent wrong answer.
  const dispatch = await resolveGrillDispatch(
    request.repo,
    request.mode ?? "grilling",
    options.manifestFile,
  );
  if (dispatch.status === "refused") {
    return {
      reason: `${dispatch.reason}; nothing was registered and no cmux tab was opened`,
      status: "refused",
    };
  }
  const resolved = dispatch.invocation;
  const prompt = grillPrompt({ invocation: resolved, topic: request.topic });
  // Minted here rather than inside `deployWorker` so a deployment that fails
  // AFTER the row is durable can name the session it left behind. A row is
  // never retracted (#55), so naming it is the only way the operator can find
  // the `dispatch-expired` audit it is about to produce.
  const sessionId = (options.newSessionId ?? crypto.randomUUID.bind(crypto))();

  // 1. The TAB FIRST, and refused if it does not resolve — before any row
  //    exists. §7.2 has no headless shape to degrade into, and #7's hazard
  //    means an unresolved handle is not a weaker grill, it is a shell command
  //    in whichever session Johan happens to be looking at.
  //
  //    #95: a tab in the workspace Argus is already running in for R, never a
  //    new workspace. `checkout: "repo"` below is what still makes it "in R".
  const workspace = await openWorkerTab(
    { title: "argus grill", ...(options.env !== undefined && { env: options.env }) },
    cmux,
  );
  if (workspace.status === "degraded") {
    return {
      reason:
        `no cmux tab for the grill (${workspace.reason}); §7.2 is a session ` +
        "Johan attaches to, so there is nothing to degrade into and nothing was registered",
      status: "refused",
    };
  }

  // 2. `deployWorker` owns the rest of the ordering: checkout → row (fsync) →
  //    start. The only thing swapped out is HOW the session starts.
  const deployment = await deployWorker(
    {
      agent: "claude",
      checkout: "repo",
      dispatchPrompt: prompt,
      repo: request.repo,
      route: CLAUDE_GRILL_ROUTE,
      surfaceRef: workspace.surface,
      workspaceRef: workspace.workspace,
      ...(request.executable !== undefined && { executable: request.executable }),
      ...(request.model !== undefined && { model: request.model }),
    },
    {
      cmux,
      spawn: createCmuxLaunch({
        cmux,
        surface: workspace.surface,
        workspace: workspace.workspace,
      }),
      ...(options.env !== undefined && { env: options.env }),
      ...(options.git !== undefined && { git: options.git }),
      newSessionId: () => sessionId,
      ...(options.now !== undefined && { now: options.now }),
    },
  );

  if (deployment.status === "failed") {
    // The tab stays. Argus opened it, so Argus could close it — but a shell
    // Johan may already be looking at is not something to close on a failure
    // path, and the handle is more useful in the error than gone. Nothing was
    // created that Johan has to clean up: the WORKSPACE is his and untouched.
    return {
      reason: `${deployment.reason} (stage: ${deployment.stage}); cmux ${workspace.workspace} was left in place`,
      status: "failed",
      workspace: workspace.workspace,
      // Only from the spawn stage on: before that no row was written, and
      // naming a session that was never registered would be a lie in the
      // opposite direction.
      ...(deployment.stage === "spawn" && { sessionId }),
    };
  }

  const attach = attachLine(request, resolved.skill, workspace.surface);

  // 3. "…and notifies Johan to attach." Best-effort by construction: the
  //    session is already live and attachable, so a notifier that fails
  //    degrades loudly rather than turning a started grill into a failed one.
  const degraded: string[] = [];
  const notified = await notifyAttach(cmux, {
    body: attach,
    repo: request.repo,
    workspace: workspace.workspace,
  });
  if (notified !== true) degraded.push(notified);

  return {
    attach,
    degraded,
    notified: notified === true,
    prompt,
    sessionId,
    skill: resolved.skill,
    status: "started",
    workspace: workspace.workspace,
  };
}

/**
 * #95: this names the TAB, not the workspace.
 *
 * Before #95 the grill got a workspace of its own, so naming the workspace
 * told Johan exactly where the session was. Its tab now sits in the workspace
 * he already has open, beside the dispatcher and every other worker — so
 * "attach to <workspace>" would point him at a workspace he is very possibly
 * already looking at and leave him hunting for which tab. The surface is the
 * only handle that identifies the session now.
 */
function attachLine(request: GrillRequest, skill: string, surface: string): string {
  return (
    `Grill ready in cmux ${surface} (${skill}): ${collapse(request.topic)} — ` +
    `attach and answer in the terminal`
  );
}

/**
 * `cmux notify` exists on 0.62.2, and this is the whole of Argus' use of it.
 *
 * It is NOT a registry-logged send, and must not become one. §5 rule 2 governs
 * text that lands in a session's transcript and could otherwise masquerade as
 * Johan; a notification lands in Notification Centre, is never a prompt, and
 * has no transcript to be misattributed in. Logging it would create a Hermes
 * attribution the matcher could never resolve.
 *
 * The body is forced to ONE line: cmux 0.62.2 truncates a notification body at
 * the first newline and still exits 0, so a multi-line body reaches Johan
 * gutted while reporting success.
 */
async function notifyAttach(
  cmux: CmuxRun,
  input: { body: string; repo: string; workspace: string },
): Promise<true | string> {
  try {
    const result = await cmux([
      "notify",
      "--title",
      "Argus grill ready",
      "--subtitle",
      collapse(input.repo),
      "--body",
      collapse(input.body),
      "--workspace",
      input.workspace,
    ]);
    if (result.exitCode === 0) return true;
    return (
      result.stderr.trim() ||
      `cmux notify exited ${result.exitCode}; the grill is live and unannounced`
    );
  } catch (error) {
    return `cmux notify could not run: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

const collapse = (text: string): string => text.replace(/\s+/g, " ").trim();
