import { basename } from "node:path";

import { hashText, normalize } from "../matching";
import {
  appendSendRow,
  loadRegistry,
  registryPaths,
  type SessionRecord,
} from "../provenance";
import { refuseCmuxArgs } from "./handles.ts";
import type { ArgusEvent } from "./schema.ts";

export interface CmuxSendRequest {
  surface?: string;
  text: string;
  workspace: string;
}

export interface CmuxSendResult {
  error?: string;
  ok: boolean;
}

export type CmuxSend = (request: CmuxSendRequest) => Promise<CmuxSendResult>;

export type MissionNotificationResult =
  | { status: "sent" }
  | { status: "degraded"; reason: string };

export interface MissionNotificationOptions {
  now?: () => Date;
  onError?: (message: string) => void;
  send?: CmuxSend;
}

function missionSession(sessions: SessionRecord[]): SessionRecord | null {
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    const session = sessions[index]!;
    // #90: the handle is accepted in EITHER form, and deliberately not
    // filtered to `workspace:` any more. That prefix test predates #95 and
    // selected FOR the short ref — the one form measured to fail OPEN (an
    // unresolvable `workspace:9999` exits 0 and answers for the focused
    // workspace, while an unresolvable UUID errors `not_found`). Since #95 a
    // worker's tab is addressed by the UUID in `CMUX_WORKSPACE_ID`, so the
    // filter both rejected every UUID-addressed mission — delivery degraded
    // as "workspace is absent" for a workspace that was present — and kept
    // only the form Argus should be moving away from. Resolution is not this
    // function's job: `createCmuxSend` resolves the handle against cmux's own
    // inventory before typing, and refuses there.
    if (session.agent?.toLowerCase() === "hermes" && (session.workspace ?? "") !== "") {
      return session;
    }
  }
  return null;
}

function notificationText(event: ArgusEvent): string {
  const state = event.kind === "end-of-session" ? "finished" : "blocked on a human";
  return normalize(
    `[argus] ${event.agent} session ${event.sessionId} ${state}; event .argus/events/${
      basename(`v${event.schemaVersion}-${event.kind}-${event.id}.json`)
    }`,
  );
}

export interface CmuxRunResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

/** The one place this module shells out; injected so the seam is testable. */
export type CmuxRun = (args: readonly string[]) => Promise<CmuxRunResult>;

/**
 * The ONLY place in the tree that spawns `cmux` — asserted by
 * `handles.test.ts`, because #98's defence is a choke point and a second spawn
 * site would be a hole in it rather than a duplication.
 *
 * Being the only one is what lets the UUID-only rule be structural instead of
 * conventional: `refuseCmuxArgs` sees every state-changing verb this process
 * ever runs, no matter which module composed the argv, and refuses the ones
 * carrying a handle form that fails OPEN. The refusal is shaped like cmux's
 * own fail-closed answer (exit 1, reason on stderr) so that every existing
 * caller's degrade path already handles it correctly.
 */
