import { Database } from "bun:sqlite";
import { join } from "node:path";

export interface OpenArchiveSearchOptions {
  repo: string;
}

export interface ArchiveSearchResult {
  sessionId: string;
  agent: string | null;
  role: "user" | "assistant";
  provenance: string;
  ts: string;
  ticket: string | null;
  snippet: string;
}

interface SearchRow {
  session_id: string;
  agent: string | null;
  role: "user" | "assistant";
  provenance: string;
  ts: string;
  ticket: string | null;
  snippet: string;
}

const HIGHLIGHT_START = "\u0001";
const HIGHLIGHT_END = "\u0002";
const MAX_SNIPPET_LENGTH = 320;

/** Turn user text into a literal AND query; FTS operators never leak through. */
function literalMatch(query: string): string | null {
  const terms = query.trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return null;
  return terms
    .map((term) => `"${term.replaceAll('"', '""')}"`)
    .join(" AND ");
}

function boundedSnippet(raw: string): string {
  const normalized = raw.replace(/\s+/g, " ").trim();
  const rendered = normalized
    .replaceAll(HIGHLIGHT_START, "")
    .replaceAll(HIGHLIGHT_END, "");
  if (rendered.length <= MAX_SNIPPET_LENGTH) return rendered;

  const highlight = normalized.indexOf(HIGHLIGHT_START);
  const center = highlight >= 0 ? highlight : Math.floor(normalized.length / 2);
  const start = Math.max(0, center - 145);
  const end = Math.min(normalized.length, start + MAX_SNIPPET_LENGTH - 2);
  const excerpt = normalized
    .slice(start, end)
    .replaceAll(HIGHLIGHT_START, "")
    .replaceAll(HIGHLIGHT_END, "");
  return `${start > 0 ? "…" : ""}${excerpt}${end < normalized.length ? "…" : ""}`;
}

/** A long-lived, read-only search connection safe beside the WAL writer. */
export class ArchiveSearch {
  private readonly statement;

  constructor(private readonly database: Database) {
    this.statement = database.query<SearchRow, [string, number]>(`
      SELECT
        messages.session_id,
        messages.agent,
        messages.role,
        messages.provenance,
        messages.ts,
        messages.ticket,
        snippet(archive_messages_fts, 0, '${HIGHLIGHT_START}', '${HIGHLIGHT_END}', ' … ', 32) AS snippet
      FROM archive_messages_fts
      JOIN archive_messages AS messages ON messages.id = archive_messages_fts.rowid
      WHERE archive_messages_fts MATCH ?
      ORDER BY bm25(archive_messages_fts), messages.ts DESC, messages.id DESC
      LIMIT ?
    `);
  }

  query(query: string, limit = 20): ArchiveSearchResult[] {
    const match = literalMatch(query);
    if (match === null) return [];
    const safeLimit = Number.isSafeInteger(limit) && limit > 0 ? limit : 20;
    return this.statement.all(match, safeLimit).map((row) => ({
      sessionId: row.session_id,
      agent: row.agent,
      role: row.role,
      provenance: row.provenance,
      ts: row.ts,
      ticket: row.ticket,
      snippet: boundedSnippet(row.snippet),
    }));
  }

  close(): void {
    this.database.close(false);
  }
}

export function openArchiveSearch(
  options: OpenArchiveSearchOptions,
): ArchiveSearch {
  const database = new Database(join(options.repo, ".argus/archive.db"), {
    readonly: true,
    strict: true,
  });
  database.exec("PRAGMA busy_timeout = 5000");
  return new ArchiveSearch(database);
}
