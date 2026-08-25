/**
 * Registry reader (SPEC §5): `.argus/registry/sessions.jsonl` + `sends.jsonl`,
 * the single source of provenance truth. Hermes appends; everything here only
 * reads. Malformed or partial lines are tolerated loudly — each produces an
 * audit event and is skipped; parsing never throws (SPEC §13 fault posture).
 */
import { join } from "node:path";
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

/** One sends.jsonl row: a follow-up Hermes logged before typing it (§5 rule 2). */
export interface SendRecord {
  ts: Timestamp;
  sessionId: string;
  text: string;
  /** Hermes' logged kind wins when valid; otherwise the matcher derives it. */
  kind?: SendKind;
  /** Correlation id for audits; defaults to `<file>:<line>`. */
  id?: string;
}

export interface ParsedSessions {
  records: SessionRecord[];
  audits: RegistryLineAudit[];
}

export interface ParsedSends {
  records: SendRecord[];
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

/**
 * Parse one registry file's lines. Per-line `read` returns a record or Invalid
 * (line skipped + audited); `warn` audits a recoverable oddity without
 * dropping the row.
 */
function parseJsonl<T>(
  content: string,
  file: string,
  read: (
    row: Record<string, unknown>,
    line: number,
    warn: (reason: string) => void,
  ) => T | Invalid,
): { records: T[]; audits: RegistryLineAudit[] } {
  const records: T[] = [];
  const audits: RegistryLineAudit[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    if (raw.trim() === "") continue;
    const line = i + 1;
    const audit = (reason: string): void => {
      audits.push({ type: "registry-malformed-line", file, line, raw, reason });
    };
    const row = parseRow(raw);
    const result = typeof row === "string" ? new Invalid(row) : read(row, line, audit);
    if (result instanceof Invalid) {
      audit(result.reason);
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

const SEND_KINDS: readonly SendKind[] = ["prompt", "slash", "bang"];

export function parseSendsJsonl(content: string, file: string): ParsedSends {
  return parseJsonl(content, file, (row, line, warn) => {
    const ts = tsOf(row);
    if (ts instanceof Invalid) return ts;
    const sessionId = requireString(row, "sessionId");
    if (sessionId instanceof Invalid) return sessionId;
    const text = requireString(row, "text");
    if (text instanceof Invalid) return text;
    let kind: SendKind | undefined;
    if (row.kind !== undefined) {
      if (SEND_KINDS.includes(row.kind as SendKind)) {
        kind = row.kind as SendKind;
      } else {
        warn(`kind is not one of ${SEND_KINDS.join("/")}: ${JSON.stringify(row.kind)}`);
      }
    }
    return {
      ts,
      sessionId,
      text,
      ...(kind !== undefined && { kind }),
      id: typeof row.id === "string" && row.id !== "" ? row.id : `${file}:${line}`,
    };
  });
}

/** Registry file locations; configurable so tests never touch real state. */
export interface RegistryPaths {
  sessionsFile: string;
  sendsFile: string;
}

/** The SPEC §4 layout: `<repo>/.argus/registry/{sessions,sends}.jsonl`. */
export function registryPaths(repoRoot: string): RegistryPaths {
  return {
    sessionsFile: join(repoRoot, ".argus/registry/sessions.jsonl"),
    sendsFile: join(repoRoot, ".argus/registry/sends.jsonl"),
  };
}

export interface Registry {
  sessions: SessionRecord[];
  sends: SendRecord[];
  audits: RegistryLineAudit[];
}

/** A registry file that does not exist yet is an empty registry (no deployments). */
async function readIfExists(path: string): Promise<string> {
  const file = Bun.file(path);
  return (await file.exists()) ? file.text() : "";
}

export async function loadRegistry(paths: RegistryPaths): Promise<Registry> {
  const [sessionsContent, sendsContent] = await Promise.all([
    readIfExists(paths.sessionsFile),
    readIfExists(paths.sendsFile),
  ]);
  const sessions = parseSessionsJsonl(sessionsContent, paths.sessionsFile);
  const sends = parseSendsJsonl(sendsContent, paths.sendsFile);
  return {
    sessions: sessions.records,
    sends: sends.records,
    audits: [...sessions.audits, ...sends.audits],
  };
}
