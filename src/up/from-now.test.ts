import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openArchiver } from "../eyes/archiver/archiver.ts";
import { createRepoTranscriptSource } from "../eyes/source.ts";
import { claudeProjectDir, Tailer } from "../tailing/index.ts";
import { startFromNow } from "./from-now.ts";

function row(value: unknown): string {
  return `${JSON.stringify(value)}\n`;
}

describe("start from now", () => {
  test("skips old bytes and still parses the next append without replaying the old file", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-from-now-"));
    try {
      const repo = join(root, "repo");
      const home = join(root, "home");
      const projectsRoot = join(home, ".claude", "projects");
      await Promise.all([
        mkdir(join(repo, ".argus"), { recursive: true }),
        mkdir(join(home, ".codex"), { recursive: true }),
      ]);
      const git = Bun.spawn(["git", "init", "--quiet", repo]);
      expect(await git.exited).toBe(0);
      await writeFile(
        join(repo, ".argus", "honcho.yaml"),
        "url: http://127.0.0.1:1\nworkspace: argus-fixture\n",
      );

      const project = claudeProjectDir(repo, projectsRoot);
      await mkdir(project, { recursive: true });
      const transcript = join(project, "session.jsonl");
      const sessionId = "from-now-session";
      await writeFile(
        transcript,
        row({
          type: "user",
          message: { role: "user", content: "old prompt" },
          timestamp: "2026-08-29T01:00:00.000Z",
          uuid: "old-user",
          sessionId,
          cwd: repo,
          version: "2.1.246",
        }) +
          row({
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "x".repeat(3 * 1024 * 1024) }],
            },
            timestamp: "2026-08-29T01:00:01.000Z",
            uuid: "old-assistant",
            sessionId,
          }),
      );

      const env = {
        HOME: home,
        CLAUDE_CONFIG_DIR: join(home, ".claude"),
        CODEX_HOME: join(home, ".codex"),
        HERMES_HOME: join(home, ".hermes"),
      };
      const registry = join(home, ".argus-repos");
      await writeFile(registry, `${repo}\n`);
      await expect(startFromNow(repo, env)).rejects.toThrow("run argus down first");
      await rm(registry);

      const report = await startFromNow(repo, env);
      expect(report.files).toBe(1);
      expect(report.bytes).toBeGreaterThan(3 * 1024 * 1024);

      const cursorPath = join(repo, ".argus", "eyes", "reviewer", "cursors.json");
      const cursors = (await Bun.file(cursorPath).json()) as Record<string, number>;
      for (const eye of ["digest", "honcho", "retro"]) {
        expect(await Bun.file(join(repo, ".argus", "eyes", eye, "cursors.json")).json())
          .toEqual(cursors);
      }
      const archiver = await openArchiver(repo);
      expect(archiver.cursors()).toEqual(cursors);
      archiver.close();

      await appendFile(
        transcript,
        row({
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "new reply" }],
          },
          timestamp: "2026-08-29T01:00:02.000Z",
          uuid: "new-assistant",
          sessionId,
        }),
      );
      const source = await createRepoTranscriptSource(repo, env);
      const events = await new Tailer(source, { cursors }).catchUp();
      expect(
        events.filter((event) => event.type === "message").map((event) => event.text),
      ).toEqual(["new reply"]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
