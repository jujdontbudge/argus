import { constants, Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { repositoryFor } from "./codex";
import type { SourceParser, TailEvent, TranscriptSource } from "./events";
import { hermesSchemaFacts } from "./shape/contract";
import { ShapeWatcher } from "./shape/watcher";
import type { ReadResult } from "./line-reader";

export interface HermesSourceOptions {
  /** Configurable Hermes root. Production passes `~/.hermes`. */
  hermesRoot: string;
  /** Optional profile allow-list used by one-repo watcher daemons. */
  profiles?: readonly string[];
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

interface SessionLink {
  id: string;
  parentSessionId: string | null;
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

/**
 * Hermes's contract is a DATABASE SCHEMA, not a JSON record, and the reader's
 * own `SELECT` filters `role IN ('user','assistant')` — so a third role, or a
 * renamed column, could never reach the parser to be noticed there. The reader
 * therefore reads the schema off the database with PRAGMA (the closest thing
 * Hermes has to #89's active-install manifest) and hands it to the parser on
 * this line, once per file. It is not a row and is never parsed as one.
 */
const SCHEMA_LINE = "__argusShapeSchema";

interface HermesSchema {
  [SCHEMA_LINE]: { columns: Record<string, string[]>; roles: string[] };
}

class HermesParser implements SourceParser {
  private readonly sessions = new Set<string>();
  private readonly shape: ShapeWatcher;

  constructor(private readonly file: string) {
    this.shape = new ShapeWatcher("hermes", file);
  }

  parseLine(line: string): TailEvent[] {
    let row: HermesRow;
    try {
      row = JSON.parse(line) as HermesRow;
    } catch {
      return [{ type: "lifecycle", kind: "parse-error", content: line, file: this.file }];
    }
    const schema = (row as unknown as Partial<HermesSchema>)[SCHEMA_LINE];
    if (schema !== undefined) {
      return this.shape.inspectFacts(hermesSchemaFacts(schema.columns, schema.roles));
    }
    const drift = this.shape.inspect(row, row.sessionId, undefined);
    if (row.role !== "user" && row.role !== "assistant") return drift;

    const events: TailEvent[] = [...drift];
    if (!this.sessions.has(row.sessionId)) {
      this.sessions.add(row.sessionId);
      const repo = row.cwd === null ? undefined : repositoryFor(row.cwd);
      events.push({
        type: "session-meta",
        sessionId: row.sessionId,
        agent: "hermes",
        ...(row.cwd !== null && { cwd: row.cwd }),
        ...(repo !== undefined && { repo }),
        ...(row.parentSessionId !== null && { parentSessionId: row.parentSessionId }),
        ...(row.model !== null && { model: row.model }),
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
  private readonly schemaRead = new Set<string>();
  private readonly sequences = new Map<string, Map<string, string[]>>();

  private signature(row: HermesRow): string {
    const content = createHash("sha256").update(row.content).digest("hex");
    return `${row.role}:${content}`;
  }

  private unreplayed(file: string, rows: HermesRow[]): HermesRow[] {
    let sessions = this.sequences.get(file);
    if (!sessions) {
      sessions = new Map();
      this.sequences.set(file, sessions);
    }
    const grouped = new Map<string, HermesRow[]>();
    for (const row of rows) {
      const group = grouped.get(row.sessionId) ?? [];
      group.push(row);
      grouped.set(row.sessionId, group);
    }

    const emitted = new Set<number>();
    for (const [sessionId, group] of grouped) {
      const previous = sessions.get(sessionId) ?? [];
      const signatures = group.map((row) => this.signature(row));
      const rewrite =
        previous.length > 0 &&
        signatures[0] === previous[0] &&
        group.every((row) => row.timestamp === group[0]?.timestamp);
      if (rewrite) {
        group.forEach((row, index) => {
          if (signatures[index] !== previous[index]) emitted.add(row.id);
        });
        sessions.set(sessionId, signatures);
      } else {
        for (const row of group) emitted.add(row.id);
        sessions.set(sessionId, [...previous, ...signatures]);
      }
    }
    return rows.filter((row) => emitted.has(row.id));
  }

  private stitchCompressionChains(db: Database, rows: HermesRow[]): HermesRow[] {
    const links = new Map(
      db
        .query<SessionLink, []>(
          "SELECT id, parent_session_id AS parentSessionId FROM sessions",
        )
        .all()
        .map((link) => [link.id, link.parentSessionId]),
    );
    return rows.map((row) => {
      if (row.parentSessionId === null) return row;
      const visited = new Set([row.sessionId]);
      let root = row.parentSessionId;
      while (!visited.has(root)) {
        visited.add(root);
        const parent = links.get(root);
        if (parent === null || parent === undefined) break;
        root = parent;
      }
      return { ...row, parentSessionId: root };
    });
  }

  /**
   * The schema as the database itself reports it, once per file per process
   * (#100). `SELECT DISTINCT role` is the one non-PRAGMA read here and it is
   * why this runs once: the reader's row query can never surface a role it
   * filters out, so the only place a new role is visible is the table.
   */
  private schemaLine(db: Database, file: string): string[] {
    if (this.schemaRead.has(file)) return [];
    this.schemaRead.add(file);
    try {
      const columns: Record<string, string[]> = {};
      for (const table of ["sessions", "messages"]) {
        columns[table] = db
          .query<{ name: string }, []>(`PRAGMA table_info(${table})`)
          .all()
          .map(({ name }) => name);
      }
      const roles = db
        .query<{ role: string | null }, []>("SELECT DISTINCT role FROM messages")
        .all()
        .flatMap(({ role }) => (typeof role === "string" ? [role] : []));
      return [JSON.stringify({ [SCHEMA_LINE]: { columns, roles } })];
    } catch {
      // A schema read that fails must never stop the messages being tailed.
      return [];
    }
  }

  async read(file: string, offset: number): Promise<ReadResult> {
    const db = new Database(
      readOnlyUri(file),
      constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
    );
    try {
      if (offset > 0 && !this.sequences.has(file)) {
        const baseline = db.query<HermesRow, [number]>(
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
           WHERE messages.id <= ?
             AND messages.active = 1
             AND messages.content IS NOT NULL
             AND messages.role IN ('user', 'assistant')
           ORDER BY messages.id`,
        ).all(offset);
        this.unreplayed(file, baseline);
      }
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
         WHERE messages.id > ?
           AND messages.active = 1
           AND messages.content IS NOT NULL
           AND messages.role IN ('user', 'assistant')
         ORDER BY messages.id`,
      ).all(offset);
      const maximum = db.query<{ id: number | null }, []>(
        "SELECT max(id) AS id FROM messages",
      ).get()?.id;
      const stitched = this.stitchCompressionChains(db, rows);
      return {
        lines: [
          ...this.schemaLine(db, file),
          ...this.unreplayed(file, stitched).map((row) => JSON.stringify(row)),
        ],
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
        .filter(
          (entry) =>
            entry.isDirectory() &&
            entry.name.startsWith("argus-") &&
            (options.profiles === undefined || options.profiles.includes(entry.name)),
        )
        .map((entry) => join(profiles, entry.name, "state.db"))
        .filter((file) => Bun.file(file).size > 0)
        .sort();
    },
    readNewLines: (file, offset) => reader.read(file, offset),
    createParser: (file) => new HermesParser(file),
  };
}
