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

async function runGit(cwd: string, args: string[]): Promise<void> {
  const child = Bun.spawn(["git", "-C", cwd, ...args], {
    env: {
      ...Bun.env,
      GIT_AUTHOR_EMAIL: "fixture@invalid.example",
      GIT_AUTHOR_NAME: "Argus Fixture",
      GIT_COMMITTER_EMAIL: "fixture@invalid.example",
      GIT_COMMITTER_NAME: "Argus Fixture",
    },
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

  test("resolves a live linked worktree cwd to its parent checkout", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-codex-source-"));
    try {
      const repo = join(root, "parent");
      const worktree = join(root, "worktrees/ticket-22");
      const nested = join(worktree, "nested/directory");
      await initializeRepo(repo);
      await runGit(repo, ["commit", "--quiet", "--allow-empty", "-m", "fixture"]);
      await mkdir(join(root, "worktrees"), { recursive: true });
      await runGit(repo, ["worktree", "add", "--quiet", "--detach", worktree]);
      await mkdir(nested, { recursive: true });

      const codexHome = join(root, "codex");
      const rolloutDir = join(codexHome, "sessions/2026/05/01");
      await mkdir(rolloutDir, { recursive: true });
      const rollout = join(
        rolloutDir,
        "rollout-2026-05-01T10-00-00-22222222-2222-2222-2222-222222222222.jsonl",
      );
      const fixture = await Bun.file(
        join(fixtureRoot, "edge-worktree.jsonl"),
      ).text();
      await writeFile(rollout, fixture.replaceAll("__WORKTREE_CWD__", nested));

      const events = await new Tailer(createCodexSource({ codexHome })).catchUp();
      const meta = events.find((event) => event.type === "session-meta");

      expect(meta).toMatchObject({
        cwd: await realpath(nested),
        repo: await realpath(repo),
        sessionId: "22222222-2222-2222-2222-222222222222",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("uses the best-effort git snapshot only when the recorded cwd is dead", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-codex-source-"));
    try {
      const parentRepo = join(root, "surviving-parent");
      await initializeRepo(parentRepo);
      const codexHome = join(root, "codex");
      const rolloutDir = join(codexHome, "sessions/2026/06/01");
      await mkdir(rolloutDir, { recursive: true });
      const rollout = join(
        rolloutDir,
        "rollout-2026-06-01T10-00-00-33333333-3333-3333-3333-333333333333.jsonl",
      );
      const fixture = await Bun.file(
        join(fixtureRoot, "edge-dead-worktree.jsonl"),
      ).text();
      await writeFile(
        rollout,
        fixture
          .replaceAll("__DEAD_CWD__", join(root, "deleted-worktree"))
          .replaceAll("__REPOSITORY_URL__", parentRepo),
      );

      const events = await new Tailer(createCodexSource({ codexHome })).catchUp();

      expect(events[0]).toMatchObject({
        cwd: join(await realpath(root), "deleted-worktree"),
        repo: await realpath(parentRepo),
        gitBranch: "build/deleted-lane",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("recovers pre-0.32 flat rollouts from the environment-context cwd", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-codex-source-"));
    try {
      const repo = join(root, "legacy-repo");
      await initializeRepo(repo);
      const codexHome = join(root, "codex");
      const rolloutDir = join(codexHome, "sessions/2025/09/10");
      await mkdir(rolloutDir, { recursive: true });
      const rollout = join(
        rolloutDir,
        "rollout-2025-09-10T19-50-10-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl",
      );
      const fixture = await Bun.file(
        join(fixtureRoot, "era-pre-0.32-flat.jsonl"),
      ).text();
      await writeFile(rollout, fixture.replaceAll("__CWD__", repo));

      const events = await new Tailer(createCodexSource({ codexHome })).catchUp();

      expect(events.map((event) => event.type)).toEqual([
        "session-meta",
        "message",
        "message",
        "message",
      ]);
      expect(events[0]).toEqual({
        type: "session-meta",
        sessionId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        agent: "codex",
        cwd: await realpath(repo),
        repo: await realpath(repo),
        ts: "2025-09-10T19:50:10.000Z",
        file: rollout,
      });
      expect(
        events.filter((event) => event.type === "message").map(({ text, candidate }) => ({
          text,
          candidate,
        })),
      ).toEqual([
        {
          text: `<environment_context>\n  <cwd>${repo}</cwd>\n  <shell>zsh</shell>\n</environment_context>`,
          candidate: false,
        },
        { text: "legacy prompt", candidate: true },
        { text: "legacy response", candidate: false },
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("accepts every additive rollout era from 0.39 through 0.149", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-codex-source-"));
    try {
      const repo = join(root, "repo");
      await initializeRepo(repo);
      const codexHome = join(root, "codex");
      const rolloutDir = join(codexHome, "sessions/eras");
      await mkdir(rolloutDir, { recursive: true });
      const eras = [
        ["0.39", "era-0.39.jsonl", "00000000-0000-0000-0000-000000000039"],
        ["0.44", "era-0.44.jsonl", "00000000-0000-0000-0000-000000000044"],
        ["0.88", "era-0.88.jsonl", "00000000-0000-0000-0000-000000000088"],
        ["0.117", "edge-worktree.jsonl", "22222222-2222-2222-2222-222222222222"],
        ["0.137", "edge-dead-worktree.jsonl", "33333333-3333-3333-3333-333333333333"],
        ["0.140", "era-0.140.jsonl", "00000000-0000-0000-0000-000000000140"],
        ["0.143", "era-0.143.jsonl", "00000000-0000-0000-0000-000000000143"],
        ["0.145", "era-0.145.jsonl", "00000000-0000-0000-0000-000000000145"],
        ["0.148", "era-0.148-revert.jsonl", "00000000-0000-0000-0000-000000000148"],
        ["0.149", "era-0.149.jsonl", "00000000-0000-0000-0000-000000000149"],
      ] as const;
      for (const [version, fixtureName, id] of eras) {
        const fixture = await Bun.file(join(fixtureRoot, fixtureName)).text();
        const name = version === "0.148"
          ? `rollout-era-${id}_bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb.jsonl`
          : `rollout-era-${id}.jsonl`;
        await writeFile(
          join(rolloutDir, name),
          fixture
            .replaceAll("__CWD__", repo)
            .replaceAll("__WORKTREE_CWD__", repo)
            .replaceAll("__DEAD_CWD__", repo)
            .replaceAll("__REPOSITORY_URL__", repo)
            .replaceAll("__START_CWD__", repo)
            .replaceAll("__LATEST_CWD__", repo)
            .replaceAll("__PARENT_CWD__", repo),
        );
      }

      const events = await new Tailer(createCodexSource({ codexHome })).catchUp();
      const versions = events
        .filter((event) => event.type === "session-meta")
        .map((event) => event.version);

      for (const [version] of eras) {
        expect(versions).toContain(`${version}.0`);
      }
      expect(
        events.filter((event) => event.type === "message").map((event) => event.sessionId),
      ).toContain("00000000-0000-0000-0000-000000000149");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("links subagent rollouts to parent_thread_id and excludes copied prompts", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-codex-source-"));
    try {
      const repo = join(root, "repo");
      await initializeRepo(repo);
      const codexHome = join(root, "codex");
      const rolloutDir = join(codexHome, "sessions/2026/06/15");
      await mkdir(rolloutDir, { recursive: true });
      const rollout = join(
        rolloutDir,
        "rollout-2026-06-15T10-00-00-00000000-0000-0000-0000-000000000140.jsonl",
      );
      const fixture = await Bun.file(join(fixtureRoot, "era-0.140.jsonl")).text();
      await writeFile(rollout, fixture.replaceAll("__CWD__", repo));

      const events = await new Tailer(createCodexSource({ codexHome })).catchUp();

      expect(events[0]).toMatchObject({
        parentSessionId: "00000000-0000-0000-0000-000000000001",
        sessionId: "00000000-0000-0000-0000-000000000140",
      });
      expect(events.find((event) => event.type === "message")).toMatchObject({
        candidate: false,
        text: "era 0.140 subagent",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
