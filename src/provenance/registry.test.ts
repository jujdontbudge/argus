import { describe, expect, test } from "bun:test";
import { parseSessionsJsonl } from "./registry";

const FILE = "/repo/.argus/registry/sessions.jsonl";

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
