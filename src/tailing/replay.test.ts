import { describe, expect, test } from "bun:test";
import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createClaudeCodeSource } from "./claude-code";
import type { TailEvent } from "./events";
import { Tailer } from "./tailer";

const fixtureDir = fileURLToPath(
  new URL("../../tests/fixtures/claude-code/", import.meta.url),
);
const fixtureFile = join(fixtureDir, "edge-cases.jsonl");

async function replayFixture(): Promise<TailEvent[]> {
  return new Tailer(createClaudeCodeSource({ dir: fixtureDir })).catchUp();
}

/** The comparison shape the edge-case expectations pin (hand-derived). */
function project(event: TailEvent) {
  if (event.type === "message") {
    return {
      type: event.type,
      role: event.role,
      text: event.text,
      candidate: event.candidate,
      ...(event.promptSource !== undefined && { promptSource: event.promptSource }),
    };
  }
  if (event.type === "lifecycle") {
    return { type: event.type, kind: event.kind, ...(event.content !== undefined && { content: event.content }) };
  }
  return { type: event.type, sessionId: event.sessionId };
}

describe("edge-case fixture replay (ticket #21 / #11 findings)", () => {
  test("the full event stream is exactly the hand-derived expectation", async () => {
    const events = await replayFixture();

    // The fixture also encodes the /help zero-record command by absence
    // (sent between u12 and the next-morning resume): exact equality below
    // proves the tailer fabricates nothing in that gap.
    expect(events.map(project)).toEqual([
      { type: "session-meta", sessionId: "s-edge" },
      { type: "message", role: "user", text: "start work please", candidate: true, promptSource: "typed" },
      { type: "message", role: "assistant", text: "Working on it.", candidate: false },
      // Multi-line shatter (§1.3): line one typed, the rest queued.
      { type: "message", role: "user", text: "E2 line one", candidate: true, promptSource: "typed" },
      { type: "lifecycle", kind: "queue-enqueue", content: "E2 line two" },
      { type: "lifecycle", kind: "queue-enqueue", content: "E2 line three" },
      { type: "message", role: "assistant", text: "Line one handled.", candidate: false },
      { type: "lifecycle", kind: "queue-dequeue" },
      { type: "message", role: "user", text: "E2 line two", candidate: true, promptSource: "queued" },
      { type: "lifecycle", kind: "queue-dequeue" },
      { type: "message", role: "user", text: "E2 line three", candidate: true, promptSource: "queued" },
      // Slash command derived form (§2.3); its isMeta companion emits nothing.
      {
        type: "message",
        role: "user",
        text: "<command-message>caveman</command-message>\n<command-name>/caveman</command-name>\n<command-args>hello there</command-args>",
        candidate: true,
        promptSource: "typed",
      },
      // Bang command: input is a candidate, stdout is not (§2.3).
      { type: "message", role: "user", text: "<bash-input>echo hermes-bang-probe</bash-input>", candidate: true },
      {
        type: "message",
        role: "user",
        text: "<bash-stdout>hermes-bang-probe</bash-stdout><bash-stderr></bash-stderr>",
        candidate: false,
      },
      { type: "message", role: "user", text: "sidechain internal", candidate: false, promptSource: "typed" },
      // Resumed across days: same session file, next-day timestamp.
      { type: "message", role: "user", text: "resumed next morning", candidate: true, promptSource: "typed" },
    ]);
  });

  test("queued landings carry the dequeue-time stamp, not the enqueue time", async () => {
    const events = await replayFixture();

    const queued = events.find(
      (e) => e.type === "message" && e.text === "E2 line two",
    );
    const enqueue = events.find(
      (e) => e.type === "lifecycle" && e.content === "E2 line two",
    );
    if (queued?.type !== "message" || enqueue?.type !== "lifecycle") {
      throw new Error("fixture events missing");
    }
    expect(enqueue.ts).toBe("2026-08-23T22:01:00.500Z"); // ≈ send time
    expect(queued.ts).toBe("2026-08-23T22:01:21.100Z"); // dequeue = turn end
  });

  test("replay is byte-stable: independent replays serialize identically", async () => {
    const [a, b] = await Promise.all([replayFixture(), replayFixture()]);

    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.length).toBeGreaterThan(0);
  });

  test("cursor-chunked replay equals one-shot replay (split mid-line)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "argus-replay-"));
    try {
      const bytes = await readFile(fixtureFile);
      const split = Math.floor(bytes.length * 0.6); // lands mid-record
      const file = join(dir, "edge-cases.jsonl");
      const tailer = new Tailer(createClaudeCodeSource({ dir }));

      await writeFile(file, bytes.subarray(0, split));
      const firstHalf = await tailer.catchUp();
      await appendFile(file, bytes.subarray(split));
      const secondHalf = await tailer.catchUp();

      const oneShot = await replayFixture();
      const rebase = (events: TailEvent[]) =>
        events.map((e) => ({ ...e, file: "<file>" }));
      expect(rebase([...firstHalf, ...secondHalf])).toEqual(rebase(oneShot));
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
