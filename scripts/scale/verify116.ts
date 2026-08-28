/**
 * End-of-run audit for #116, INDEPENDENT of the sampler that watched the run.
 *
 * The sampler's `foreignRows` is a good instrument but it is one instrument,
 * and it only ever asked one question (does an FTS query for another repo's
 * marker match anything). This file re-asks the isolation question from a
 * different direction, against the finished stores, so a single blind spot in
 * the sampler cannot pass the ticket's most important property on its own:
 *
 *   1. SESSION IDENTITY, not text. Every archived session id in repo i must
 *      belong to repo i. `seed116.ts` gives each repo its own session-id block
 *      (`...-116<i>-...` for Codex, `scale116-r<i>-...` for Claude), so this is
 *      checked by parsing the id rather than by matching body text. A leak that
 *      somehow stripped the marker word would still be caught here.
 *   2. RAW CONTENT SCAN, no FTS. Counts rows whose `content` LIKEs another
 *      repo's marker using a plain table scan, bypassing the FTS index
 *      entirely. If the index were stale or the trigger broken, the sampler's
 *      MATCH-based probe could read clean while the table was not.
 *   3. CORPUS SHAPE per repo, for the record: rows, distinct sessions, bytes.
 *
 * Written and committed BEFORE the run finished, for the same reason
 * `analyze116.ts` was committed before it started.
 */
import { Database } from "bun:sqlite";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const scratch = process.argv[2];
if (!scratch) throw new Error("usage: verify116.ts <scratch-root>");

const repos = readdirSync(scratch)
  .filter((name) => /^repo-\d+$/.test(name))
  .sort();

/** Which repo owns this session id, from seed116.ts's id scheme. Null = unknown. */
function ownerOf(sessionId: string): number | null {
  const claude = /^scale116-r(\d+)-/.exec(sessionId);
  if (claude?.[1] !== undefined) return Number(claude[1]);
  const codex = /^00000000-0000-0000-(\d{4})-/.exec(sessionId);
  if (codex?.[1] !== undefined) return Number(codex[1]) - 1160;
  return null;
}

const results = repos.map((name) => {
  const index = Number(name.slice("repo-".length));
  const database = new Database(join(scratch, name, ".argus/archive.db"), {
    readonly: true,
    strict: true,
  });
  try {
    database.exec("PRAGMA busy_timeout = 5000");
    const rows =
      database.query<{ count: number }, []>("SELECT count(*) AS count FROM archive_messages").get()
        ?.count ?? 0;
    const sessions = database
      .query<{ count: number; session_id: string }, []>(
        "SELECT session_id, count(*) AS count FROM archive_messages GROUP BY session_id",
      )
      .all();
    const foreignSessions = sessions.filter(
      (row) => ownerOf(row.session_id) !== index,
    );
    const unknownSessions = sessions.filter((row) => ownerOf(row.session_id) === null);

    // Plain table scan, no FTS: see item 2 in the docblock.
    const foreignContent: Record<string, number> = {};
    let foreignContentRows = 0;
    for (let other = 0; other < repos.length; other += 1) {
      if (other === index) continue;
      const count =
        database
          .query<{ count: number }, [string]>(
            "SELECT count(*) AS count FROM archive_messages WHERE content LIKE ?",
          )
          .get(`%marker${other}%`)?.count ?? 0;
      foreignContent[`marker${other}`] = count;
      foreignContentRows += count;
    }
    const ownContentRows =
      database
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM archive_messages WHERE content LIKE ?",
        )
        .get(`%marker${index}%`)?.count ?? 0;

    return {
      distinctSessions: sessions.length,
      foreignContent,
      foreignContentRows,
      // A session id this file cannot attribute is reported separately from a
      // session it can attribute to the WRONG repo; they are different failures.
      foreignSessionIds: foreignSessions
        .filter((row) => ownerOf(row.session_id) !== null)
        .map((row) => `${row.session_id}(${row.count})`),
      ownContentRows,
      repo: index,
      rows,
      unknownSessionIds: unknownSessions.map((row) => `${row.session_id}(${row.count})`),
    };
  } finally {
    database.close(false);
  }
});

const clean =
  results.length > 0 &&
  results.every(
    (result) =>
      result.foreignContentRows === 0 &&
      result.foreignSessionIds.length === 0 &&
      result.ownContentRows > 0,
  );

console.log(
  JSON.stringify(
    {
      repos: results,
      verdict: clean ? "ISOLATED" : "NOT ISOLATED",
    },
    null,
    2,
  ),
);
