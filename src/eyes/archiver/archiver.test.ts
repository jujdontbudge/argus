import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ProvenanceClassifier } from "../../provenance";
import { createClaudeCodeSource, createCodexSource, Tailer } from "../../tailing";
import { ArchiverEye } from "./index";

const T0 = "2026-08-24T10:00:00.000Z";

function userLine(
  uuid: string | undefined,
  text: string,
  ts: string,
  promptSource: string | undefined = "typed",
): string {
  return `${JSON.stringify({
    type: "user",
    message: { role: "user", content: text },
    timestamp: ts,
    ...(promptSource !== undefined && { promptSource }),
    ...(uuid !== undefined && { uuid }),
    sessionId: "session-26",
    cwd: "/tmp/sandbox",
    version: "2.1.241",
    isSidechain: false,
  })}\n`;
}

function assistantLine(uuid: string, text: string, ts: string): string {
  return `${JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text }] },
    timestamp: ts,
    uuid,
    sessionId: "session-26",
  })}\n`;
}

function classifier(): ProvenanceClassifier {
  const value = new ProvenanceClassifier();
  value.registerSession({
    ts: T0,
    sessionId: "session-26",
    agent: "claude-code",
    ticket: "26",
    dispatchPrompt: "Implement the archive.",
  });
  return value;
}

describe("ArchiverEye", () => {
  test("archives every tailed message and a cursor-reset replay inserts no duplicates", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-archiver-"));
    const repo = join(root, "repo");
    const transcripts = join(root, "transcripts");
    const transcript = join(transcripts, "session-26.jsonl");
    await Bun.write(join(repo, ".gitkeep"), "");
    await Bun.write(join(transcripts, ".gitkeep"), "");
    await writeFile(
      transcript,
      userLine("u-1", "Implement the archive.", T0) +
        assistantLine("a-1", "Capturing everything.", "2026-08-24T10:00:01.000Z") +
        userLine(
          "u-2",
          "<bash-stdout>zero judgment</bash-stdout><bash-stderr></bash-stderr>",
          "2026-08-24T10:00:02.000Z",
          undefined,
        ),
    );

    try {
      const source = createClaudeCodeSource({ dir: transcripts });
      const eye = await ArchiverEye.open({ repo });
      const first = new Tailer(source, { cursors: eye.cursors() });

      expect(await eye.catchUp(first, classifier())).toEqual({
        inserted: 3,
        received: 3,
      });
      expect(eye.messageCount()).toBe(3);

      const reset = new Tailer(source);
      expect(await eye.catchUp(reset, classifier())).toEqual({
        inserted: 0,
        received: 3,
      });
      expect(eye.messageCount()).toBe(3);

      await appendFile(
        transcript,
        userLine("u-3", "An appended message.", "2026-08-24T10:00:03.000Z"),
      );
      const resumed = new Tailer(source, { cursors: eye.cursors() });
      expect(await eye.catchUp(resumed, classifier())).toEqual({
        inserted: 1,
        received: 1,
      });
      expect(eye.messageCount()).toBe(4);
      const persistedCursors = eye.cursors();
      eye.close();

      const reopened = await ArchiverEye.open({ repo });
      expect(reopened.cursors()).toEqual(persistedCursors);
      expect(reopened.messageCount()).toBe(4);
      reopened.close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("fallback keys preserve repeated no-uuid messages and still dedupe replay", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-archiver-no-uuid-"));
    const repo = join(root, "repo");
    const transcripts = join(root, "transcripts");
    const transcript = join(transcripts, "session-26.jsonl");
    await Bun.write(join(repo, ".gitkeep"), "");
    await Bun.write(join(transcripts, ".gitkeep"), "");
    const repeated = userLine(undefined, "same message", T0);
    await writeFile(transcript, repeated + repeated);

    try {
      const physical = createClaudeCodeSource({ dir: transcripts });
      const source = {
        ...physical,
        fileKey: () => "logical-session-26",
      };
      const eye = await ArchiverEye.open({ repo });
      expect((await eye.catchUp(new Tailer(source), classifier())).inserted).toBe(2);

      await appendFile(transcript, repeated);
      expect(
        (
          await eye.catchUp(
            new Tailer(source, { cursors: eye.cursors() }),
            classifier(),
          )
        ).inserted,
      ).toBe(1);
      expect(eye.messageCount()).toBe(3);

      expect((await eye.catchUp(new Tailer(source), classifier())).inserted).toBe(0);
      expect(eye.messageCount()).toBe(3);
      eye.close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  // The #117 regression, at the layer where it was actually observed. Every
  // test above uses a Claude Code source, which is why none of them caught it:
  // `ClaudeCodeParser` re-emits session-meta from the first record carrying a
  // `cwd`, so a resumed Claude parser heals itself on its next user line. A
  // Codex rollout carries its `session_meta` exactly ONCE, as line one, and a
  // parser resumed past it emits nothing at all — silently, with a clean
  // `backlog: 0` and no error, forever.
  //
  // Live shape: SIGKILL an archiver at minute 2, the supervisor restarts it
  // inside budget, the replacement takes the lease and reports healthy, and 275
  // of 405 sentinel messages never land.
  test("an archiver restarted on its persisted cursors keeps archiving codex", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-archiver-resume-"));
    try {
      const repo = join(root, "repo");
      const codexHome = join(root, "codex");
      const sessions = join(codexHome, "sessions", "2026", "08", "28");
      await mkdir(join(repo, ".git"), { recursive: true });
      await mkdir(sessions, { recursive: true });
      const id = "00000000-0000-0000-1170-000000117001";
      const rollout = join(sessions, `rollout-2026-08-28T00-00-00-${id}.jsonl`);
      const codexLine = (ordinal: number, type: "session_meta" | "response_item"): string =>
        `${JSON.stringify(
          type === "session_meta"
            ? {
                timestamp: T0,
                type,
                payload: { id, session_id: id, cwd: repo, cli_version: "0.149.0" },
              }
            : {
                timestamp: new Date(Date.UTC(2026, 7, 28, 0, 0, ordinal)).toISOString(),
                type,
                payload: {
                  type: "message",
                  role: "user",
                  content: [{ type: "input_text", text: `restart probe ${ordinal}` }],
                },
              },
        )}\n`;
      await writeFile(rollout, codexLine(0, "session_meta"));
      await appendFile(rollout, codexLine(1, "response_item"));

      const source = createCodexSource({ codexHome });
      const before = await ArchiverEye.open({ repo });
      expect((await before.catchUp(new Tailer(source), new ProvenanceClassifier())).inserted).toBe(1);
      const cursors = before.cursors();

      // The process dies here. Everything below is what the supervisor's
      // replacement watcher constructs from persisted state alone.
      await appendFile(rollout, codexLine(2, "response_item"));
      const after = await ArchiverEye.open({ repo });
      const batch = await after.catchUp(
        new Tailer(createCodexSource({ codexHome }), { cursors }),
        new ProvenanceClassifier(),
      );

      expect(batch.inserted).toBe(1);
      expect(after.messageCount()).toBe(2);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
