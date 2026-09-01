/**
 * The worker's cmux TAB — SPEC §7.2/§7.3 as amended by #95.
 *
 * This module used to be `workspace.ts` and used to call `new-workspace`. That
 * is the bug #95 exists to remove. #82's live drive left three top-level
 * workspaces on Johan's machine pointing at its sandbox worktrees, an earlier
 * attempt left eight, and Johan closed both sets by hand. The code was not
 * misbehaving: SPEC §7.2 said "creates a cmux workspace in R" and the code did
 * exactly that. Directive 14 / R6 says the opposite and is newer, explicit and
 * about this machine — workers are TABS in the existing argus workspace, never
 * new workspaces, and fully closed when done. #95 resolves it for the
 * directive and amends the SPEC to match, so the two now say one thing.
 *
 * WHAT REPLACES `new-workspace`, measured against the real 0.62.2 CLI:
 *
 *   cmux new-surface [--type <terminal|browser>] [--pane <id|ref>]
 *                    [--workspace <id|ref>] [--url <url>]
 *     "Create a new surface (tab) in a pane."
 *   cmux close-surface [--surface <id|ref>] [--workspace <id|ref>]
 *     "Close a surface. Defaults to the focused surface if none specified."
 *
 * Both exist. So does `close-workspace`, contrary to the ticket's premise —
 * but Argus wants neither: it no longer creates a workspace, so it has none to
 * close, and closing one it did not create is R6's violation pointed the other
 * way.
 *
 * HOW A WORKSPACE IS ADDRESSED, and the reading this took. 0.62.2 exposes NO
 * working directory for a workspace anywhere — not in `list-workspaces`, not
 * in `identify`, not in `tree --json`. There is therefore no way to ask cmux
 * "which workspace is repo R open in", and any answer built on matching
 * workspace TITLES would rot on contact: cmux retitles a workspace from
 * whatever its session is currently doing (a workspace on this machine is
 * titled "◑ Opus 4.8 default model").
 *
 * So Argus does not look one up, and does not create one either. It uses the
 * workspace it is ALREADY RUNNING IN: cmux sets `CMUX_WORKSPACE_ID` in every
 * terminal it owns, and the dispatcher for repo R runs in R's workspace by
 * construction — that is how Johan starts it, and on this machine it is
 * `workspace:1`, titled "argus", holding the `argus-dispatcher` surface. The
 * "one workspace per repo" the directive allows is the one Johan already
 * opened; Argus creates ZERO. When there is no `CMUX_WORKSPACE_ID` — Argus run
 * outside cmux, or under a harness — there is no tab and the deployment
 * proceeds without one. That is #7's standing rule (a workspace is context,
 * never a requirement) and it is now also R6's guarantee, structurally: this
 * module contains no verb that can bring a workspace into existence.
 *
 * WHY EVERY HANDLE IS RE-RESOLVED FIRST. #7 measured that an unresolvable
 * handle on 0.62.2 is not an error — it exits 0 and acts on the FOCUSED
 * workspace. #95 re-measured it read-only and it still holds:
 * `list-pane-surfaces --workspace workspace:9999` exited 0 and answered for
 * the focused workspace. Pointed at `new-surface` that opens the worker's tab
 * in whatever Johan is looking at; pointed at `close-surface` it CLOSES one of
 * Johan's tabs. So both entry points check the handle against cmux's own
 * inventory before they run a verb that changes anything, and refuse when it
 * does not appear.
 *
 * AND WHY THAT CHECK IS NOT THE DEFENCE — #98, which is the correction this
 * docblock needed. Resolve-then-act is NOT ATOMIC. Between the `tree --all`
 * above and the verb below, another session can close the surface just
 * resolved, and #90 watched `identify.focused` walk `surface:2 -> surface:6 ->
 * surface:4` with no action by the driver at all. The window cannot be closed
 * from outside cmux. What CAN be removed is the cost of losing it, and only
 * the handle form removes it: lose the race holding a UUID and the verb exits
 * 1 `not_found` and closes nothing; lose it holding a ref and the verb closes
 * Johan's tab and exits 0.
 *
 * So this module no longer passes the CALLER'S handle to anything. It passes
 * the UUID the resolution PRODUCED — `workspace.id`, `surface.id` — even when
 * the caller supplied a ref, which a hand-written registry row legitimately
 * can (#99). And that is now backstopped rather than merely intended:
 * `refuseCmuxArgs` in `src/events/handles.ts` refuses any state-changing cmux
 * verb carrying a non-UUID handle, inside `runCmux`, which a test proves is
 * the only place in the tree that spawns the binary. A future edit here that
 * reintroduced a ref fails at the gate instead of costing Johan a session.
 *
 * WHY `tree`, and not `list-workspaces`. `list-workspaces` lists "workspaces
 * in the current window" only — on this machine it omits the argus workspace
 * entirely, because the dispatcher's window is not the focused one. A
 * membership check built on it would refuse every legitimate handle and
 * degrade forever. `cmux --id-format both tree --all --json` is the only
 * whole-machine inventory, and it carries UUIDs beside refs, which is what
 * lets a `CMUX_WORKSPACE_ID` (a UUID) be checked at all.
 */
