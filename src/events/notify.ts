import { basename } from "node:path";

import { hashText, normalize } from "../matching";
import {
  appendSendRow,
  loadRegistry,
  registryPaths,
  type SessionRecord,
} from "../provenance";
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
    if (
      session.agent?.toLowerCase() === "hermes" &&
      session.workspace?.startsWith("workspace:")
    ) {
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

export const runCmux: CmuxRun = async (args) => {
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
    const workspaces = await run(["list-workspaces"]);
    if (workspaces.exitCode !== 0) {
      return { ok: false, error: failed(workspaces, "list-workspaces") };
    }
    if (!listedRefs(workspaces.stdout).has(target.workspace)) {
      return {
        ok: false,
        error: `cmux does not resolve ${target.workspace}; refusing to type into the focused workspace instead`,
      };
    }
    if (target.surface !== undefined) {
      const surfaces = await run([
        "list-pane-surfaces",
        "--workspace",
        target.workspace,
      ]);
      if (surfaces.exitCode !== 0) {
        return { ok: false, error: failed(surfaces, "list-pane-surfaces") };
      }
      if (!listedRefs(surfaces.stdout).has(target.surface)) {
        return {
          ok: false,
          error: `cmux does not resolve ${target.surface} in ${target.workspace}; refusing to type into the focused surface instead`,
        };
      }
    }
    return { ok: true };
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
