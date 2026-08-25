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
          version: "test-model",
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
});
