import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createHermesSource } from "./hermes";
import { Tailer } from "./tailer";

const fixtureSchema = fileURLToPath(
  new URL("../../tests/fixtures/hermes/state.sql", import.meta.url),
);

async function fixtureDatabase(
  root: string,
  slug = "widget-kit",
): Promise<{ db: Database; file: string }> {
  const profile = join(root, "profiles", `argus-${slug}`);
  await mkdir(profile, { recursive: true });
  const file = join(profile, "state.db");
  const db = new Database(file);
  db.exec(await Bun.file(fixtureSchema).text());
  return { db, file };
}

describe("Hermes state.db source", () => {
  test("polls configured profile homes by message id and decodes persisted content", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-hermes-source-"));
    try {
      const { db, file } = await fixtureDatabase(root);
      db.run(
        `INSERT INTO sessions
          (id, source, model, started_at, message_count, cwd)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ["session-a", "cli", "test-model", 1_777_000_000, 2, "/repo/widget"],
      );
      db.run(
        "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
        ["session-a", "user", "Run the Hermes source.", 1_777_000_001],
      );
      db.run(
        "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
        [
          "session-a",
          "assistant",
          '\u0000json:[{"type":"text","text":"Hermes finished."}]',
          1_777_000_002,
        ],
      );

      const tailer = new Tailer(createHermesSource({ hermesRoot: root }));
      const first = await tailer.catchUp();
      expect(first).toEqual([
        {
          type: "session-meta",
          sessionId: "session-a",
          agent: "hermes",
          cwd: "/repo/widget",
          model: "test-model",
          ts: "2026-04-24T03:06:40.000Z",
          file,
        },
        {
          type: "message",
          sessionId: "session-a",
          role: "user",
          text: "Run the Hermes source.",
          ts: "2026-04-24T03:06:41.000Z",
          candidate: true,
          file,
        },
        {
          type: "message",
          sessionId: "session-a",
          role: "assistant",
          text: "Hermes finished.",
          ts: "2026-04-24T03:06:42.000Z",
          candidate: false,
          file,
        },
      ]);
      expect(tailer.cursors()).toEqual({ [file]: 2 });
      expect(await tailer.catchUp()).toEqual([]);
      db.close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("replays rewrites once and filters soft-deleted and non-message roles", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-hermes-source-"));
    try {
      const { db, file } = await fixtureDatabase(root);
      db.run(
        `INSERT INTO sessions
          (id, source, started_at, message_count)
         VALUES (?, ?, ?, ?)`,
        ["session-rewrite", "cli", 1_777_100_000, 2],
      );
      const insert = db.query(
        `INSERT INTO messages
          (session_id, role, content, timestamp, active)
         VALUES (?, ?, ?, ?, ?)`,
      );
      insert.run("session-rewrite", "user", "original prompt", 1_777_100_001, 1);
      insert.run("session-rewrite", "assistant", "original answer", 1_777_100_002, 1);

      const firstTailer = new Tailer(createHermesSource({ hermesRoot: root }));
      const initial = await firstTailer.catchUp();
      const tailer = new Tailer(createHermesSource({ hermesRoot: root }), {
        cursors: firstTailer.cursors(),
      });
      expect(await tailer.catchUp()).toEqual([]);

      db.transaction(() => {
        db.run("DELETE FROM messages WHERE session_id = ?", ["session-rewrite"]);
        db.run("UPDATE sessions SET message_count = 3 WHERE id = ?", [
          "session-rewrite",
        ]);
        insert.run("session-rewrite", "user", "original prompt", 1_777_100_100, 1);
        insert.run(
          "session-rewrite",
          "assistant",
          "replacement answer",
          1_777_100_100,
          1,
        );
        insert.run("session-rewrite", "user", "new suffix", 1_777_100_100, 1);
        insert.run("session-rewrite", "tool", "tool output", 1_777_100_100, 1);
        insert.run("session-rewrite", "user", "rewound prompt", 1_777_100_100, 0);
      })();

      const replay = await tailer.catchUp();
      expect(
        [...initial, ...replay]
          .filter((event) => event.type === "message")
          .map(({ role, text }) => ({ role, text })),
      ).toEqual([
        { role: "user", text: "original prompt" },
        { role: "assistant", text: "original answer" },
        { role: "assistant", text: "replacement answer" },
        { role: "user", text: "new suffix" },
      ]);
      expect(tailer.cursors()).toEqual({ [file]: 7 });
      db.close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("stitches compression rotations to the logical root session", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-hermes-source-"));
    try {
      const { db } = await fixtureDatabase(root);
      const insertSession = db.query(
        `INSERT INTO sessions
          (id, source, parent_session_id, started_at, end_reason, message_count)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      insertSession.run("session-root", "cli", null, 1_777_200_000, "compression", 1);
      insertSession.run(
        "session-middle",
        "cli",
        "session-root",
        1_777_200_100,
        "compression",
        1,
      );
      insertSession.run(
        "session-current",
        "cli",
        "session-middle",
        1_777_200_200,
        null,
        1,
      );
      db.run(
        "INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)",
        ["session-current", "assistant", "continued after compression", 1_777_200_201],
      );

      const events = await new Tailer(
        createHermesSource({ hermesRoot: root }),
      ).catchUp();

      expect(events[0]).toMatchObject({
        type: "session-meta",
        sessionId: "session-current",
        parentSessionId: "session-root",
      });
      expect(events[1]).toMatchObject({
        type: "message",
        sessionId: "session-current",
        text: "continued after compression",
      });
      db.close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
