import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { ProvenanceClassifier, ProvenanceRecord } from "../../provenance";
import { type CursorMap, type SessionMetaEvent, Tailer } from "../../tailing";

export interface ArchiverEyeOptions {
  /** Repo root; the archive always lives at `<repo>/.argus/archive.db`. */
  repo: string;
}

export interface ArchiveBatchResult {
  /** Messages observed in this Tailer batch, including replayed messages. */
  received: number;
  /** New archive rows after idempotent-key conflict handling. */
  inserted: number;
}

function uuidIngestKey(record: ProvenanceRecord): string | null {
  const { event } = record;
  if (event.uuid !== undefined) {
    return `uuid:${event.sessionId}:${event.uuid}`;
  }
  return null;
}

function eventFingerprint(record: ProvenanceRecord): string {
  const { event } = record;
  const hash = createHash("sha256");
  for (const value of [
    event.file,
    event.sessionId,
    event.role,
    event.ts,
    event.text,
  ]) {
    hash.update(String(Buffer.byteLength(value)), "utf8");
    hash.update(":", "utf8");
    hash.update(value, "utf8");
    hash.update("\0", "utf8");
  }
  return hash.digest("hex");
}

/**
 * Passive transcript archive (SPEC §5.2). A batch's messages and Tailer
 * cursors commit together: after a crash, either both are visible or neither
 * is, and replay-safe ingest keys make a deliberately reset cursor harmless.
 */
export class ArchiverEye {
  private constructor(private readonly database: Database) {}

  static async open(options: ArchiverEyeOptions): Promise<ArchiverEye> {
    const stateDirectory = join(options.repo, ".argus");
    await mkdir(stateDirectory, { recursive: true });
    const database = new Database(join(stateDirectory, "archive.db"), {
      create: true,
      strict: true,
    });
    database.exec("PRAGMA journal_mode = WAL");
    database.exec("PRAGMA synchronous = NORMAL");
    database.exec("PRAGMA busy_timeout = 5000");
    const ftsExists =
      database
        .query<{ present: number }, []>(`
          SELECT 1 AS present FROM sqlite_master
          WHERE type = 'table' AND name = 'archive_messages_fts'
        `)
        .get() !== null;
    database.exec(`
      CREATE TABLE IF NOT EXISTS archive_messages (
        id INTEGER PRIMARY KEY,
        ingest_key TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL,
        agent TEXT,
        role TEXT NOT NULL,
        provenance TEXT NOT NULL,
        provenance_via TEXT NOT NULL,
        ts TEXT NOT NULL,
        ticket TEXT,
        source_file TEXT NOT NULL,
        source_uuid TEXT,
        content TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS archive_sessions (
        session_id TEXT PRIMARY KEY,
        agent TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS archive_cursors (
        file TEXT PRIMARY KEY,
        offset INTEGER NOT NULL CHECK (offset >= 0)
      );
      CREATE VIRTUAL TABLE IF NOT EXISTS archive_messages_fts USING fts5(
        content,
        content = 'archive_messages',
        content_rowid = 'id',
        tokenize = "unicode61 tokenchars '_'"
      );
      CREATE TRIGGER IF NOT EXISTS archive_messages_after_insert AFTER INSERT ON archive_messages BEGIN
        INSERT INTO archive_messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
      CREATE TRIGGER IF NOT EXISTS archive_messages_after_delete AFTER DELETE ON archive_messages BEGIN
        INSERT INTO archive_messages_fts(archive_messages_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
      END;
      CREATE TRIGGER IF NOT EXISTS archive_messages_after_update AFTER UPDATE ON archive_messages BEGIN
        INSERT INTO archive_messages_fts(archive_messages_fts, rowid, content)
        VALUES ('delete', old.id, old.content);
        INSERT INTO archive_messages_fts(rowid, content) VALUES (new.id, new.content);
      END;
    `);
    if (!ftsExists) {
      database.exec(
        "INSERT INTO archive_messages_fts(archive_messages_fts) VALUES ('rebuild')",
      );
    }
    return new ArchiverEye(database);
  }

  /** Persisted cursor snapshot suitable for constructing the next Tailer. */
  cursors(): CursorMap {
    const rows = this.database
      .query<{ file: string; offset: number }, []>(
        "SELECT file, offset FROM archive_cursors ORDER BY file",
      )
      .all();
    return Object.fromEntries(rows.map(({ file, offset }) => [file, offset]));
  }

  /** Replace the durable read frontier for an explicit start-from-now bootstrap. */
  replaceCursors(cursors: Readonly<CursorMap>): void {
    const clear = this.database.query("DELETE FROM archive_cursors");
    const write = this.database.query<unknown, [string, number]>(`
      INSERT INTO archive_cursors (file, offset) VALUES (?, ?)
    `);
    this.database.transaction(() => {
      clear.run();
      for (const [file, offset] of Object.entries(cursors)) {
        write.run(file, offset);
      }
    }).immediate();
  }