import {
  findWorkspace,
  readCmuxInventory,
  runCmux,
  type CmuxRun,
} from "../events";
import { loadRegistry, registryPaths } from "../provenance";

export type TabResult =
  | { status: "opened"; inputSurface: string; surface: string; workspace: string }
  | { status: "degraded"; reason: string };

export type TabCloseResult =
  | { status: "closed" }
  | { status: "degraded"; reason: string };

export interface TabRequest {
  /**
   * The existing workspace to open the tab in. Defaults to the one Argus is
   * running in (`CMUX_WORKSPACE_ID`). There is no third option: a handle
   * nobody supplied is never invented.
   */
  workspace?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Optional tab title, so Johan can tell three workers apart at a glance. */
  title?: string;
}

export interface TabCloseRequest {
  surface: string;
  workspace: string;
  /**
   * A tab that is already gone counts as closed. Teardown runs from two
   * places — the green path and dead-slot recovery — and the second one must
   * not manufacture a degradation for work the first one already did.
   */
  tolerateMissing?: boolean;
}

export async function openWorkerTab(
  request: TabRequest = {},
  run: CmuxRun = runCmux,
): Promise<TabResult> {
  const env = request.env ?? Bun.env;
  const target = request.workspace ?? env["CMUX_WORKSPACE_ID"];
  if (target === undefined || target === "") {
    return degraded(
      "Argus is not running inside a cmux workspace (no CMUX_WORKSPACE_ID); " +
        "deploying without a tab. R6: Argus never creates a workspace to put one in",
    );
  }

  const before = await readCmuxInventory(run);
  if (before === null) return degraded("cmux is unavailable; deploying without a tab");

  const workspace = findWorkspace(before, target);
  if (workspace === undefined) {
    return degraded(
      `cmux does not resolve ${target}; refusing to open the worker's tab in the ` +
        "focused workspace instead (#7: an unresolvable handle exits 0 and acts on it)",
    );
  }

  // THE HANDLE THAT GETS USED IS THE ONE RESOLUTION PRODUCED, NOT THE ONE THE
  // CALLER SUPPLIED (#98). `findWorkspace` matches a UUID *or* a ref, so
  // `target` may well be `workspace:1`; passing it through would hand a
  // state-changing verb the one handle form measured to fail OPEN. Resolving
  // to `workspace.id` costs nothing and means the guard's OUTPUT is the
  // defence rather than merely its precondition — which matters because the
  // guard can lose its race and the handle form cannot.
  const resolved = workspace.id;
  const held = new Set(workspace.surfaces.flatMap((surface) => [surface.id, surface.ref]));
  let created;
  try {
    created = await run(["new-surface", "--type", "terminal", "--workspace", resolved]);
  } catch (error) {
    return degraded(`cmux new-surface could not run: ${message(error)}`);
  }
  if (created.exitCode !== 0) {
    return degraded(created.stderr.trim() || `cmux new-surface exited ${created.exitCode}`);
  }

  const after = await readCmuxInventory(run);
  if (after === null) return degraded("cmux stopped answering after the tab was created");
  const grown = findWorkspace(after, target);
  if (grown === undefined) {
    return degraded(`cmux stopped resolving ${target} after the tab was created`);
  }
  const fresh = grown.surfaces.filter((surface) => !held.has(surface.id));
  if (fresh.length !== 1) {
    return degraded(
      `cmux 0.62.2 prints no ref for new-surface and ${fresh.length} new surfaces ` +
        "appeared; refusing to guess a handle (#7: an unresolvable handle acts on " +
        "the focused surface)",
    );
  }
  const surface = fresh[0]!;

  if (request.title !== undefined) {
    // Cosmetic, so a failure here is not worth losing a resolved tab over.
    try {
      await run(["rename-tab", "--workspace", resolved, "--surface", surface.id, request.title]);
    } catch {
      /* the tab is open and addressable; its name is not load-bearing */
    }
  }

  // Both handles returned here are UUIDs, and that is load-bearing rather
  // than tidy: this return value is what `deployWorker` writes into
  // `sessions.jsonl`, and that row is what `retireWorkerTab` later reads and
  // hands to `close-surface`. A ref recorded here would be a ref persisted
  // across a cmux restart — after which it means nothing, and a handle that
  // means nothing is #98's redirect.
  return {
    status: "opened",
    inputSurface: surface.ref,
    surface: surface.id,
    workspace: resolved,
  };
}

/**
 * Close the worker's tab. "Fully closed when done" is half of Directive 14 and
 * the half that actually cost Johan time, so this refuses far more readily
 * than it acts: an unresolved surface handle is Johan's focused tab.
 */
