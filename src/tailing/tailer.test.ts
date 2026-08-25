import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaudeCodeSource } from "./claude-code";
import type { TailEvent } from "./events";
import { Tailer } from "./tailer";

function line(sessionId: string, uuid: string, text: string, ts: string): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
    timestamp: ts,
    promptSource: "typed",
    uuid,
    sessionId,
    cwd: "/tmp/proj",
    version: "2.1.241",
    isSidechain: false,
  })}\n`;
}

function texts(events: TailEvent[]): string[] {
  return events.filter((e) => e.type === "message").map((e) => e.text);
}

async function withDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "argus-tailer-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { force: true, recursive: true });
  }
}

describe("Tailer.catchUp", () => {
  test("reads every file from zero and advances cursors", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "s-1.jsonl");
      await writeFile(
        file,
        line("s-1", "u-1", "first", "2026-08-24T10:00:00.000Z") +
          line("s-1", "u-2", "second", "2026-08-24T10:00:01.000Z"),
      );
      const tailer = new Tailer(createClaudeCodeSource({ dir }));

      const events = await tailer.catchUp();

      expect(texts(events)).toEqual(["first", "second"]);
      expect(events[0]?.type).toBe("session-meta");
      expect(tailer.cursors()).toEqual({ [file]: (await Bun.file(file).text()).length });
    });
  });

  test("a second catchUp emits only what was appended since", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "s-1.jsonl");
      await writeFile(file, line("s-1", "u-1", "first", "2026-08-24T10:00:00.000Z"));
      const tailer = new Tailer(createClaudeCodeSource({ dir }));
      await tailer.catchUp();

      await appendFile(file, line("s-1", "u-2", "second", "2026-08-24T10:00:01.000Z"));
      const events = await tailer.catchUp();

      expect(texts(events)).toEqual(["second"]);
      expect(events.filter((e) => e.type === "session-meta")).toEqual([]);
    });
  });

  test("a partial line is held back until its newline lands (no torn records)", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "s-1.jsonl");
      const full = line("s-1", "u-1", "whole record", "2026-08-24T10:00:00.000Z");
      await writeFile(file, full.slice(0, 25)); // mid-JSON, no newline yet
      const tailer = new Tailer(createClaudeCodeSource({ dir }));

      expect(await tailer.catchUp()).toEqual([]);

      await appendFile(file, full.slice(25));
      const events = await tailer.catchUp();
      expect(texts(events)).toEqual(["whole record"]);
    });
  });

  // §13 scenario 6: watcher dies, restarts from persisted cursors, and the
  // backfill loses nothing and duplicates nothing.
  test("a restarted tailer backfills everything written while it was dead", async () => {
    await withDir(async (dir) => {
      const file1 = join(dir, "s-1.jsonl");
      await writeFile(
        file1,
        line("s-1", "u-1", "before death 1", "2026-08-24T10:00:00.000Z") +
          line("s-1", "u-2", "before death 2", "2026-08-24T10:00:01.000Z"),
      );
      const first = new Tailer(createClaudeCodeSource({ dir }));
      const beforeDeath = await first.catchUp();
      expect(texts(beforeDeath)).toEqual(["before death 1", "before death 2"]);
      // Persist exactly what a real watcher would: serialized cursors.
      const persisted = JSON.stringify(first.cursors());

      // Watcher is dead; sessions keep writing — an append AND a new session.
      await appendFile(
        file1,
        line("s-1", "u-3", "while dead", "2026-08-24T10:05:00.000Z"),
      );
      const file2 = join(dir, "s-2.jsonl");
      await writeFile(
        file2,
        line("s-2", "u-4", "new session while dead", "2026-08-24T10:06:00.000Z"),
      );

      const restarted = new Tailer(createClaudeCodeSource({ dir }), {
        cursors: JSON.parse(persisted),
      });
      const backfill = await restarted.catchUp();

      expect(texts(backfill)).toEqual(["while dead", "new session while dead"]);
      // Zero loss, zero duplication across the death.
      const allTexts = [...texts(beforeDeath), ...texts(backfill)];
      expect(allTexts).toEqual([
        "before death 1",
        "before death 2",
        "while dead",
        "new session while dead",
      ]);
    });
  });

  test("rotation (shorter file at the same path) emits file-truncated and reparses", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "s-1.jsonl");
      await writeFile(
        file,
        line("s-1", "u-1", "old life 1", "2026-08-24T10:00:00.000Z") +
          line("s-1", "u-2", "old life 2", "2026-08-24T10:00:01.000Z"),
      );
      const tailer = new Tailer(createClaudeCodeSource({ dir }));
      await tailer.catchUp();

      await writeFile(file, line("s-9", "u-9", "new life", "2026-08-24T11:00:00.000Z"));
      const events = await tailer.catchUp();

      expect(events[0]).toEqual({ type: "lifecycle", kind: "file-truncated", file });
      expect(texts(events)).toEqual(["new life"]);
      // Fresh parser state: the successor session announces itself.
      expect(events.filter((e) => e.type === "session-meta").map((e) => e.sessionId)).toEqual(["s-9"]);
    });
  });
});

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 3_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(10);
  }
}

describe("Tailer.watch", () => {
  test("streams appended events to the listener until stopped", async () => {
    await withDir(async (dir) => {
      const file = join(dir, "s-1.jsonl");
      await writeFile(file, line("s-1", "u-1", "first", "2026-08-24T10:00:00.000Z"));
      const tailer = new Tailer(createClaudeCodeSource({ dir }));
      const received: TailEvent[] = [];

      const stop = tailer.watch((events) => received.push(...events), { pollMs: 20 });
      await until(() => texts(received).includes("first"), "the initial batch");

      await appendFile(file, line("s-1", "u-2", "second", "2026-08-24T10:00:01.000Z"));
      await until(() => texts(received).includes("second"), "the appended line");

      await stop();
      await appendFile(file, line("s-1", "u-3", "third", "2026-08-24T10:00:02.000Z"));
      await Bun.sleep(100);

      expect(texts(received)).toEqual(["first", "second"]);
    });
  });

  test("watch discovers files created after it started", async () => {
    await withDir(async (dir) => {
      const tailer = new Tailer(createClaudeCodeSource({ dir }));
      const received: TailEvent[] = [];
      const stop = tailer.watch((events) => received.push(...events), { pollMs: 20 });

      try {
        await writeFile(
          join(dir, "late.jsonl"),
          line("s-9", "u-9", "late arrival", "2026-08-24T10:10:00.000Z"),
        );
        await until(() => texts(received).includes("late arrival"), "the new file");
      } finally {
        await stop();
      }
    });
  });
});
