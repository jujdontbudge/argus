/**
 * Cross-repo isolation with N repos under ONE HOME (#116).
 *
 * `src/eyes/source.test.ts` already proves one repo excludes one foreign repo.
 * This file exists because #116's topology is different in a way that matters:
 * ONE supervisor holds 5xN watchers, and `supervisorConfiguration`
 * (`src/supervisor/control.ts:137-196`) resolves exactly one `homePath` /
 * `claudeConfigPath` / `codexHomePath` / `hermesHomePath`, which
 * `createWatcherSpawner` (`src/supervisor/daemon.ts:9-33`) hands to every child
 * unchanged. So all 5xN watchers scan ONE `~/.claude/projects` tree and ONE
 * `~/.codex/sessions` tree, and the ONLY thing keeping repo A's messages out of
 * repo B's archive is `sessionsForRepo`'s content filter in `./source.ts:26`.
 *
 * That makes isolation a property of a filter rather than of the filesystem,
 * and a filter is worth testing in every direction rather than in one.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
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

function claudeTranscript(sessionId: string, cwd: string, text: string): string {
  return (
    [
      {
        type: "user",
        message: { role: "user", content: text },
        timestamp: "2026-08-28T12:00:00.000Z",
        uuid: `${sessionId}-user`,
        sessionId,
        cwd,
        version: "2.1.246",
      },
      {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text }] },
        timestamp: "2026-08-28T12:00:01.000Z",
        uuid: `${sessionId}-assistant`,
        sessionId,
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n"
  );
}

function codexRollout(sessionId: string, cwd: string, text: string): string {
  return (
    [
      {
        timestamp: "2026-08-28T12:00:00.000Z",
        ordinal: 0,
        type: "session_meta",
        payload: { id: sessionId, session_id: sessionId, cwd, cli_version: "0.149.0" },
      },
      {
        timestamp: "2026-08-28T12:00:01.000Z",
        ordinal: 1,
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text }],
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n") + "\n"
  );
}

const REPO_COUNT = 3;

describe("N repos under one HOME", () => {
  test("each repo's source sees only its own sessions, in every direction", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-multi-repo-"));
    try {
      const home = join(root, "home");
      const projectsRoot = join(home, ".claude/projects");
      const codexSessions = join(home, ".codex/sessions/2026/08/28");
      await mkdir(codexSessions, { recursive: true });

      const repos: string[] = [];
      for (let index = 0; index < REPO_COUNT; index += 1) {
        // Distinct basenames AND distinct `.git` roots: `repositoryFor` walks up
        // to the nearest `.git`, so sibling scratch repos must each be their own
        // repository or they would collapse onto one identity.
        const repo = join(root, `repo-${index}`);
        await mkdir(repo, { recursive: true });
        await runGit(repo, ["init", "--quiet"]);
        await runGit(repo, ["commit", "--quiet", "--allow-empty", "-m", "fixture"]);
        await mkdir(join(repo, ".argus"), { recursive: true });
        // A DISTINCT Honcho workspace per repo. The Hermes source is the one
        // branch of `combine()` that is NOT wrapped in `sessionsForRepo` — it is
        // scoped by workspace instead — so two repos sharing a workspace would
        // share a Hermes stream. Keeping them distinct is what makes that safe.
        await writeFile(
          join(repo, ".argus/honcho.yaml"),
          `url: http://127.0.0.1:1\nworkspace: argus-multi-${index}\n`,
        );
        repos.push(repo);
      }

      // One transcript per repo per source, all in the SAME shared projects and
      // codex trees, each tagged with a marker word unique to its repo.
      for (const [index, repo] of repos.entries()) {
        const project = claudeProjectDir(repo, projectsRoot);
        await mkdir(project, { recursive: true });
        await writeFile(
          join(project, `claude-${index}.jsonl`),
          claudeTranscript(`claude-session-${index}`, repo, `marker${index} claude body`),
        );
        await writeFile(
          join(codexSessions, `rollout-2026-08-28T12-00-00-codex-${index}.jsonl`),
          codexRollout(`codex-session-${index}`, repo, `marker${index} codex body`),
        );
      }

      for (const [index, repo] of repos.entries()) {
        const source = await createRepoTranscriptSource(repo, { HOME: home });
        const events = await new Tailer(source).catchUp();
        const texts = events.flatMap((event) =>
          event.type === "message" ? [event.text] : [],
        );
        const sessions = events.flatMap((event) =>
          event.type === "session-meta" ? [event.sessionId] : [],
        );

        // Sees its own, from both sources.
        expect(sessions.sort()).toEqual([
          `claude-session-${index}`,
          `codex-session-${index}`,
        ]);
        expect(texts.every((text) => text.includes(`marker${index}`))).toBe(true);
        expect(texts.length).toBeGreaterThan(0);

        // Sees no other repo's, from either source. This is the assertion the
        // ticket calls the single most important correctness property.
        for (let other = 0; other < REPO_COUNT; other += 1) {
          if (other === index) continue;
          expect(texts.some((text) => text.includes(`marker${other}`))).toBe(false);
          expect(sessions).not.toContain(`claude-session-${other}`);
          expect(sessions).not.toContain(`codex-session-${other}`);
        }
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  }, 60_000);
});