export async function closeWorkerTab(
  request: TabCloseRequest,
  run: CmuxRun = runCmux,
): Promise<TabCloseResult> {
  const before = await readCmuxInventory(run);
  if (before === null) return degraded("cmux is unavailable; the worker's tab was left open");

  const workspace = findWorkspace(before, request.workspace);
  if (workspace === undefined) {
    return request.tolerateMissing === true
      ? { status: "closed" }
      : degraded(
          `cmux does not resolve ${request.workspace}; refusing to close the focused ` +
            "surface instead",
        );
  }
  const present = workspace.surfaces.find(
    (surface) => surface.id === request.surface || surface.ref === request.surface,
  );
  if (present === undefined) {
    // Already gone is the expected second call, not a fault.
    return request.tolerateMissing === true
      ? { status: "closed" }
      : degraded(
          `cmux does not resolve ${request.surface} in ${request.workspace}; refusing ` +
            "to close the focused surface instead",
        );
  }

  // #98, and the single most important line in this module: the verb is
  // pointed at the UUIDs the lookup above PRODUCED, never at the strings the
  // caller passed in. The membership test accepts either form — a registry row
  // written by hand can hold `surface:60` — but `close-surface` only ever sees
  // the form that fails CLOSED. If the race is lost between this lookup and
  // this call, cmux answers `not_found`, exit 1, and closes nothing. Handed
  // the ref instead it would have closed whatever Johan is looking at, exit 0.
  // `runCmux` refuses a non-UUID here too; this makes the refusal unreachable
  // on the production path instead of relying on it.
  let closed;
  try {
    closed = await run([
      "close-surface",
      "--surface",
      present.id,
      "--workspace",
      workspace.id,
    ]);
  } catch (error) {
    return degraded(`cmux close-surface could not run: ${message(error)}`);
  }
  if (closed.exitCode !== 0) {
    return degraded(closed.stderr.trim() || `cmux close-surface exited ${closed.exitCode}`);
  }

  // A close that reported success and left the tab standing is the leak this
  // ticket is about, so it is confirmed rather than assumed.
  const after = await readCmuxInventory(run);
  if (after === null) return degraded("cmux stopped answering after the tab was closed");
  const remaining = findWorkspace(after, request.workspace);
  const survived = remaining?.surfaces.some(
    (surface) => surface.id === request.surface || surface.ref === request.surface,
  );
  if (survived === true) {
    return degraded(
      `cmux close-surface exited 0 but ${request.surface} still resolves in ` +
        `${request.workspace}; the tab is leaked and needs a look`,
    );
  }
  return { status: "closed" };
}

const degraded = (reason: string): { reason: string; status: "degraded" } => ({
  reason,
  status: "degraded",
});

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export interface TabRetireRequest {
  /** The repo whose registry holds the row — never the worktree. */
  repo: string;
  sessionId: string;
}

/**
 * Close the tab a deployment left behind. Returns `null` on success (including
 * "there was never a tab" and "it is already gone"), or a reason to surface.
 *
 * REGISTRY-FIRST, because that is the only source both endings can reach.
 * A deployment ends two ways and #95 has to cover both:
 *
 * - CLEANLY, in `completeReadyTickets`' retire step, beside `retireWorktree` —
 *   the worktree and the tab are the two things the deployment brought into
 *   existence, so they go away together, after the merge and the close and
 *   before the slot is released.
 * - BY DYING, in `recoverDeadSlots`. This is the case that matters, because it
 *   is the one #82 actually produced: the worker never reaches a clean
 *   completion and nothing on the green path ever runs. The dispatch slot is
 *   the durable record that a dead deployment existed, recovery already sweeps
 *   it to discard the worktree, and the tab is discarded in the same sweep. A
 *   tab whose deployment died is exactly the leak Johan cleaned by hand.
 *
 * Neither path holds a cmux handle: the slot record does not carry one, and by
 * recovery time the `Deployment` object is long gone with the process. The
 * registry row does carry both, written before the session started (§5 rule
 * 1), so teardown looks the deployment up the same way everything else in the
 * tree does rather than growing a second copy of the handles that could drift.
 *
 * `tolerateMissing` is on for both callers. They can legitimately both run —
 * a dead session can be recovered and later completed — and the second one
 * must not report a leak for work the first one did.
 */
export async function retireWorkerTab(
  request: TabRetireRequest,
  run: CmuxRun = runCmux,
): Promise<string | null> {
  let row;
  try {
    const registry = await loadRegistry(registryPaths(request.repo));
    row = registry.sessions.findLast((session) => session.sessionId === request.sessionId);
  } catch {
    // A registry that cannot be read is a real problem, but it is not THIS
    // function's problem to raise: everything upstream of here already reads
    // it, and a teardown that throws would abort a merge that already landed.
    return null;
  }
  if (row?.workspace === undefined || row.surface === undefined) return null;

  const closed = await closeWorkerTab(
    { surface: row.surface, tolerateMissing: true, workspace: row.workspace },
    run,
  );
  return closed.status === "closed"
    ? null
    : `the worker's cmux tab could not be closed (${closed.reason})`;
}
