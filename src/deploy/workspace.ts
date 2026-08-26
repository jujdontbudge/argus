/**
 * The OPTIONAL cmux workspace for a deployed worker (SPEC §3 as amended by #7).
 *
 * cmux on this machine is 0.62.2 permanently. Two consequences shape this
 * whole module:
 *
 * 1. **A workspace is context, never a requirement.** Every failure here
 *    degrades to "no workspace" and the deployment proceeds. Nothing in the
 *    dispatch path blocks on cmux.
 * 2. **A handle Argus has not resolved is never used.** 0.62.2's
 *    `new-workspace` prints no ref, and #7 measured that an unresolvable
 *    handle exits 0 and acts on the FOCUSED workspace — so guessing a ref
 *    would type into whatever Johan happens to be looking at. The ref is
 *    therefore *discovered*: list before, create, list after, and accept the
 *    result only when exactly one new ref appeared. Anything else — no new
 *    ref, several new refs (a concurrent create), a failing cmux, no cmux at
 *    all — degrades. `sendToWorker` re-resolves through #7's guard before it
 *    types anything, so a stale ref cannot survive to a keystroke either.
 */
import { listedRefs, runCmux, type CmuxRun } from "../events";

export type WorkspaceResult =
  | { status: "created"; workspace: string }
  | { status: "degraded"; reason: string };

export interface WorkspaceRequest {
  cwd: string;
}

export async function createCmuxWorkspace(
  request: WorkspaceRequest,
  run: CmuxRun = runCmux,
): Promise<WorkspaceResult> {
  const before = await list(run);
  if (before === null) return degraded("cmux is unavailable; deploying without a workspace");

  let created;
  try {
    created = await run(["new-workspace", "--cwd", request.cwd]);
  } catch (error) {
    return degraded(`cmux new-workspace could not run: ${message(error)}`);
  }
  if (created.exitCode !== 0) {
    return degraded(
      created.stderr.trim() || `cmux new-workspace exited ${created.exitCode}`,
    );
  }

  const after = await list(run);
  if (after === null) return degraded("cmux stopped resolving workspaces after create");
  const fresh = [...after].filter((ref) => !before.has(ref));
  if (fresh.length !== 1) {
    return degraded(
      `cmux 0.62.2 prints no ref for new-workspace and ${fresh.length} new refs appeared; ` +
        "refusing to guess a handle (#7: an unresolvable handle types into the focused workspace)",
    );
  }
  return { status: "created", workspace: fresh[0]! };
}

async function list(run: CmuxRun): Promise<Set<string> | null> {
  try {
    const result = await run(["list-workspaces"]);
    return result.exitCode === 0 ? listedRefs(result.stdout) : null;
  } catch {
    return null;
  }
}

const degraded = (reason: string): WorkspaceResult => ({ reason, status: "degraded" });

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
