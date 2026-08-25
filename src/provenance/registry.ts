/**
 * Registry reader (SPEC §5): `.argus/registry/sessions.jsonl` + `sends.jsonl`,
 * the single source of provenance truth. Hermes appends; everything here only
 * reads. Malformed or partial lines are tolerated loudly — each produces an
 * audit event and is skipped; parsing never throws (SPEC §13 fault posture).
 */
import type { SendKind, Timestamp } from "../matching";

/** One sessions.jsonl row: a deployment Hermes recorded before session start. */
export interface SessionRecord {
  ts: Timestamp;
  sessionId: string;
  /** The full dispatch prompt Hermes sent to open the session (§5 rule 1). */
  dispatchPrompt: string;
  agent?: string;
  ticket?: string;
  workspace?: string;
}

/** A registry line that could not be used, surfaced loudly (never a crash). */
export interface RegistryLineAudit {
  type: "registry-malformed-line";
  file: string;
  /** 1-based line number in the registry file. */
  line: number;
  raw: string;
  reason: string;
}

export interface ParsedSessions {
  records: SessionRecord[];
  audits: RegistryLineAudit[];
}

function parseRow(raw: string): Record<string, unknown> | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return `not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return "not a JSON object";
  }
  return parsed as Record<string, unknown>;
}

/** A field that failed validation, with the reason for the audit event. */
class Invalid {
  constructor(readonly reason: string) {}
}

function tsOf(row: Record<string, unknown>): Timestamp | Invalid {
  const ts = row.ts;
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  if (typeof ts === "string" && !Number.isNaN(Date.parse(ts))) return ts;
  return new Invalid(
    `ts is not an epoch-ms number or ISO-8601 string: ${JSON.stringify(ts)}`,
  );
}

function requireString(row: Record<string, unknown>, field: string): string | Invalid {
  const value = row[field];
  if (typeof value === "string" && value !== "") return value;
  return new Invalid(`${field} is not a non-empty string: ${JSON.stringify(value)}`);
}

/** Parse one registry file's lines; per-line `read` returns a record or Invalid. */
function parseJsonl<T>(
  content: string,
  file: string,
  read: (row: Record<string, unknown>, line: number) => T | Invalid,
): { records: T[]; audits: RegistryLineAudit[] } {
  const records: T[] = [];
  const audits: RegistryLineAudit[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === "") continue;
    const line = i + 1;
    const row = parseRow(raw);
    const result = typeof row === "string" ? new Invalid(row) : read(row, line);
    if (result instanceof Invalid) {
      audits.push({
        type: "registry-malformed-line",
        file,
        line,
        raw,
        reason: result.reason,
      });
    } else {
      records.push(result);
    }
  }
  return { records, audits };
}

export function parseSessionsJsonl(content: string, file: string): ParsedSessions {
  return parseJsonl(content, file, (row) => {
    const ts = tsOf(row);
    if (ts instanceof Invalid) return ts;
    const sessionId = requireString(row, "sessionId");
    if (sessionId instanceof Invalid) return sessionId;
    const dispatchPrompt = requireString(row, "dispatchPrompt");
    if (dispatchPrompt instanceof Invalid) return dispatchPrompt;
    return {
      ts,
      sessionId,
      dispatchPrompt,
      ...(typeof row.agent === "string" && { agent: row.agent }),
      ...(typeof row.ticket === "string" && { ticket: row.ticket }),
      ...(typeof row.workspace === "string" && { workspace: row.workspace }),
    };
  });
}
