import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeProjectDir, Tailer } from "../tailing/index.ts";
import { createRepoTranscriptSource } from "./source.ts";

const GIT_ENV = {
  ...Bun.env,
  GIT_AUTHOR_EMAIL: "fixture@invalid.example",
  GIT_AUTHOR_NAME: "Argus Fixture",
  GIT_COMMITTER_EMAIL: "fixture@invalid.example",
  GIT_COMMITTER_NAME: "Argus Fixture",
};

async function runGit(cwd: string, args: string[]): Promise<void> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    env: GIT_ENV,
    stderr: "pipe",
    stdout: "pipe",
  });
  if ((await child.exited) !== 0) {
    throw new Error(await new Response(child.stderr).text());
  }
}

function transcript(sessionId: string, cwd: string, text: string): string {
  return [
    {
      type: "user",
      message: { role: "user", content: `dispatch ${text}` },
      timestamp: "2026-08-26T12:00:00.000Z",
      uuid: `${sessionId}-user`,
      sessionId,
      cwd,
      version: "2.1.246",
    },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text }] },
      timestamp: "2026-08-26T12:00:01.000Z",
      uuid: `${sessionId}-assistant`,
      sessionId,
    },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n";
}

describe("repo transcript source", () => {
  test("reads Claude sessions from this repo's worktrees and excludes other repos", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-repo-source-"));
    try {
      const home = join(root, "home");
      const parent = join(root, "parent");
      const parentAlias = join(root, "parent-alias");
      const worktree = join(root, "worktrees/ticket-75");
      const foreign = join(root, "foreign");
      const projectsRoot = join(home, ".claude/projects");

      await Promise.all([
        mkdir(parent, { recursive: true }),
        mkdir(foreign, { recursive: true }),
      ]);
      await runGit(parent, ["init", "--quiet"]);
      await runGit(parent, ["commit", "--quiet", "--allow-empty", "-m", "fixture"]);
      await mkdir(join(root, "worktrees"), { recursive: true });
      await runGit(parent, ["worktree", "add", "--quiet", "--detach", worktree]);
      await runGit(foreign, ["init", "--quiet"]);
      await runGit(foreign, ["commit", "--quiet", "--allow-empty", "-m", "foreign"]);
      await symlink(parent, parentAlias, "dir");
      await mkdir(join(parent, ".argus"), { recursive: true });
      await writeFile(
        join(parent, ".argus/honcho.yaml"),
        "url: http://127.0.0.1:1\nworkspace: argus-parent\n",
      );

      const worktreeProject = claudeProjectDir(worktree, projectsRoot);
      const foreignProject = claudeProjectDir(foreign, projectsRoot);
      await Promise.all([
        mkdir(worktreeProject, { recursive: true }),
        mkdir(foreignProject, { recursive: true }),
      ]);
      await Promise.all([
        writeFile(
          join(worktreeProject, "worktree-session.jsonl"),
          transcript("worktree-session", worktree, "worktree reply"),
        ),
        writeFile(
          join(foreignProject, "foreign-session.jsonl"),
          transcript("foreign-session", foreign, "foreign reply"),
        ),
      ]);

      const source = await createRepoTranscriptSource(parentAlias, {
        HOME: home,
      });
      const events = await new Tailer(source).catchUp();

      expect(events).toContainEqual(
        expect.objectContaining({
          type: "session-meta",
          sessionId: "worktree-session",
          cwd: worktree,
          repo: await realpath(parent),
        }),
      );
      expect(
        events.filter((event) => event.type === "message").map((event) => event.text),
      ).toEqual(["dispatch worktree reply", "worktree reply"]);
      expect(events.some((event) => event.sessionId === "foreign-session")).toBe(false);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
