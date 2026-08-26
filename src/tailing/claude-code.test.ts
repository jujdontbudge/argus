import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProjectDir, createClaudeCodeSource } from "./claude-code";

/** Build one synthetic transcript line modeled on research §2.1 shapes. */
function userLine(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: "E0 submit semantics probe" },
    timestamp: "2026-08-24T17:49:59.470Z",
    promptSource: "typed",
    origin: { kind: "human" },
    userType: "external",
    entrypoint: "cli",
    uuid: "uuid-1",
    parentUuid: null,
    sessionId: "s-1",
    cwd: "/tmp/proj",
    version: "2.1.241",
    isSidechain: false,
    ...overrides,
  });
}

function parserFor(file = "/tmp/proj-slug/s-1.jsonl") {
  return createClaudeCodeSource({ dir: "/tmp/proj-slug" }).createParser(file);
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

describe("claude-code source", () => {
  test("lists only *.jsonl files, sorted, and watches the configured dir", async () => {
    const dir = await mkdtemp(join(tmpdir(), "argus-cc-"));
    try {
      await writeFile(join(dir, "b-session.jsonl"), "");
      await writeFile(join(dir, "a-session.jsonl"), "");
      await writeFile(join(dir, "notes.txt"), "");
      const source = createClaudeCodeSource({ dir });

      expect(await source.listFiles()).toEqual([
        join(dir, "a-session.jsonl"),
        join(dir, "b-session.jsonl"),
      ]);
      expect(source.watchPaths()).toEqual([dir]);
      expect(source.id).toBe("claude-code");
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });

  test("a missing directory lists no files instead of throwing", async () => {
    const source = createClaudeCodeSource({ dir: "/nonexistent/argus-test" });

    expect(await source.listFiles()).toEqual([]);
  });

  test("claudeProjectDir maps a cwd to its ~/.claude/projects slug directory", () => {
    // Observed convention: every non-alphanumeric byte becomes "-".
    expect(claudeProjectDir("/Users/johansardar/argus", "/home/.claude/projects")).toBe(
      "/home/.claude/projects/-Users-johansardar-argus",
    );
    expect(claudeProjectDir("/tmp/my.app_v2", "/p")).toBe("/p/-tmp-my-app-v2");
  });
});

describe("claude-code parser", () => {
  test("resolves a real linked-worktree cwd to its parent repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-claude-source-"));
    try {
      const parent = join(root, "parent");
      const worktree = join(root, "worktrees/ticket-51");
      await mkdir(parent, { recursive: true });
      await runGit(parent, ["init", "--quiet"]);
      await runGit(parent, ["commit", "--quiet", "--allow-empty", "-m", "fixture"]);
      await mkdir(join(root, "worktrees"), { recursive: true });
      await runGit(parent, ["worktree", "add", "--quiet", "--detach", worktree]);

      const events = parserFor().parseLine(userLine({ cwd: worktree }));

      expect(events[0]).toMatchObject({
        type: "session-meta",
        cwd: worktree,
        repo: await realpath(parent),
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("a typed user record yields session-meta on first sight, then the message", () => {
    const parser = parserFor();

    const events = parser.parseLine(userLine());

    expect(events).toEqual([
      {
        type: "session-meta",
        sessionId: "s-1",
        agent: "claude-code",
        cwd: "/tmp/proj",
        version: "2.1.241",
        ts: "2026-08-24T17:49:59.470Z",
        file: "/tmp/proj-slug/s-1.jsonl",
      },
      {
        type: "message",
        sessionId: "s-1",
        role: "user",
        text: "E0 submit semantics probe",
        ts: "2026-08-24T17:49:59.470Z",
        uuid: "uuid-1",
        promptSource: "typed",
        origin: "human",
        candidate: true,
        file: "/tmp/proj-slug/s-1.jsonl",
      },
    ]);
  });

  test("assistant records emit a message from their text blocks", () => {
    const parser = parserFor();
    parser.parseLine(userLine());

    const events = parser.parseLine(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "On it." },
            { type: "tool_use", id: "tu-1", name: "Bash", input: {} },
            { type: "text", text: "Done." },
          ],
        },
        timestamp: "2026-08-24T17:50:05.001Z",
        uuid: "uuid-a1",
        sessionId: "s-1",
        isSidechain: false,
      }),
    );

    expect(events).toEqual([
      {
        type: "message",
        sessionId: "s-1",
        role: "assistant",
        text: "On it.\nDone.",
        ts: "2026-08-24T17:50:05.001Z",
        uuid: "uuid-a1",
        candidate: false,
        file: "/tmp/proj-slug/s-1.jsonl",
      },
    ]);
  });

  test("an assistant record with only tool_use blocks emits nothing", () => {
    const parser = parserFor();
    parser.parseLine(userLine());

    const events = parser.parseLine(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu-1", name: "Bash", input: {} }],
        },
        timestamp: "2026-08-24T17:50:06.000Z",
        uuid: "uuid-a2",
        sessionId: "s-1",
      }),
    );

    expect(events).toEqual([]);
  });

  test("candidate flags follow the matching library's §2.1/§2.3 rules", () => {
    const parser = parserFor();
    parser.parseLine(userLine());
    const flag = (line: string) => {
      const events = parser.parseLine(line);
      expect(events).toHaveLength(1);
      const event = events[0]!;
      if (event.type !== "message") throw new Error("expected a message event");
      return event.candidate;
    };

    // Queued landing (stamped at dequeue) is a real prompt.
    expect(flag(userLine({ uuid: "u-q", promptSource: "queued" }))).toBe(true);
    // Bang landing: <bash-input> has no promptSource but is a candidate…
    expect(
      flag(
        userLine({
          uuid: "u-b",
          promptSource: undefined,
          message: { role: "user", content: "<bash-input>echo probe</bash-input>" },
        }),
      ),
    ).toBe(true);
    // …its stdout companion is not, but still flows to passive consumers.
    expect(
      flag(
        userLine({
          uuid: "u-o",
          promptSource: undefined,
          message: {
            role: "user",
            content: "<bash-stdout>probe</bash-stdout><bash-stderr></bash-stderr>",
          },
        }),
      ),
    ).toBe(false);
    // Sidechain records are never provenance candidates.
    expect(flag(userLine({ uuid: "u-s", isSidechain: true }))).toBe(false);
  });

  test("array-content user records (tool results, skill companions) emit nothing", () => {
    const parser = parserFor();
    parser.parseLine(userLine());

    const toolResult = parser.parseLine(
      userLine({
        uuid: "u-tr",
        promptSource: undefined,
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu-1", content: "ok" }],
        },
      }),
    );
    const metaCompanion = parser.parseLine(
      userLine({
        uuid: "u-m",
        isMeta: true,
        promptSource: undefined,
        message: { role: "user", content: [{ type: "text", text: "companion" }] },
      }),
    );

    expect(toolResult).toEqual([]);
    expect(metaCompanion).toEqual([]);
  });

  test("queue-operation records become lifecycle events (the matcher's bridge)", () => {
    const parser = parserFor();
    parser.parseLine(userLine());

    const enqueue = parser.parseLine(
      JSON.stringify({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2026-08-24T17:51:00.100Z",
        content: "E2 line two",
        sessionId: "s-1",
      }),
    );
    const dequeue = parser.parseLine(
      JSON.stringify({
        type: "queue-operation",
        operation: "dequeue",
        timestamp: "2026-08-24T17:51:04.200Z",
        sessionId: "s-1",
      }),
    );

    expect(enqueue).toEqual([
      {
        type: "lifecycle",
        kind: "queue-enqueue",
        sessionId: "s-1",
        ts: "2026-08-24T17:51:00.100Z",
        content: "E2 line two",
        file: "/tmp/proj-slug/s-1.jsonl",
      },
    ]);
    expect(dequeue).toEqual([
      {
        type: "lifecycle",
        kind: "queue-dequeue",
        sessionId: "s-1",
        ts: "2026-08-24T17:51:04.200Z",
        file: "/tmp/proj-slug/s-1.jsonl",
      },
    ]);
  });

  test("a malformed line emits a parse-error lifecycle event, never throws", () => {
    const parser = parserFor();

    const events = parser.parseLine('{"type":"user","message":{');

    expect(events).toEqual([
      {
        type: "lifecycle",
        kind: "parse-error",
        content: '{"type":"user","message":{',
        file: "/tmp/proj-slug/s-1.jsonl",
      },
    ]);
  });

  test("summary lines (resumed-session preamble) emit nothing", () => {
    const parser = parserFor();

    const events = parser.parseLine(
      JSON.stringify({ type: "summary", summary: "Old work", leafUuid: "u-l" }),
    );

    expect(events).toEqual([]);
  });

  test("session-meta is not repeated for later records of the same session", () => {
    const parser = parserFor();
    parser.parseLine(userLine());

    const events = parser.parseLine(userLine({ uuid: "uuid-2" }));

    expect(events.map((e) => e.type)).toEqual(["message"]);
  });

  /**
   * Ticket #49, found on a REAL Opus 5 transcript, not derived.
   *
   * Every fixture in this tree opens a session with a `user` record, which
   * carries `cwd`. A real one does not: the first line Claude Code 2.1.246
   * writes is a `queue-operation` with a sessionId and a timestamp and
   * nothing else. Latching `session-meta` on THAT record emits a meta with no
   * cwd and then suppresses the real one forever, which silently kills
   * §7.3/#22's worktree-to-parent-repo mapping for every live Claude session
   * — invisible to 600 green tests, because no fixture has this shape.
   */
  test("a real transcript's cwd-less opening records do not swallow session-meta", () => {
    const parser = parserFor();

    // Verbatim shape of line 1 of a real 2.1.246 transcript.
    const opening = parser.parseLine(
      JSON.stringify({
        type: "queue-operation",
        operation: "enqueue",
        content: "the dispatch",
        sessionId: "s-1",
        timestamp: "2026-08-25T18:36:00.000Z",
      }),
    );
    expect(opening.map((event) => event.type)).toEqual(["lifecycle"]);

    const landed = parser.parseLine(userLine());

    expect(landed).toContainEqual(
      expect.objectContaining({ type: "session-meta", cwd: "/tmp/proj", version: "2.1.241" }),
    );
  });
});
