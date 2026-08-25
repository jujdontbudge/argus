import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ArchiverEye } from "../src/eyes/archiver/archiver";
import { ProvenanceClassifier } from "../src/provenance";
import { createClaudeCodeSource, Tailer } from "../src/tailing";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function run(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stderr: "pipe", stdout: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

describe("argus search CLI", () => {
  test("answers a seeded query from a past sandbox session from any repo subdir", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-search-cli-"));
    const repo = join(root, "sandbox-repo");
    const nested = join(repo, "packages/app/src");
    const transcripts = join(root, "transcripts");
    const transcript = join(transcripts, "past-cli-session.jsonl");
    await mkdir(nested, { recursive: true });
    await mkdir(transcripts);
    expect((await run(["git", "init", "-q"], repo)).exitCode).toBe(0);

    const text =
      "The seeded answer is in src/archive/retention_policy.ts for later agents.";
    await writeFile(
      transcript,
      `${JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text }] },
        timestamp: "2026-08-20T08:15:00.000Z",
        uuid: "past-answer-1",
        sessionId: "past-cli-session",
        cwd: repo,
        version: "2.1.241",
      })}\n`,
    );

    try {
      const classifier = new ProvenanceClassifier();
      classifier.registerSession({
        ts: "2026-08-20T08:00:00.000Z",
        sessionId: "past-cli-session",
        agent: "codex",
        ticket: "26",
        dispatchPrompt: "Find the retention policy.",
      });
      const eye = await ArchiverEye.open({ repo });
      await eye.catchUp(
        new Tailer(createClaudeCodeSource({ dir: transcripts })),
        classifier,
      );
      eye.close();

      const result = await run(
        [process.execPath, cli, "search", "retention_policy.ts"],
        nested,
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("past-cli-session");
      expect(result.stdout).toContain("2026-08-20T08:15:00.000Z");
      expect(result.stdout).toContain("agent=codex");
      expect(result.stdout).toContain("ticket=#26");
      expect(result.stdout).toContain("retention_policy.ts");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