  messageCount(): number {
    return this.database
      .query<{ count: number }, []>("SELECT count(*) AS count FROM archive_messages")
      .get()!.count;
  }

  /**
   * Consume the normalized event stream through the shared Tailer. Lifecycle
   * events still reach provenance; only message records are archived.
   */
  async catchUp(
    tailer: Tailer,
    classifier: ProvenanceClassifier,
  ): Promise<ArchiveBatchResult> {
    const startingCursors = tailer.cursors();
    const events = await tailer.catchUp();
    const sessionMeta: SessionMetaEvent[] = [];
    const records: ProvenanceRecord[] = [];
    for (const event of events) {
      if (event.type === "session-meta") sessionMeta.push(event);
      const output = classifier.handle(event);
      if (output.record !== null) records.push(output.record);
    }

    const insertSession = this.database.query<
      { session_id: string; agent: string },
      [string, string]
    >(`
      INSERT INTO archive_sessions (session_id, agent) VALUES (?, ?)
      ON CONFLICT(session_id) DO UPDATE SET agent = excluded.agent
      RETURNING session_id, agent
    `);
    const sessionAgent = this.database.query<{ agent: string }, [string]>(
      "SELECT agent FROM archive_sessions WHERE session_id = ?",
    );
    const insertMessage = this.database.query<{ id: number }, (string | null)[]>(`
      INSERT OR IGNORE INTO archive_messages (
        ingest_key, session_id, agent, role, provenance, provenance_via,
        ts, ticket, source_file, source_uuid, content
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `);
    const writeCursor = this.database.query<unknown, [string, number]>(`
      INSERT INTO archive_cursors (file, offset) VALUES (?, ?)
      ON CONFLICT(file) DO UPDATE SET offset = excluded.offset
    `);
    const fallbackCount = this.database.query<{ count: number }, [string]>(
      "SELECT count(*) AS count FROM archive_messages WHERE ingest_key GLOB ?",
    );

    let inserted = 0;
    const commit = this.database.transaction(() => {
      const nextFallbackOccurrence = new Map<string, number>();
      for (const event of sessionMeta) {
        insertSession.get(event.sessionId, event.agent);
      }
      for (const record of records) {
        let key = uuidIngestKey(record);
        if (key === null) {
          const prefix = `event:${eventFingerprint(record)}:`;
          let occurrence = nextFallbackOccurrence.get(prefix);
          if (occurrence === undefined) {
            occurrence =
              (startingCursors[tailer.cursorKey(record.event.file)] ?? 0) > 0
                ? fallbackCount.get(`${prefix}*`)!.count
                : 0;
          }
          key = `${prefix}${occurrence}`;
          nextFallbackOccurrence.set(prefix, occurrence + 1);
        }
        const agent =
          record.agent ?? sessionAgent.get(record.sessionId)?.agent ?? null;
        if (
          insertMessage.get(
            key,
            record.sessionId,
            agent,
            record.event.role,
            record.author,
            record.via,
            record.ts,
            record.ticket ?? null,
            record.event.file,
            record.event.uuid ?? null,
            record.text,
          ) !== null
        ) {
          inserted += 1;
        }
      }
      for (const [file, offset] of Object.entries(tailer.cursors())) {
        writeCursor.run(file, offset);
      }
    });
    commit.immediate();

    return { inserted, received: records.length };
  }

  close(): void {
    this.database.close(false);
  }
}

/**
 * The session ids this repo has archived at least one message for (#96).
 *
 * READ-ONLY on purpose: `argus status` must never create, migrate or lock the
 * archive a live watcher owns. `null` means "cannot tell" — an archive that
 * exists but will not open — and callers must treat that as no answer rather
 * than as an empty archive, because an empty answer would flag every
 * deployment in the repo as silent. A MISSING archive is a real answer: the
 * archiver creates the file when it opens, so if it is alive and the file is
 * absent, nothing has been archived.
 */
export async function readArchivedSessionIds(
  repo: string,
): Promise<Set<string> | null> {
  const path = join(repo, ".argus", "archive.db");
  if (!(await Bun.file(path).exists())) return new Set<string>();
  let database: Database | undefined;
  try {
    database = new Database(path, { readonly: true, strict: true });
    const rows = database
      .query<{ session_id: string }, []>(
        "SELECT DISTINCT session_id FROM archive_messages",
      )
      .all();
    return new Set(rows.map(({ session_id }) => session_id));
  } catch {
    return null;
  } finally {
    database?.close(false);
  }
}

/** Production composition for the passive archive eye. */
export function openArchiver(repo: string): Promise<ArchiverEye> {
  return ArchiverEye.open({ repo });
}
