import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadRegistry, parseSendsJsonl, parseSessionsJsonl, registryPaths } from "./registry";

const FILE = "/repo/.argus/registry/sessions.jsonl";
const SENDS_FILE = "/repo/.argus/registry/sends.jsonl";

describe("sessions.jsonl parsing", () => {
  test("parses one deployment record per line", () => {
    const content = [
      JSON.stringify({
        ts: "2026-08-24T12:00:00.000Z",
        sessionId: "sess-a",
        agent: "claude",
        ticket: "25",
        dispatchPrompt: "Implement the provenance classifier.",
        workspace: "argus-worktrees/provenance",
      }),
      JSON.stringify({
        ts: "2026-08-24T13:00:00.000Z",
        sessionId: "sess-b",
        agent: "codex",
        dispatchPrompt: "Fix the tailer rotation bug.",
      }),
    ].join("\n");

    const { records, audits } = parseSessionsJsonl(content, FILE);

    expect(audits).toEqual([]);
    expect(records).toEqual([
      {
        ts: "2026-08-24T12:00:00.000Z",
        sessionId: "sess-a",
        agent: "claude",
        ticket: "25",
        dispatchPrompt: "Implement the provenance classifier.",
        workspace: "argus-worktrees/provenance",
      },
      {
        ts: "2026-08-24T13:00:00.000Z",
        sessionId: "sess-b",
        agent: "codex",
        dispatchPrompt: "Fix the tailer rotation bug.",
      },
    ]);
  });

  test("malformed and partial lines audit loudly, never crash, never drop good rows", () => {
    const good = JSON.stringify({
      ts: "2026-08-24T14:00:00.000Z",
      sessionId: "sess-c",
      dispatchPrompt: "Survive the noise.",
    });
    const content = [
      '{"ts": "2026-08-24T12:00:00.000Z", "sessionId": "sess-torn", "dispatchP', // torn mid-write
      "not json at all",
      JSON.stringify({ ts: "2026-08-24T12:30:00.000Z", dispatchPrompt: "no session id" }),
      JSON.stringify({ ts: "not-a-timestamp", sessionId: "sess-d", dispatchPrompt: "x" }),
      JSON.stringify({ ts: "2026-08-24T12:45:00.000Z", sessionId: "sess-e", dispatchPrompt: 7 }),
      '["an", "array", "line"]',
      good,
    ].join("\n");

    const { records, audits } = parseSessionsJsonl(content, FILE);

    expect(records).toEqual([
      { ts: "2026-08-24T14:00:00.000Z", sessionId: "sess-c", dispatchPrompt: "Survive the noise." },
    ]);
    expect(audits).toHaveLength(6);
    for (const [i, audit] of audits.entries()) {
      expect(audit.type).toBe("registry-malformed-line");
      expect(audit.file).toBe(FILE);
      expect(audit.line).toBe(i + 1);
      expect(audit.reason).not.toBe("");
    }
    expect(audits[0]!.raw).toStartWith('{"ts"');
    expect(audits[2]!.reason).toContain("sessionId");
    expect(audits[3]!.reason).toContain("ts");
    expect(audits[4]!.reason).toContain("dispatchPrompt");
  });
});

describe("sends.jsonl parsing", () => {
  test("parses send rows and stamps file:line correlation ids for the matcher", () => {
    const content = [
      JSON.stringify({
        ts: "2026-08-24T12:01:00.000Z",
        sessionId: "sess-a",
        text: "run the tests again",
      }),
      JSON.stringify({
        ts: "2026-08-24T12:02:00.000Z",
        sessionId: "sess-a",
        text: "/caveman summarize",
        kind: "slash",
      }),
      JSON.stringify({
        ts: "2026-08-24T12:03:00.000Z",
        sessionId: "sess-b",
        text: "!git status",
        id: "hermes-send-77",
      }),
    ].join("\n");

    const { records, audits } = parseSendsJsonl(content, SENDS_FILE);

    expect(audits).toEqual([]);
    expect(records).toEqual([
      {
        ts: "2026-08-24T12:01:00.000Z",
        sessionId: "sess-a",
        text: "run the tests again",
        id: `${SENDS_FILE}:1`,
      },
      {
        ts: "2026-08-24T12:02:00.000Z",
        sessionId: "sess-a",
        text: "/caveman summarize",
        kind: "slash",
        id: `${SENDS_FILE}:2`,
      },
      {
        ts: "2026-08-24T12:03:00.000Z",
        sessionId: "sess-b",
        text: "!git status",
        id: "hermes-send-77",
      },
    ]);
  });

  test("bad send rows audit loudly; an unknown kind is dropped, not trusted", () => {
    const content = [
      JSON.stringify({ ts: "2026-08-24T12:00:00.000Z", sessionId: "sess-a" }), // no text
      JSON.stringify({ ts: "2026-08-24T12:00:00.000Z", text: "orphan send" }), // no session
      JSON.stringify({
        ts: "2026-08-24T12:05:00.000Z",
        sessionId: "sess-a",
        text: "hello",
        kind: "telepathy",
      }),
      "{torn",
    ].join("\n");

    const { records, audits } = parseSendsJsonl(content, SENDS_FILE);

    // The unknown-kind row survives minus its kind (deriveKind fills in) …
    expect(records).toEqual([
      {
        ts: "2026-08-24T12:05:00.000Z",
        sessionId: "sess-a",
        text: "hello",
        id: `${SENDS_FILE}:3`,
      },
    ]);
    // … but the bogus kind is still surfaced, alongside the hard failures.
    expect(audits.map(({ line }) => line)).toEqual([1, 2, 3, 4]);
    expect(audits[2]!.reason).toContain("kind");
  });
});

describe("loadRegistry", () => {
  test("registryPaths maps a repo root to the SPEC §4 registry layout", () => {
    expect(registryPaths("/some/repo")).toEqual({
      sessionsFile: join("/some/repo", ".argus/registry/sessions.jsonl"),
      sendsFile: join("/some/repo", ".argus/registry/sends.jsonl"),
    });
  });

  test("reads both files from configurable paths and merges their audits", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-provenance-"));
    try {
      const paths = registryPaths(root);
      await mkdir(dirname(paths.sessionsFile), { recursive: true });
      await writeFile(
        paths.sessionsFile,
        `${JSON.stringify({
          ts: "2026-08-24T12:00:00.000Z",
          sessionId: "sess-a",
          agent: "claude",
          dispatchPrompt: "Do ticket 25.",
        })}\nbroken\n`,
      );
      await writeFile(
        paths.sendsFile,
        `${JSON.stringify({
          ts: "2026-08-24T12:01:00.000Z",
          sessionId: "sess-a",
          text: "nudge",
        })}\n`,
      );

      const registry = await loadRegistry(paths);

      expect(registry.sessions.map(({ sessionId }) => sessionId)).toEqual(["sess-a"]);
      expect(registry.sends).toEqual([
        {
          ts: "2026-08-24T12:01:00.000Z",
          sessionId: "sess-a",
          text: "nudge",
          id: `${paths.sendsFile}:1`,
        },
      ]);
      expect(registry.audits).toEqual([
        {
          type: "registry-malformed-line",
          file: paths.sessionsFile,
          line: 2,
          raw: "broken",
          reason: expect.stringContaining("JSON") as string,
        },
      ]);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  test("missing files are an empty registry, not an error — no deployments yet", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-provenance-"));
    try {
      const registry = await loadRegistry(registryPaths(join(root, "repo")));
      expect(registry).toEqual({ sessions: [], sends: [], audits: [] });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
