import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { hashText } from "../matching";
import {
  EVENT_SCHEMA_VERSION,
  handleClaudeStop,
  handleCodexNotify,
  notifyMissionControl,
  parseArgusEvent,
  resolveArgusRepo,
  writeEvent,
  type CmuxSend,
} from "./index.ts";

const scratchDirectories: string[] = [];
const fixtures = fileURLToPath(
  new URL("../../tests/fixtures/events", import.meta.url),
);

async function scratchRepo(argus = true): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "argus-events-"));
  scratchDirectories.push(repo);
  if (argus) {
    await mkdir(join(repo, ".argus", "events"), { recursive: true });
    await mkdir(join(repo, ".argus", "registry"), { recursive: true });
  }
  return repo;
}

afterEach(async () => {
  await Promise.all(
    scratchDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("Argus lifecycle event schema and writer", () => {
  test("parses the checked-in v1 completion and block fixtures", async () => {
    const events = await Promise.all(
      ["end-of-session-v1.json", "blocked-on-human-v1.json"].map(async (name) =>
        parseArgusEvent(await Bun.file(join(fixtures, name)).text()),
      ),
    );

    expect(events.map((event) => event?.kind).sort()).toEqual([
      "blocked-on-human",
      "end-of-session",
    ]);
    expect(events.every((event) => event?.schemaVersion === 1)).toBe(true);
  });

  test("writes a versioned event and deduplicates a repeated native fire", async () => {
    const repo = await scratchRepo();
    const input = {
      agent: "claude-code" as const,
      kind: "end-of-session" as const,
      message: "Implemented ticket #34. DONE.",
      sessionId: "claude-session-1",
    };

    const first = await writeEvent(repo, input, {
      now: () => new Date("2026-08-25T12:00:00.000Z"),
    });
    const duplicate = await writeEvent(repo, input, {
      now: () => new Date("2026-08-25T12:05:00.000Z"),
    });

    expect(first.status).toBe("written");
    expect(duplicate.status).toBe("duplicate");
    expect(duplicate.path).toBe(first.path);
    expect(await readdir(join(repo, ".argus", "events"))).toHaveLength(1);
    expect(parseArgusEvent(await Bun.file(first.path).text())).toEqual({
      schemaVersion: EVENT_SCHEMA_VERSION,
      id: first.event.id,
      kind: "end-of-session",
      agent: "claude-code",
      sessionId: "claude-session-1",
      repo,
      createdAt: "2026-08-25T12:00:00.000Z",
      message: "Implemented ticket #34. DONE.",
    });
  });

  test("keeps completion and human-block events distinct for one session", async () => {
    const repo = await scratchRepo();
    const shared = { agent: "codex" as const, sessionId: "thread-1" };

    const blocked = await writeEvent(repo, {
      ...shared,
      kind: "blocked-on-human",
      message: "BLOCKED: need Johan's API key.",
    });
    const ended = await writeEvent(repo, {
      ...shared,
      kind: "end-of-session",
      message: "Key supplied; work complete. DONE.",
    });

    expect(blocked.path).not.toBe(ended.path);
    expect(await readdir(join(repo, ".argus", "events"))).toHaveLength(2);
  });

  test("rejects unknown schema versions instead of guessing", () => {
    expect(
      parseArgusEvent(
        JSON.stringify({
          schemaVersion: 2,
          id: "future",
          kind: "end-of-session",
          agent: "codex",
          sessionId: "thread",
          repo: "/repo",
          createdAt: "2026-08-25T12:00:00.000Z",
          message: "DONE",
        }),
      ),
    ).toBeNull();
  });
});

describe("mission-control notification", () => {
  test("fsync-appends the exact normalized send record before cmux is called", async () => {
    const repo = await scratchRepo();
    const sessions = join(repo, ".argus", "registry", "sessions.jsonl");
    await Bun.write(
      sessions,
      `${JSON.stringify({
        ts: "2026-08-25T11:00:00.000Z",
        sessionId: "hermes-mission-1",
        agent: "hermes",
        dispatchPrompt: "Run mission control.",
        workspace: "workspace:42",
        surface: "surface:77",
      })}\n`,
    );
    const event = (
      await writeEvent(repo, {
        agent: "codex",
        kind: "end-of-session",
        message: "DONE",
        sessionId: "codex-thread-1",
      })
    ).event;
    const calls: Parameters<CmuxSend>[] = [];
    const send: CmuxSend = async (request) => {
      const logged = await Bun.file(
        join(repo, ".argus", "registry", "sends.jsonl"),
      ).text();
      const row = JSON.parse(logged.trim());
      expect(row.text).toBe(request.text);
      expect(row.hash).toBe(hashText(request.text));
      expect(row.sessionId).toBe("hermes-mission-1");
      expect(row.workspace).toBe("workspace:42");
      expect(row.surface).toBe("surface:77");
      calls.push([request]);
      return { ok: true };
    };

    const result = await notifyMissionControl(repo, event, {
      now: () => new Date("2026-08-25T12:01:00.000Z"),
      send,
    });

    expect(result).toEqual({ status: "sent" });
    expect(calls).toHaveLength(1);
    expect(calls[0]![0].text).not.toMatch(/[\r\n]/);
  });

  test("#90: a mission workspace addressed by UUID is found, not reported absent", async () => {
    // Regression. The selector used to require `workspace:`, so every
    // UUID-addressed mission — which is what `CMUX_WORKSPACE_ID` and
    // `openWorkerTab` hand over since #95 — degraded as "absent" for a
    // workspace that was present. Measured live under #90 before the fix:
    // `{"status":"degraded","reason":"Hermes mission-control workspace is
    // absent from the registry"}`. The prefix it required is also the handle
    // form that fails OPEN on cmux 0.62.2, so the filter selected for the
    // dangerous one.
    const repo = await scratchRepo();
    await Bun.write(
      join(repo, ".argus", "registry", "sessions.jsonl"),
      `${JSON.stringify({
        ts: "2026-08-25T11:00:00.000Z",
        sessionId: "hermes-mission-uuid",
        agent: "hermes",
        dispatchPrompt: "Run mission control.",
        workspace: "2D3B8B38-C9FC-46F4-A512-8F1157CE2E10",
        surface: "E0492BBB-0A3B-4393-B50B-75EB3439EB6C",
      })}\n`,
    );
    const event = (
      await writeEvent(repo, {
        agent: "codex",
        kind: "end-of-session",
        message: "DONE",
        sessionId: "codex-thread-uuid",
      })
    ).event;
    const targets: string[] = [];
    const result = await notifyMissionControl(repo, event, {
      send: async (request) => {
        targets.push(`${request.workspace}/${request.surface ?? ""}`);
        return { ok: true };
      },
    });

    expect(result).toEqual({ status: "sent" });
    expect(targets).toEqual([
      "2D3B8B38-C9FC-46F4-A512-8F1157CE2E10/E0492BBB-0A3B-4393-B50B-75EB3439EB6C",
    ]);
  });

  test("degrades loudly when mission control is absent without losing the event", async () => {
    const repo = await scratchRepo();
    const written = await writeEvent(repo, {
      agent: "codex",
      kind: "blocked-on-human",
      message: "BLOCKED: need approval.",
      sessionId: "codex-thread-2",
    });
    const errors: string[] = [];

    const result = await notifyMissionControl(repo, written.event, {
      onError: (message) => errors.push(message),
      send: async () => {
        throw new Error("cmux must not be called without a mission workspace");
      },
    });

    expect(result.status).toBe("degraded");
    expect(errors.join("\n")).toContain("mission-control workspace is absent");
    expect(await Bun.file(written.path).exists()).toBe(true);
  });
});

describe("native hook entrypoints", () => {
  test("Claude Stop and Codex notify map native payloads to prompt events", async () => {
    const repo = await scratchRepo();
    const errors: string[] = [];
    const runtime = {
      onError: (message: string) => errors.push(message),
      send: async () => ({ ok: true as const }),
    };

    const claude = await handleClaudeStop(
      {
        hook_event_name: "Stop",
        session_id: "claude-1",
        cwd: repo,
        last_assistant_message: "Implemented and verified. DONE.",
      },
      runtime,
    );
    const codex = await handleCodexNotify(
      {
        type: "agent-turn-complete",
        "thread-id": "codex-1",
        cwd: repo,
        "last-assistant-message": "BLOCKED: waiting on Johan for credentials.",
      },
      runtime,
    );

    expect(claude.status).toBe("emitted");
    expect(codex.status).toBe("emitted");
    const kinds = await Promise.all(
      (await readdir(join(repo, ".argus", "events"))).map(async (file) =>
        parseArgusEvent(await Bun.file(join(repo, ".argus", "events", file)).text()),
      ),
    );
    expect(kinds.map((event) => event?.kind).sort()).toEqual([
      "blocked-on-human",
      "end-of-session",
    ]);
    expect(errors).toHaveLength(2); // no registered Hermes mission workspace
  });

  test("ordinary turns and non-Argus repos no-op cleanly", async () => {
    const repo = await scratchRepo();
    const nonArgus = await scratchRepo(false);
    let sends = 0;
    const runtime = {
      send: async () => {
        sends += 1;
        return { ok: true as const };
      },
    };

    expect(
      await handleClaudeStop(
        {
          hook_event_name: "Stop",
          session_id: "claude-progress",
          cwd: repo,
          last_assistant_message: "I implemented the first half; continuing next turn.",
        },
        runtime,
      ),
    ).toEqual({ status: "ignored", reason: "not-terminal" });
    expect(
      await handleCodexNotify(
        {
          type: "agent-turn-complete",
          "thread-id": "codex-outside",
          cwd: nonArgus,
          "last-assistant-message": "DONE.",
        },
        runtime,
      ),
    ).toEqual({ status: "ignored", reason: "not-argus" });
    expect(sends).toBe(0);
    expect(await readdir(join(repo, ".argus", "events"))).toHaveLength(0);
  });

  /**
   * Ticket #7, found by the live drive. A real `codex exec --cd <path>`
   * reports that path VERBATIM in its notify payload, while a real Claude Stop
   * hook reports the resolved one — and on macOS the harness sandbox lives
   * under `/var`, a symlink to `/private/var`. The watcher resolves its own
   * repo (`realpath`, `src/watch.ts`) and then drops any event whose `repo`
   * does not match STRING-wise, so an agent started on the symlinked form
   * wrote a perfectly good event that the digest silently ignored forever.
   * The event's repo is therefore canonicalised where it is resolved.
   */
  test("resolves a symlinked cwd to the canonical repo the watcher watches", async () => {
    const repo = await scratchRepo();
    const canonical = await realpath(repo);
    const link = join(await mkdtemp(join(tmpdir(), "argus-events-link-")), "repo");
    scratchDirectories.push(dirname(link));
    await symlink(repo, link);

    expect(await resolveArgusRepo(link)).toBe(canonical);

    const result = await handleClaudeStop(
      {
        hook_event_name: "Stop",
        session_id: "claude-symlinked",
        cwd: link,
        last_assistant_message: "DONE",
      },
      { send: async () => ({ ok: true as const }) },
    );
    expect(result.status).toBe("emitted");
    const written = await readdir(join(canonical, ".argus", "events"));
    expect(written).toHaveLength(1);
    expect(
      parseArgusEvent(
        await Bun.file(join(canonical, ".argus", "events", written[0]!)).text(),
      )!.repo,
    ).toBe(canonical);
  });
});
