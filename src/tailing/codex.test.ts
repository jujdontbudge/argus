import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createCodexSource } from "./codex";
import { Tailer } from "./tailer";

const fixtureRoot = fileURLToPath(
  new URL("../../tests/fixtures/codex", import.meta.url),
);

async function initializeRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const child = Bun.spawn(["git", "init", "--quiet", path], {
    stderr: "pipe",
    stdout: "pipe",
  });
  if ((await child.exited) !== 0) {
    throw new Error(await new Response(child.stderr).text());
  }
}

describe("Codex rollout source", () => {
  test("tails an envelope-era rollout and attributes it to its live git repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-codex-source-"));
    try {
      const repo = join(root, "repo");
      const codexHome = join(root, "codex");
      const rolloutDir = join(codexHome, "sessions/2025/09/20");
      await initializeRepo(repo);
      const canonicalRepo = await realpath(repo);
      await mkdir(rolloutDir, { recursive: true });
      const fixture = await Bun.file(join(fixtureRoot, "era-0.39.jsonl")).text();
      const rollout = join(
        rolloutDir,
        "rollout-2025-09-20T10-00-00-00000000-0000-0000-0000-000000000039.jsonl",
      );
      await writeFile(rollout, fixture.replaceAll("__CWD__", repo));

      const events = await new Tailer(createCodexSource({ codexHome })).catchUp();

      expect(events).toEqual([
        {
          type: "session-meta",
          sessionId: "00000000-0000-0000-0000-000000000039",
          agent: "codex",
          cwd: canonicalRepo,
          repo: canonicalRepo,
          version: "0.39.0",
          ts: "2025-09-20T10:00:00.000Z",
          file: rollout,
        },
        {
          type: "message",
          sessionId: "00000000-0000-0000-0000-000000000039",
          role: "user",
          text: "implement the rollout source",
          ts: "2025-09-20T10:00:01.000Z",
          candidate: true,
          file: rollout,
        },
        {
          type: "message",
          sessionId: "00000000-0000-0000-0000-000000000039",
          role: "assistant",
          text: "implemented",
          ts: "2025-09-20T10:00:02.000Z",
          candidate: false,
          file: rollout,
        },
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("latest turn cwd wins while resume and embedded parent metas do not re-own attribution", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-codex-source-"));
    try {
      const startRepo = join(root, "start-repo");
      const latestRepo = join(root, "latest-repo");
      const parentRepo = join(root, "parent-repo");
      await Promise.all([
        initializeRepo(startRepo),
        initializeRepo(latestRepo),
        initializeRepo(parentRepo),
      ]);
      const codexHome = join(root, "codex");
      const rolloutDir = join(codexHome, "sessions/2026/08/20");
      await mkdir(rolloutDir, { recursive: true });
      const fixture = await Bun.file(
        join(fixtureRoot, "edge-resume-fork-turn-context.jsonl"),
      ).text();
      const rollout = join(
        rolloutDir,
        "rollout-2026-08-20T10-00-00-11111111-1111-1111-1111-111111111111.jsonl",
      );
      await writeFile(
        rollout,
        fixture
          .replaceAll("__START_CWD__", startRepo)
          .replaceAll("__LATEST_CWD__", latestRepo)
          .replaceAll("__PARENT_CWD__", parentRepo),
      );

      const events = await new Tailer(createCodexSource({ codexHome })).catchUp();
      const metas = events.filter((event) => event.type === "session-meta");

      expect(metas).toEqual([
        {
          type: "session-meta",
          sessionId: "11111111-1111-1111-1111-111111111111",
          parentSessionId: "00000000-0000-0000-0000-000000000000",
          agent: "codex",
          cwd: await realpath(startRepo),
          repo: await realpath(startRepo),
          version: "0.149.0",
          ts: "2026-08-20T10:00:00.000Z",
          file: rollout,
        },
        {
          type: "session-meta",
          sessionId: "11111111-1111-1111-1111-111111111111",
          parentSessionId: "00000000-0000-0000-0000-000000000000",
          agent: "codex",
          cwd: await realpath(latestRepo),
          repo: await realpath(latestRepo),
          version: "0.149.0",
          ts: "2026-08-20T10:03:00.000Z",
          file: rollout,
        },
      ]);
      expect(
        events.filter((event) => event.type === "message").map((event) => ({
          sessionId: event.sessionId,
          text: event.text,
        })),
      ).toEqual([
        {
          sessionId: "11111111-1111-1111-1111-111111111111",
          text: "resumed prompt",
        },
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
