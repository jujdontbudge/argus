import { constants, Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { SourceParser, TailEvent, TranscriptSource } from "./events";
import type { ReadResult } from "./line-reader";

export interface HermesSourceOptions {
  /** Configurable Hermes root. Production passes `~/.hermes`. */
  hermesRoot: string;
}

interface HermesRow {
  id: number;
  sessionId: string;
  role: string;
  content: string;
  timestamp: number;
  parentSessionId: string | null;
  startedAt: number | null;
  cwd: string | null;
  model: string | null;
}

function readOnlyUri(file: string): string {
  return `${pathToFileURL(file).href}?mode=ro&immutable=0`;
}

function decodedText(content: string): string {
  if (!content.startsWith("\u0000json:")) return content;
  const decoded: unknown = JSON.parse(content.slice("\u0000json:".length));
  if (typeof decoded === "string") return decoded;
  if (Array.isArray(decoded)) {
    const text = decoded.flatMap((part) => {
      if (typeof part === "string") return [part];
      if (typeof part !== "object" || part === null) return [];
      const value = (part as Record<string, unknown>).text;
      return typeof value === "string" ? [value] : [];
    });
    if (text.length > 0) return text.join("\n");
  }
  return JSON.stringify(decoded);
}

class HermesParser implements SourceParser {
  private readonly sessions = new Set<string>();

  constructor(private readonly file: string) {}

  parseLine(line: string): TailEvent[] {
    let row: HermesRow;
    try {
      row = JSON.parse(line) as HermesRow;
    } catch {
      return [{ type: "lifecycle", kind: "parse-error", content: line, file: this.file }];
    }
    if (row.role !== "user" && row.role !== "assistant") return [];

    const events: TailEvent[] = [];
    if (!this.sessions.has(row.sessionId)) {
      this.sessions.add(row.sessionId);
      events.push({
        type: "session-meta",
        sessionId: row.sessionId,
        agent: "hermes",
        ...(row.cwd !== null && { cwd: row.cwd }),
        ...(row.parentSessionId !== null && { parentSessionId: row.parentSessionId }),
        ...(row.model !== null && { version: row.model }),
        ...(row.startedAt !== null && { ts: new Date(row.startedAt * 1000).toISOString() }),
        file: this.file,
      });
    }
    events.push({
      type: "message",
      sessionId: row.sessionId,
      role: row.role,
      text: decodedText(row.content),
      ts: new Date(row.timestamp * 1000).toISOString(),
      candidate: row.role === "user",
      file: this.file,
    });
    return events;
  }
}

class HermesDatabaseReader {
  async read(file: string, offset: number): Promise<ReadResult> {
    const db = new Database(
      readOnlyUri(file),
      constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
    );
    try {
      const rows = db.query<HermesRow, [number]>(
        `SELECT
           messages.id AS id,
           messages.session_id AS sessionId,
           messages.role AS role,
           messages.content AS content,
           messages.timestamp AS timestamp,
           sessions.parent_session_id AS parentSessionId,
           sessions.started_at AS startedAt,
           sessions.cwd AS cwd,
           sessions.model AS model
         FROM messages
         LEFT JOIN sessions ON sessions.id = messages.session_id
         WHERE messages.id > ? AND messages.active = 1
         ORDER BY messages.id`,
      ).all(offset);
      const maximum = db.query<{ id: number | null }, []>(
        "SELECT max(id) AS id FROM messages",
      ).get()?.id;
      return {
        lines: rows.map((row) => JSON.stringify(row)),
        offset: maximum === null || maximum === undefined ? offset : Math.max(offset, maximum),
        truncated: false,
      };
    } finally {
      db.close();
    }
  }
}

export function createHermesSource(options: HermesSourceOptions): TranscriptSource {
  const profiles = join(options.hermesRoot, "profiles");
  const reader = new HermesDatabaseReader();
  return {
    id: "hermes",
    watchPaths: () => [profiles],
    listFiles: async () => {
      const entries = await readdir(profiles, { withFileTypes: true }).catch(() => []);
      return entries
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("argus-"))
        .map((entry) => join(profiles, entry.name, "state.db"))
        .filter((file) => Bun.file(file).size > 0)
        .sort();
    },
    readNewLines: (file, offset) => reader.read(file, offset),
    createParser: (file) => new HermesParser(file),
  };
}