export const runCmux: CmuxRun = async (args) => {
  const refusal = refuseCmuxArgs(args);
  if (refusal !== null) return { exitCode: 1, stderr: refusal, stdout: "" };
  const child = Bun.spawn(["cmux", ...args], { stderr: "pipe", stdout: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
};

/** `  workspace:14  argus` / `* surface:84  argus-dispatcher` → the ref. */
export function listedRefs(stdout: string): Set<string> {
  const refs = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = /^[\s*]*((?:workspace|surface):[A-Za-z0-9-]+)\b/.exec(line);
    if (match) refs.add(match[1]!);
  }
  return refs;
}

/** One workspace as `cmux tree` reports it: both handles, and its surfaces. */
export interface CmuxWorkspaceNode {
  id: string;
  ref: string;
  title: string;
  surfaces: { id: string; ref: string }[];
}

export interface CmuxInventory {
  workspaces: CmuxWorkspaceNode[];
}

/**
 * `cmux --id-format both tree --all --json`, parsed. `null` when cmux cannot
 * answer at all — every caller degrades on that rather than guessing.
 *
 * This is the WHOLE-MACHINE inventory, and #95 needed it for two reasons.
 *
 * 1. `list-workspaces` is documented as "List workspaces in the current
 *    window" and behaves that way: measured on this machine, a caller sitting
 *    in `workspace:1` (window 1) gets back window 2's workspaces and NOT its
 *    own. So a membership check built only on it refuses every handle outside
 *    the focused window — including, now, the workspace every worker tab lives
 *    in.
 * 2. `CMUX_WORKSPACE_ID` is a UUID, and `list-workspaces` prints only refs.
 *    `--id-format both` is what puts the two beside each other.
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

/** The workspace a handle names, by UUID or by ref. `undefined` if unknown. */
export function findWorkspace(
  inventory: CmuxInventory,
  handle: string,
): CmuxWorkspaceNode | undefined {
  return inventory.workspaces.find(
    (workspace) => workspace.id === handle || workspace.ref === handle,
  );
}

function parseInventory(raw: unknown): CmuxInventory {
  const asRecord = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
  const text = (value: unknown): string => (typeof value === "string" ? value : "");

  const workspaces: CmuxWorkspaceNode[] = [];
  for (const window of asArray(asRecord(raw)["windows"])) {
    for (const entry of asArray(asRecord(window)["workspaces"])) {
      const workspace = asRecord(entry);
      const surfaces: { id: string; ref: string }[] = [];
      for (const pane of asArray(workspace["panes"])) {
        for (const surfaceEntry of asArray(asRecord(pane)["surfaces"])) {
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

export interface CmuxTarget {
  surface?: string;
  workspace: string;
}

/** Does cmux itself resolve this handle? `ok: false` carries the reason. */
export type CmuxResolve = (target: CmuxTarget) => Promise<CmuxSendResult>;

/**
 * Ticket #7, measured against a real cmux 0.62.2: an unresolvable handle is
 * NOT an error there. `cmux send --workspace workspace:9999` exits 0 and acts
 * on the FOCUSED workspace, and `read-screen --surface surface:99999` reads it
 * back — so a stale mission handle in the registry does not degrade, it types
 * an `[argus]` line into whichever human or worker session is selected and
 * reports success. §6 delivery would fail silently while §5 got poisoned.
 *
 * So the seam resolves the handle against cmux's own listing before typing
 * anything, and refuses when it does not resolve. The refusal reaches
 * `notifyMissionControl` as `ok: false`, which is already the durable
 * `ARGUS EVENT DELIVERY DEGRADED` path; the event file is untouched either way.
 *
 * EXTRACTED, #55: the worker dispatcher has to ask the same question BEFORE it
 * logs a follow-up send, so that a send it cannot deliver is never written
 * into `sends.jsonl` as though it had been. Same code, two callers — a second
 * resolver that drifted from this one would reopen exactly the hazard #7
 * closed.
 */
export function createCmuxResolve(run: CmuxRun = runCmux): CmuxResolve {
  const failed = (result: CmuxRunResult, what: string): string =>
    result.stderr.trim() || `cmux ${what} exited ${result.exitCode}`;

  return async (target) => {
    // The window-scoped listing stays the FAST PATH, unchanged: it is what #7
    // measured and what every handle inside the focused window still resolves
    // through. What #95 added is the fallback below it, because a handle this
    // listing cannot see is not necessarily a handle cmux cannot resolve.
    const workspaces = await run(["list-workspaces"]);
    if (workspaces.exitCode !== 0) {
      return { ok: false, error: failed(workspaces, "list-workspaces") };
    }
    if (listedRefs(workspaces.stdout).has(target.workspace)) {
      if (target.surface === undefined) return { ok: true };
      const surfaces = await run(["list-pane-surfaces", "--workspace", target.workspace]);
      if (surfaces.exitCode !== 0) {
        return { ok: false, error: failed(surfaces, "list-pane-surfaces") };
      }
      if (listedRefs(surfaces.stdout).has(target.surface)) return { ok: true };
      return {
        ok: false,
        error: `cmux does not resolve ${target.surface} in ${target.workspace}; refusing to type into the focused surface instead`,
      };
    }

    // #95's fallback. Two handles legitimately miss the fast path: anything in
    // a workspace outside the focused WINDOW (which is where the argus
    // workspace sits on this machine — the dispatcher cannot see its own
    // workspace in `list-workspaces`), and any UUID, which that listing never
    // prints. Refusing them would mean no worker tab could ever be typed into.
    // The tree is consulted before refusing, never instead of refusing: a
    // handle absent from BOTH is still refused, which is the guard #7 added.
    const inventory = await readCmuxInventory(run);
    const workspace =
      inventory === null ? undefined : findWorkspace(inventory, target.workspace);
    if (workspace === undefined) {
      return {
        ok: false,
        error: `cmux does not resolve ${target.workspace}; refusing to type into the focused workspace instead`,
      };
    }
    if (target.surface === undefined) return { ok: true };
    const resolved = workspace.surfaces.some(
      (surface) => surface.id === target.surface || surface.ref === target.surface,
    );
    return resolved
      ? { ok: true }
      : {
          ok: false,
          error: `cmux does not resolve ${target.surface} in ${target.workspace}; refusing to type into the focused surface instead`,
        };
  };
}

/** The resolver production uses; the guard #7 added, by itself. */
export const resolveWithCmux: CmuxResolve = createCmuxResolve();

export function createCmuxSend(run: CmuxRun = runCmux): CmuxSend {
  const failed = (result: CmuxRunResult, what: string): string =>
    result.stderr.trim() || `cmux ${what} exited ${result.exitCode}`;
  const resolve = createCmuxResolve(run);

  return async (request) => {
    const resolved = await resolve(request);
    if (!resolved.ok) return resolved;

    const target = request.surface
      ? ["--surface", request.surface]
      : ["--workspace", request.workspace];
    const typed = await run(["send", ...target, "--", request.text]);
    if (typed.exitCode !== 0) return { ok: false, error: failed(typed, "send") };
    const entered = await run(["send-key", ...target, "--", "enter"]);
    return entered.exitCode === 0
      ? { ok: true }
      : { ok: false, error: failed(entered, "send-key") };
  };
}

/** Production seam: one logical line, followed by exactly one Enter key. */
export const sendWithCmux: CmuxSend = createCmuxSend();

/** Registry-first delivery into the latest registered Hermes mission session. */
export async function notifyMissionControl(
  repo: string,
  event: ArgusEvent,
  options: MissionNotificationOptions = {},
): Promise<MissionNotificationResult> {
  const fail = (reason: string): MissionNotificationResult => {
    const message = `ARGUS EVENT DELIVERY DEGRADED: ${reason}; event ${event.id} remains durable`;
    (options.onError ?? console.error)(message);
    return { status: "degraded", reason };
  };
  const paths = registryPaths(repo);
  const registry = await loadRegistry(paths);
  const mission = missionSession(registry.sessions);
  if (!mission?.workspace) {
    return fail("Hermes mission-control workspace is absent from the registry");
  }

  const text = notificationText(event);
  const now = (options.now?.() ?? new Date()).toISOString();
  await appendSendRow(paths.sendsFile, {
    ts: now,
    id: `argus-event:${event.id}`,
    sessionId: mission.sessionId,
    agent: "argus",
    kind: "prompt",
    text,
    hash: hashText(text),
    workspace: mission.workspace,
    ...(mission.surface !== undefined && { surface: mission.surface }),
  });

  const result = await (options.send ?? sendWithCmux)({
    workspace: mission.workspace,
    ...(mission.surface !== undefined && { surface: mission.surface }),
    text,
  });
  if (!result.ok) return fail(result.error ?? "cmux send failed");
  return { status: "sent" };
}
