import { mkdir, open } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { hashText, normalize } from "../matching";
import { loadRegistry, registryPaths, type SessionRecord } from "../provenance";
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

async function appendDurably(path: string, row: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "a");
  try {
    await file.write(`${JSON.stringify(row)}\n`, undefined, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

/** Production seam: one logical line, followed by exactly one Enter key. */
export const sendWithCmux: CmuxSend = async (request) => {
  const target = request.surface
    ? ["--surface", request.surface]
    : ["--workspace", request.workspace];
  const typed = Bun.spawn(["cmux", "send", ...target, "--", request.text], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const typedExit = await typed.exited;
  const typedError = await new Response(typed.stderr).text();
  if (typedExit !== 0) {
    return { ok: false, error: typedError.trim() || `cmux send exited ${typedExit}` };
  }
  const entered = Bun.spawn(["cmux", "send-key", ...target, "--", "enter"], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const enteredExit = await entered.exited;
  const enteredError = await new Response(entered.stderr).text();
  return enteredExit === 0
    ? { ok: true }
    : {
        ok: false,
        error: enteredError.trim() || `cmux send-key exited ${enteredExit}`,
      };
};

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
  await appendDurably(paths.sendsFile, {
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
