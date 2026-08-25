import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ArchiverEye } from "../eyes/archiver/archiver";
import { ProvenanceClassifier } from "../provenance";
import { createClaudeCodeSource, Tailer } from "../tailing";
import { openArchiveSearch } from "./search";

const SESSION = "past-sandbox-session";
const T0 = "2026-08-24T12:00:00.000Z";

function line(
  uuid: string,
  role: "user" | "assistant",
  text: string,
  ts: string,
): string {
  return `${JSON.stringify({
    type: role,
    message:
      role === "user"
        ? { role, content: text }
        : { role, content: [{ type: "text", text }] },
    timestamp: ts,
    ...(role === "user" && { promptSource: "typed" }),
    uuid,
    sessionId: SESSION,
    cwd: "/tmp/sandbox",
    version: "2.1.241",
    isSidechain: false,
  })}\n`;
}

function classifier(): ProvenanceClassifier {
  const value = new ProvenanceClassifier();
  value.registerSession({
    ts: T0,
    sessionId: SESSION,
    agent: "codex",
    ticket: "26",
    dispatchPrompt: "Touch src/tailing/events.ts and preserve parseJSONL_value.",
  });
  return value;
}

describe("archive search", () => {
  test("finds code content with attribution and bounds snippets for full long messages", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-search-"));
    const repo = join(root, "repo");
    const transcripts = join(root, "transcripts");
    const transcript = join(transcripts, `${SESSION}.jsonl`);
    await mkdir(repo);
    await mkdir(transcripts);
    const longMessage =
      `Beginning of a very long response. ${"padding ".repeat(20_000)}` +
      "the terminal marker is needle_at_the_end.";
    await writeFile(
      transcript,
      line(
        "u-1",
        "user",
        "Touch src/tailing/events.ts and preserve parseJSONL_value.",
        T0,
      ) + line("a-1", "assistant", longMessage, "2026-08-24T12:01:00.000Z"),
    );

    try {
      const source = createClaudeCodeSource({ dir: transcripts });
      const eye = await ArchiverEye.open({ repo });
      await eye.catchUp(new Tailer(source), classifier());

      // Keep one read connection alive while the writer continues ingesting.
      const search = openArchiveSearch({ repo });
      for (const query of ["src/tailing/events.ts", "parseJSONL_value"]) {
        const [result] = search.query(query);
        expect(result).toMatchObject({
          agent: "codex",
          provenance: "hermes",
          role: "user",
          sessionId: SESSION,
          ticket: "26",
          ts: T0,
        });
        expect(result!.snippet).toContain(query);
      }

      const [longResult] = search.query("needle_at_the_end");
      expect(longResult!.sessionId).toBe(SESSION);
      expect(longResult!.snippet).toContain("needle_at_the_end");
      expect(longResult!.snippet.length).toBeLessThanOrEqual(320);

      await appendFile(
        transcript,
        line(
          "a-2",
          "assistant",
          "WAL readers see this later commit.",
          "2026-08-24T12:02:00.000Z",
        ),
      );
      await eye.catchUp(
        new Tailer(source, { cursors: eye.cursors() }),
        classifier(),
      );
      expect(search.query("later commit")).toHaveLength(1);

      search.close();
      eye.close();
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
