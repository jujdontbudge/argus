import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { claudeProjectDir } from "../src/tailing/claude-code.ts";
import { writeEvent } from "../src/events/writer.ts";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function watchWorld() {
  const root = await mkdtemp(join(tmpdir(), "argus-watch-"));
  const repoPath = join(root, "repo");
  const home = join(root, "home");
  const registry = join(root, "state", "argus-repos");
  await Promise.all([
    mkdir(join(repoPath, ".argus", "registry"), { recursive: true }),
    mkdir(join(repoPath, ".argus", "events"), { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(join(root, "state"), { recursive: true }),
  ]);
  const repo = await realpath(repoPath);
  await Promise.all([
    Bun.write(registry, `${repo}\n`),
    Bun.write(join(repo, ".argus", "config.yaml"), ""),
    Bun.write(
      join(repo, ".argus", "honcho.yaml"),
      "url: http://127.0.0.1:1\nworkspace: argus-watch-test\n",
    ),
  ]);
  return {
    env: {
      ...Bun.env,
      ARGUS_REPOS_FILE: registry,
      CLAUDE_CONFIG_DIR: join(root, "state", "claude"),
      CODEX_HOME: join(root, "state", "codex"),
      HERMES_HOME: join(root, "state", "hermes"),
      HOME: home,
      HONCHO_CONFIG_FILE: join(root, "state", "missing-honcho.json"),
    },
    repo,
    root,
  };
}

describe("argus watch", () => {
  test("the production reviewer uses its pinned brain without API credentials", async () => {
    const world = await watchWorld();
    const bin = join(world.root, "bin");
    const explicitRecord = join(world.root, "explicit-codex.json");
    const pathRecord = join(world.root, "path-codex.json");
    const explicitCodex = join(world.root, "explicit-codex");
    const pathCodex = join(bin, "codex");
    const fixture = (record: string) => `#!/usr/bin/env bun
await Bun.write(${JSON.stringify(record)}, JSON.stringify({
  apiKey: Bun.env.ANTHROPIC_API_KEY ?? null,
  argv: Bun.argv.slice(2),
  authToken: Bun.env.ANTHROPIC_AUTH_TOKEN ?? null,
}));
console.error("fixture brain unavailable");
process.exit(42);
`;
    await Promise.all([
      mkdir(bin, { recursive: true }),
      Bun.write(
        join(world.repo, ".argus", "config.yaml"),
        "reviewer:\n  quiet_window_seconds: 1\n  max_wait_seconds: 1\ncurator:\n  enabled: false\n",
      ),
      Bun.write(explicitCodex, fixture(explicitRecord)),
      Bun.write(pathCodex, fixture(pathRecord)),
    ]);
    await Promise.all([chmod(explicitCodex, 0o755), chmod(pathCodex, 0o755)]);
    const transcriptDirectory = claudeProjectDir(
      world.repo,
      join(world.env.CLAUDE_CONFIG_DIR, "projects"),
    );
    await mkdir(transcriptDirectory, { recursive: true });
    await Bun.write(
      join(transcriptDirectory, "pinned-brain.jsonl"),
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: "Exercise the production brain path." },
        timestamp: "2026-08-25T12:00:00.000Z",
        promptSource: "typed",
        uuid: "pinned-brain-u-1",
        sessionId: "pinned-brain-session",
        cwd: world.repo,
        version: "test",
      })}\n`,
    );
    const child = Bun.spawn(
      [process.execPath, cli, "watch", "reviewer", "--repo", world.repo],
      {
        env: {
          ...world.env,
          ANTHROPIC_API_KEY: "must-not-reach-brain",
          ANTHROPIC_AUTH_TOKEN: "must-not-reach-brain",
          ARGUS_CODEX_EXECUTABLE: explicitCodex,
          ARGUS_WATCH_POLL_MS: "20",
          PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
        },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    try {
      for (
        let attempt = 0;
        !(await Bun.file(explicitRecord).exists()) && attempt < 200;
        attempt += 1
      ) {
        await Bun.sleep(20);
      }

      const invocation = (await Bun.file(explicitRecord).json()) as {
        apiKey: string | null;
        argv: string[];
        authToken: string | null;
      };
      expect(invocation.apiKey).toBeNull();
      expect(invocation.argv[0]).toBe("exec");
      expect(invocation.authToken).toBeNull();
      expect(await Bun.file(pathRecord).exists()).toBe(false);
    } finally {
      child.kill("SIGTERM");
      await child.exited;
      await rm(world.root, { force: true, recursive: true });
    }
  }, 30_000);

  test("status fails visibly when a live production reviewer cannot invoke its brain", async () => {
    const world = await watchWorld();
    const codex = join(world.root, "failing-codex");
    const invocation = join(world.root, "failing-codex-invoked");
    const statusPath = join(world.root, "state", "supervisor-status.json");
    await Promise.all([
      Bun.write(
        join(world.repo, ".argus", "config.yaml"),
        "reviewer:\n  quiet_window_seconds: 1\n  max_wait_seconds: 1\ncurator:\n  enabled: false\n",
      ),
      Bun.write(
        codex,
        `#!/usr/bin/env bun
await Bun.write(${JSON.stringify(invocation)}, "invoked\\n");
console.error("fixture brain unavailable");
process.exit(42);
`,
      ),
    ]);
    await chmod(codex, 0o755);
    const transcriptDirectory = claudeProjectDir(
      world.repo,
      join(world.env.CLAUDE_CONFIG_DIR, "projects"),
    );
    await mkdir(transcriptDirectory, { recursive: true });
    await Bun.write(
      join(transcriptDirectory, "degraded-reviewer.jsonl"),
      `${JSON.stringify({
        type: "user",
        message: { role: "user", content: "Make the unavailable brain observable." },
        timestamp: "2026-08-25T12:00:00.000Z",
        promptSource: "typed",
        uuid: "degraded-reviewer-u-1",
        sessionId: "degraded-reviewer-session",
        cwd: world.repo,
        version: "test",
      })}\n`,
    );
    const env = {
      ...world.env,
      ARGUS_CODEX_EXECUTABLE: codex,
      ARGUS_SUPERVISOR_STATUS_FILE: statusPath,
      ARGUS_WATCH_POLL_MS: "20",
      PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
    };
    const watcher = Bun.spawn(
      [process.execPath, cli, "watch", "reviewer", "--repo", world.repo],
      { env, stderr: "pipe", stdout: "pipe" },
    );
    await Bun.write(
      statusPath,
      JSON.stringify({
        updatedAt: new Date().toISOString(),
        watchers: [
          { eye: "reviewer", pid: watcher.pid, repo: world.repo, state: "running" },
        ],
      }),
    );
    try {
      const healthPath = join(
        world.repo,
        ".argus",
        "eyes",
        "reviewer",
        "health.json",
      );
      let degraded = false;
      for (let attempt = 0; !degraded && attempt < 200; attempt += 1) {
        await Bun.sleep(20);
        try {
          degraded =
            ((await Bun.file(healthPath).json()) as { lastError: unknown })
              .lastError !== null;
        } catch {
          // The watcher may not have published its first health snapshot yet.
        }
      }
      const status = Bun.spawn([process.execPath, cli, "status"], {
        cwd: world.repo,
        env,
        stderr: "pipe",
        stdout: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        status.exited,
        new Response(status.stdout).text(),
        new Response(status.stderr).text(),
      ]);

      expect(exitCode).toBe(1);
      expect(stderr).toBe("");
      expect(stdout).toContain(`${world.repo}  reviewer  degraded`);
      expect(stdout).toContain("BACKLOG");
      expect(stdout).toContain("brain nonzero-exit: exit 42: fixture brain unavailable");
      expect(await Bun.file(invocation).exists()).toBe(true);
    } finally {
      watcher.kill("SIGTERM");
      await watcher.exited;
      await rm(world.root, { force: true, recursive: true });
    }
  }, 30_000);

  test("all five eye commands stay alive and stop cleanly on SIGTERM", async () => {
    const world = await watchWorld();
    try {
      for (const eye of ["reviewer", "digest", "retro", "archiver", "honcho"]) {
        const child = Bun.spawn(
          [process.execPath, cli, "watch", eye, "--repo", world.repo],
          { env: world.env, stderr: "pipe", stdout: "pipe" },
        );
        const readyPath =
          eye === "archiver"
            ? join(world.repo, ".argus", "archive.db")
            : join(world.repo, ".argus", "eyes", eye, "cursors.json");
        let ready = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          await Bun.sleep(20);
          ready = await Bun.file(readyPath).exists();
          if (ready) break;
        }
        expect({ eye, ready }).toEqual({ eye, ready: true });

        child.kill("SIGTERM");
        expect({ eye, exitCode: await child.exited }).toEqual({
          eye,
          exitCode: 0,
        });
      }
    } finally {
      await rm(world.root, { force: true, recursive: true });
    }
  }, 30_000);

  test("the archiver command observes a transcript created after startup", async () => {
    const world = await watchWorld();
    const child = Bun.spawn(
      [process.execPath, cli, "watch", "archiver", "--repo", world.repo],
      { env: world.env, stderr: "pipe", stdout: "pipe" },
    );
    try {
      await Bun.sleep(150);
      const sessionId = "live-watch-session";
      await Bun.write(
        join(world.repo, ".argus", "registry", "sessions.jsonl"),
        `${JSON.stringify({
          ts: "2026-08-25T12:00:00.000Z",
          sessionId,
          agent: "claude",
          dispatchPrompt: "Observe this after restart.",
        })}\n`,
      );
      const projectsRoot = join(world.env.CLAUDE_CONFIG_DIR, "projects");
      const transcriptDirectory = claudeProjectDir(world.repo, projectsRoot);
      await mkdir(transcriptDirectory, { recursive: true });
      await Bun.write(
        join(transcriptDirectory, `${sessionId}.jsonl`),
        `${JSON.stringify({
          type: "user",
          message: { role: "user", content: "Observe this after restart." },
          timestamp: "2026-08-25T12:00:00.000Z",
          promptSource: "typed",
          uuid: "live-watch-u-1",
          sessionId,
          cwd: world.repo,
          version: "test",
        })}\n`,
      );

      let archived = 0;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await Bun.sleep(20);
        try {
          const db = new Database(join(world.repo, ".argus", "archive.db"), {
            readonly: true,
          });
          archived = db
            .query<{ count: number }, []>(
              "SELECT count(*) AS count FROM archive_messages WHERE content = 'Observe this after restart.'",
            )
            .get()!.count;
          db.close();
        } catch {
          // The watcher may still be opening its database.
        }
        if (archived === 1) break;
      }
      expect(archived).toBe(1);
    } finally {
      child.kill("SIGTERM");
      await child.exited;
      await rm(world.root, { force: true, recursive: true });
    }
  }, 30_000);

  test("the reviewer command feeds observed turns into its durable queue", async () => {
    const world = await watchWorld();
    const child = Bun.spawn(
      [process.execPath, cli, "watch", "reviewer", "--repo", world.repo],
      { env: world.env, stderr: "pipe", stdout: "pipe" },
    );
    try {
      await Bun.sleep(150);
      const transcriptDirectory = claudeProjectDir(
        world.repo,
        join(world.env.CLAUDE_CONFIG_DIR, "projects"),
      );
      await mkdir(transcriptDirectory, { recursive: true });
      await Bun.write(
        join(transcriptDirectory, "reviewer-live.jsonl"),
        `${JSON.stringify({
          type: "user",
          message: { role: "user", content: "Always keep the live watcher running." },
          timestamp: "2026-08-25T12:01:00.000Z",
          promptSource: "typed",
          uuid: "reviewer-live-u-1",
          sessionId: "reviewer-live-session",
          cwd: world.repo,
          version: "test",
        })}\n`,
      );

      const statePath = join(world.repo, ".argus", "eyes", "reviewer", "state.json");
      let pending = 0;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await Bun.sleep(20);
        try {
          const state = (await Bun.file(statePath).json()) as { pending: unknown[] };
          pending = state.pending.length;
        } catch {
          // The first source poll may still be in flight.
        }
        if (pending === 1) break;
      }
      expect(pending).toBe(1);
    } finally {
      child.kill("SIGTERM");
      await child.exited;
      await rm(world.root, { force: true, recursive: true });
    }
  }, 30_000);

  test("the digest command observes lifecycle event files written after startup", async () => {
    const world = await watchWorld();
    const child = Bun.spawn(
      [process.execPath, cli, "watch", "digest", "--repo", world.repo],
      { env: world.env, stderr: "pipe", stdout: "pipe" },
    );
    try {
      await Bun.sleep(150);
      await writeEvent(world.repo, {
        agent: "codex",
        kind: "end-of-session",
        message: "Ticket complete.",
        sessionId: "digest-live-session",
      });

      const index = join(world.repo, ".argus", "sessions", "INDEX.md");
      let surfaced = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await Bun.sleep(20);
        const file = Bun.file(index);
        surfaced =
          (await file.exists()) &&
          (await file.text()).includes("digest-live-session") &&
          (await file.text()).includes("status=done");
        if (surfaced) break;
      }
      expect(surfaced).toBe(true);
    } finally {
      child.kill("SIGTERM");
      await child.exited;
      await rm(world.root, { force: true, recursive: true });
    }
  }, 30_000);

  test("digest, retro, and Honcho each durably consume their repo's turns", async () => {
    for (const eye of ["digest", "retro", "honcho"] as const) {
      const world = await watchWorld();
      const child = Bun.spawn(
        [process.execPath, cli, "watch", eye, "--repo", world.repo],
        { env: world.env, stderr: "pipe", stdout: "pipe" },
      );
      try {
        await Bun.sleep(150);
        const transcriptDirectory = claudeProjectDir(
          world.repo,
          join(world.env.CLAUDE_CONFIG_DIR, "projects"),
        );
        await mkdir(transcriptDirectory, { recursive: true });
        await Bun.write(
          join(transcriptDirectory, `${eye}-live.jsonl`),
          `${JSON.stringify({
            type: "user",
            message: { role: "user", content: `A live turn for ${eye}.` },
            timestamp: "2026-08-25T12:02:00.000Z",
            promptSource: "typed",
            uuid: `${eye}-live-u-1`,
            sessionId: `${eye}-live-session`,
            cwd: world.repo,
            version: "test",
          })}\n`,
        );

        const statePath =
          eye === "honcho"
            ? join(world.repo, ".argus", "eyes", eye, "queue.json")
            : join(world.repo, ".argus", "eyes", eye, "state.json");
        let consumed = 0;
        for (let attempt = 0; attempt < 100; attempt += 1) {
          await Bun.sleep(20);
          try {
            const state = (await Bun.file(statePath).json()) as {
              messages?: unknown[];
              pending?: unknown[];
              prompts?: unknown[];
            };
            consumed =
              state.messages?.length ??
              state.pending?.length ??
              state.prompts?.length ??
              0;
          } catch {
            // The first source poll may still be in flight.
          }
          if (consumed === 1) break;
        }
        expect({ eye, consumed }).toEqual({ eye, consumed: 1 });
      } finally {
        child.kill("SIGTERM");
        await child.exited;
        await rm(world.root, { force: true, recursive: true });
      }
    }
  }, 30_000);

  test("a duplicate watcher waits, then takes over without double-consuming", async () => {
    const world = await watchWorld();
    const command = [
      process.execPath,
      cli,
      "watch",
      "reviewer",
      "--repo",
      world.repo,
    ];
    const first = Bun.spawn(command, {
      env: world.env,
      stderr: "pipe",
      stdout: "pipe",
    });
    const cursorPath = join(
      world.repo,
      ".argus",
      "eyes",
      "reviewer",
      "cursors.json",
    );
    for (let attempt = 0; !(await Bun.file(cursorPath).exists()) && attempt < 200; attempt += 1) {
      await Bun.sleep(20);
    }
    const second = Bun.spawn(command, {
      env: world.env,
      stderr: "pipe",
      stdout: "pipe",
    });
    try {
      const ownerPath = join(
        world.repo,
        ".argus",
        "eyes",
        "reviewer",
        "watch.lock",
        "owner.json",
      );
      let firstOwner = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        await Bun.sleep(20);
        try {
          firstOwner =
            ((await Bun.file(ownerPath).json()) as { pid: number }).pid === first.pid;
        } catch {
          // The first process may still be acquiring the lease.
        }
        if (firstOwner) break;
      }
      expect(firstOwner).toBe(true);

      first.kill("SIGKILL");
      await first.exited;
      let secondOwner = false;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        await Bun.sleep(20);
        try {
          secondOwner =
            ((await Bun.file(ownerPath).json()) as { pid: number }).pid === second.pid;
        } catch {
          // The replacement is removing the stale lease and acquiring it.
        }
        if (secondOwner) break;
      }
      expect(secondOwner).toBe(true);

      const transcriptDirectory = claudeProjectDir(
        world.repo,
        join(world.env.CLAUDE_CONFIG_DIR, "projects"),
      );
      await mkdir(transcriptDirectory, { recursive: true });
      await Bun.write(
        join(transcriptDirectory, "lease-takeover.jsonl"),
        `${JSON.stringify({
          type: "user",
          message: { role: "user", content: "Only the lease owner consumes me." },
          timestamp: "2026-08-25T12:03:00.000Z",
          promptSource: "typed",
          uuid: "lease-u-1",
          sessionId: "lease-session",
          cwd: world.repo,
          version: "test",
        })}\n`,
      );
      const statePath = join(world.repo, ".argus", "eyes", "reviewer", "state.json");
      let pending = 0;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await Bun.sleep(20);
        try {
          pending = ((await Bun.file(statePath).json()) as { pending: unknown[] })
            .pending.length;
        } catch {
          // The replacement's source poll may still be in flight.
        }
        if (pending === 1) break;
      }
      expect(pending).toBe(1);
    } finally {
      first.kill("SIGTERM");
      second.kill("SIGTERM");
      await Promise.all([first.exited, second.exited]);
      await rm(world.root, { force: true, recursive: true });
    }
  }, 30_000);

  test("a watcher ignores another repo's global Codex rollout", async () => {
    const world = await watchWorld();
    const peerPath = join(world.root, "peer");
    await mkdir(join(peerPath, ".argus"), { recursive: true });
    const peer = await realpath(peerPath);
    const sentinel = join(peer, ".argus", "sentinel");
    await Bun.write(sentinel, "peer-state\n");
    const child = Bun.spawn(
      [process.execPath, cli, "watch", "reviewer", "--repo", world.repo],
      { env: world.env, stderr: "pipe", stdout: "pipe" },
    );
    try {
      const cursorPath = join(
        world.repo,
        ".argus",
        "eyes",
        "reviewer",
        "cursors.json",
      );
      for (let attempt = 0; !(await Bun.file(cursorPath).exists()) && attempt < 200; attempt += 1) {
        await Bun.sleep(20);
      }
      const sessions = join(world.env.CODEX_HOME, "sessions", "2026", "08", "25");
      await mkdir(sessions, { recursive: true });
      const rollout = (
        id: string,
        repo: string,
        text: string,
      ) =>
        `${JSON.stringify({
          timestamp: "2026-08-25T12:04:00.000Z",
          type: "session_meta",
          payload: {
            id,
            cwd: join(world.root, `vanished-${id}`),
            git: { repository_url: repo },
            cli_version: "test",
          },
        })}\n${JSON.stringify({
          timestamp: "2026-08-25T12:04:01.000Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text }],
          },
        })}\n`;
      await Bun.write(
        join(sessions, "rollout-peer.jsonl"),
        rollout("peer-session", peer, "This belongs only to the peer."),
      );
      await Bun.sleep(600);
      const statePath = join(world.repo, ".argus", "eyes", "reviewer", "state.json");
      const afterPeer = (await Bun.file(statePath).exists())
        ? ((await Bun.file(statePath).json()) as { pending: unknown[] }).pending.length
        : 0;
      expect(afterPeer).toBe(0);

      await Bun.write(
        join(sessions, "rollout-primary.jsonl"),
        rollout("primary-session", world.repo, "This belongs to the primary."),
      );
      let pending = 0;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        await Bun.sleep(20);
        try {
          pending = ((await Bun.file(statePath).json()) as { pending: unknown[] })
            .pending.length;
        } catch {
          // The repo-scoped source has not consumed the rollout yet.
        }
        if (pending === 1) break;
      }
      expect(pending).toBe(1);
      expect(await Bun.file(sentinel).text()).toBe("peer-state\n");
    } finally {
      child.kill("SIGTERM");
      await child.exited;
      await rm(world.root, { force: true, recursive: true });
    }
  }, 30_000);
});
