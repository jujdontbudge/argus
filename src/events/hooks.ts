import { lstat, realpath } from "node:fs/promises";
import { dirname, join, parse } from "node:path";

import type { EventAgent, EventKind } from "./schema.ts";
import {
  createCmuxSend,
  notifyMissionControl,
  type CmuxRun,
  type MissionNotificationOptions,
} from "./notify.ts";
import { consumePushedEvent } from "./consumer.ts";
import { writeEvent } from "./writer.ts";

export interface ClaudeStopPayload {
  hook_event_name?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  last_assistant_message?: unknown;
}

export interface CodexNotifyPayload {
  type?: unknown;
  "thread-id"?: unknown;
  cwd?: unknown;
  "last-assistant-message"?: unknown;
}

export type HookResult =
  | { status: "ignored"; reason: "invalid-payload" | "not-argus" | "not-terminal" }
  | {
      status: "emitted";
      eventPath: string;
      notification: Awaited<ReturnType<typeof notifyMissionControl>>;
    };

export interface HookRuntime extends MissionNotificationOptions {
  cmux?: CmuxRun;
  resolveRepo?: (cwd: string) => Promise<string | null>;
}

const BLOCKED = [
  /\bBLOCKED\b/i,
  /\bblocked on (?:a )?human\b/i,
  /\bwaiting (?:on|for) (?:Johan|a human|human input|approval|credentials?)\b/i,
  /\bneed(?:s|ed)? (?:Johan|a human|human input|approval|credentials?)\b/i,
];
const ENDED = [
  /(?:^|\s)DONE[.!]?(?:\s|$)/i,
  /\bgates? green\b/i,
  /\btask (?:is )?complete(?:d)?\b/i,
  /\bimplemented and verified\b/i,
];

export function classifyTerminalMessage(message: string): EventKind | null {
  if (BLOCKED.some((pattern) => pattern.test(message))) return "blocked-on-human";
  if (ENDED.some((pattern) => pattern.test(message))) return "end-of-session";
  return null;
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function gitCommonRepo(cwd: string): Promise<string | null> {
  try {
    const child = Bun.spawn(
      ["git", "-C", cwd, "rev-parse", "--path-format=absolute", "--git-common-dir"],
      { stderr: "ignore", stdout: "pipe" },
    );
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    if (exitCode !== 0) return null;
    const common = stdout.trim();
    return common.endsWith("/.git") ? dirname(common) : null;
  } catch {
    return null;
  }
}

/**
 * Canonical, always. #7's live drive found why: a real `codex exec --cd <path>`
 * reports that path verbatim, a real Claude `Stop` hook reports the resolved
 * one, and on macOS `/var` is a symlink to `/private/var`. `src/watch.ts`
 * resolves its own repo with `realpath` and then drops any event whose `repo`
 * differs STRING-wise, so an agent started on the symlinked form wrote a valid
 * event that the digest ignored forever. Resolving here makes every event
 * carry the one path form every consumer compares against.
 */
async function canonical(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

/** Finds direct repos, nested cwds, and linked worktrees' canonical repo state. */
export async function resolveArgusRepo(cwd: string): Promise<string | null> {
  let current = await canonical(cwd);
  const root = parse(current).root;
  while (true) {
    if (await exists(join(current, ".argus"))) return current;
    if (current === root) break;
    current = dirname(current);
  }
  const common = await gitCommonRepo(cwd);
  return common !== null && (await exists(join(common, ".argus")))
    ? await canonical(common)
    : null;
}

async function handle(
  agent: EventAgent,
  sessionId: unknown,
  cwd: unknown,
  message: unknown,
  runtime: HookRuntime,
): Promise<HookResult> {
  if (
    typeof sessionId !== "string" ||
    sessionId === "" ||
    typeof cwd !== "string" ||
    cwd === "" ||
    typeof message !== "string" ||
    message === ""
  ) {
    return { status: "ignored", reason: "invalid-payload" };
  }
  const repo = await (runtime.resolveRepo ?? resolveArgusRepo)(cwd);
  if (repo === null) return { status: "ignored", reason: "not-argus" };
  const kind = classifyTerminalMessage(message);
  if (kind === null) return { status: "ignored", reason: "not-terminal" };
  const written = await writeEvent(
    repo,
    { agent, kind, message, sessionId },
    { ...(runtime.now !== undefined && { now: runtime.now }) },
  );
  const { cmux, resolveRepo: _resolveRepo, ...notificationOptions } = runtime;
  const notification = await consumePushedEvent(repo, written.event, {
    ...notificationOptions,
    ...(notificationOptions.send === undefined && cmux !== undefined
      ? { send: createCmuxSend(cmux) }
      : {}),
  });
  return { status: "emitted", eventPath: written.path, notification };
}

export async function handleClaudeStop(
  payload: ClaudeStopPayload,
  runtime: HookRuntime = {},
): Promise<HookResult> {
  if (payload.hook_event_name !== "Stop") {
    return { status: "ignored", reason: "invalid-payload" };
  }
  return handle(
    "claude-code",
    payload.session_id,
    payload.cwd,
    payload.last_assistant_message,
    runtime,
  );
}

export async function handleCodexNotify(
  payload: CodexNotifyPayload,
  runtime: HookRuntime = {},
): Promise<HookResult> {
  if (payload.type !== "agent-turn-complete") {
    return { status: "ignored", reason: "invalid-payload" };
  }
  return handle(
    "codex",
    payload["thread-id"],
    payload.cwd,
    payload["last-assistant-message"],
    runtime,
  );
}

export async function runClaudeStop(
  input: string,
  runtime: HookRuntime = {},
): Promise<HookResult> {
  try {
    return handleClaudeStop(JSON.parse(input) as ClaudeStopPayload, runtime);
  } catch {
    return { status: "ignored", reason: "invalid-payload" };
  }
}

export async function runCodexNotify(
  input: string | undefined,
  runtime: HookRuntime = {},
): Promise<HookResult> {
  if (input === undefined) return { status: "ignored", reason: "invalid-payload" };
  try {
    return handleCodexNotify(JSON.parse(input) as CodexNotifyPayload, runtime);
  } catch {
    return { status: "ignored", reason: "invalid-payload" };
  }
}
