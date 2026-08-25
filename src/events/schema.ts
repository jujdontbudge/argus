export const EVENT_SCHEMA_VERSION = 1 as const;

export type EventAgent = "claude-code" | "codex";
export type EventKind = "end-of-session" | "blocked-on-human";

export interface ArgusEvent {
  schemaVersion: typeof EVENT_SCHEMA_VERSION;
  id: string;
  kind: EventKind;
  agent: EventAgent;
  sessionId: string;
  repo: string;
  createdAt: string;
  message: string;
}

const KINDS: readonly EventKind[] = ["end-of-session", "blocked-on-human"];
const AGENTS: readonly EventAgent[] = ["claude-code", "codex"];

/** Parse the durable v1 boundary. Unknown versions are intentionally ignored. */
export function parseArgusEvent(input: string): ArgusEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(input);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (
    row.schemaVersion !== EVENT_SCHEMA_VERSION ||
    typeof row.id !== "string" ||
    row.id === "" ||
    !KINDS.includes(row.kind as EventKind) ||
    !AGENTS.includes(row.agent as EventAgent) ||
    typeof row.sessionId !== "string" ||
    row.sessionId === "" ||
    typeof row.repo !== "string" ||
    row.repo === "" ||
    typeof row.createdAt !== "string" ||
    Number.isNaN(Date.parse(row.createdAt)) ||
    typeof row.message !== "string" ||
    row.message === ""
  ) {
    return null;
  }
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    id: row.id,
    kind: row.kind as EventKind,
    agent: row.agent as EventAgent,
    sessionId: row.sessionId,
    repo: row.repo,
    createdAt: row.createdAt,
    message: row.message,
  };
}
