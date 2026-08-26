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
 * WHY `tree`, and not `list-workspaces`. `list-workspaces` lists "workspaces
 * in the current window" only — on this machine it omits the argus workspace
 * entirely, because the dispatcher's window is not the focused one. A
 * membership check built on it would refuse every legitimate handle and
 * degrade forever. `cmux --id-format both tree --all --json` is the only
 * whole-machine inventory, and it carries UUIDs beside refs, which is what
 * lets a `CMUX_WORKSPACE_ID` (a UUID) be checked at all.
 */
import { runCmux, type CmuxRun } from "../events";

/** One workspace as cmux reports it. Both handles, because callers hold both. */
export interface CmuxWorkspaceNode {
  id: string;
  ref: string;
  title: string;
  surfaces: { id: string; ref: string }[];
}

export interface CmuxInventory {
  workspaces: CmuxWorkspaceNode[];
}

export type TabResult =
  | { status: "opened"; surface: string; workspace: string }
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

/**
 * `cmux --id-format both tree --all --json`, parsed. `null` means cmux could
 * not answer at all, which every caller degrades on rather than guessing.
 */
export async function readCmuxInventory(
  run: CmuxRun = runCmux,
): Promise<CmuxInventory | null> {
  let result;
  try {
    result = await run(["--id-format", "both", "tree", "--all", "--json"]);
  } catch {
    return null;
  }
  if (result.exitCode !== 0) return null;
  try {
    return parseInventory(JSON.parse(result.stdout));
  } catch {
    return null;
  }
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

  const workspace = find(before, target);
  if (workspace === undefined) {
    return degraded(
      `cmux does not resolve ${target}; refusing to open the worker's tab in the ` +
        "focused workspace instead (#7: an unresolvable handle exits 0 and acts on it)",
    );
  }

  const held = new Set(workspace.surfaces.flatMap((surface) => [surface.id, surface.ref]));
  let created;
  try {
    created = await run(["new-surface", "--type", "terminal", "--workspace", target]);
  } catch (error) {
    return degraded(`cmux new-surface could not run: ${message(error)}`);
  }
  if (created.exitCode !== 0) {
    return degraded(created.stderr.trim() || `cmux new-surface exited ${created.exitCode}`);
  }

  const after = await readCmuxInventory(run);
  if (after === null) return degraded("cmux stopped answering after the tab was created");
  const grown = find(after, target);
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
      await run(["rename-tab", "--workspace", target, "--surface", surface.id, request.title]);
    } catch {
      /* the tab is open and addressable; its name is not load-bearing */
    }
  }

  return { status: "opened", surface: surface.id, workspace: target };
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

  const workspace = find(before, request.workspace);
  if (workspace === undefined) {
    return request.tolerateMissing === true
      ? { status: "closed" }
      : degraded(
          `cmux does not resolve ${request.workspace}; refusing to close the focused ` +
            "surface instead",
        );
  }
  const present = workspace.surfaces.some(
    (surface) => surface.id === request.surface || surface.ref === request.surface,
  );
  if (!present) {
    // Already gone is the expected second call, not a fault.
    return request.tolerateMissing === true
      ? { status: "closed" }
      : degraded(
          `cmux does not resolve ${request.surface} in ${request.workspace}; refusing ` +
            "to close the focused surface instead",
        );
  }

  let closed;
  try {
    closed = await run([
      "close-surface",
      "--surface",
      request.surface,
      "--workspace",
      request.workspace,
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
  const remaining = find(after, request.workspace);
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

function parseInventory(raw: unknown): CmuxInventory {
  const windows = asArray(asRecord(raw)["windows"]);
  const workspaces: CmuxWorkspaceNode[] = [];
  for (const window of windows) {
    for (const entry of asArray(asRecord(window)["workspaces"])) {
      const workspace = asRecord(entry);
      const surfaces: { id: string; ref: string }[] = [];
      for (const paneEntry of asArray(workspace["panes"])) {
        for (const surfaceEntry of asArray(asRecord(paneEntry)["surfaces"])) {
          const surface = asRecord(surfaceEntry);
          surfaces.push({ id: text(surface["id"]), ref: text(surface["ref"]) });
        }
      }
      workspaces.push({
        id: text(workspace["id"]),
        ref: text(workspace["ref"]),
        surfaces,
        title: text(workspace["title"]),
      });
    }
  }
  return { workspaces };
}

/** A handle is a UUID or a `workspace:N` ref; callers legitimately hold both. */
const find = (inventory: CmuxInventory, handle: string): CmuxWorkspaceNode | undefined =>
  inventory.workspaces.find(
    (workspace) => workspace.id === handle || workspace.ref === handle,
  );

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const text = (value: unknown): string => (typeof value === "string" ? value : "");

const degraded = (reason: string): { reason: string; status: "degraded" } => ({
  reason,
  status: "degraded",
});

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
