import { describe, expect, test } from "bun:test";
import { parseSessionsJsonl, type SessionRecord } from "../../provenance";
import { chainRootOf } from "./chain";

function session(
  sessionId: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    ts: "2026-08-24T12:00:00.000Z",
    sessionId,
    dispatchPrompt: `dispatch for ${sessionId}`,
    ...overrides,
  };
}

describe("sessions.jsonl carries Hermes' compression chain (continues)", () => {
  test("a row's continues field parses into the session record", () => {
    const { records, audits } = parseSessionsJsonl(
      [
        JSON.stringify({
          ts: "2026-08-24T12:00:00.000Z",
          sessionId: "sess-b",
          dispatchPrompt: "compressed continuation of sess-a",
          ticket: "42",
          continues: "sess-a",
        }),
      ].join("\n"),
      "/registry/sessions.jsonl",
    );
    expect(audits).toEqual([]);
    expect(records[0]!.continues).toBe("sess-a");
  });

  test("rows without continues stay exactly as before", () => {
    const { records } = parseSessionsJsonl(
      JSON.stringify({
        ts: "2026-08-24T12:00:00.000Z",
        sessionId: "sess-a",
        dispatchPrompt: "fresh deployment",
      }),
      "/registry/sessions.jsonl",
    );
    expect(records[0]!.continues).toBeUndefined();
  });
});

describe("chain roots — rotated session ids collapse to one logical digest", () => {
  test("an unchained session is its own root", () => {
    expect(chainRootOf([session("sess-a")], "sess-a")).toBe("sess-a");
    expect(chainRootOf([], "sess-unregistered")).toBe("sess-unregistered");
  });

  test("a compression chain a→b→c resolves every link to a", () => {
    const sessions = [
      session("sess-a", { ticket: "42" }),
      session("sess-b", { ticket: "42", continues: "sess-a" }),
      session("sess-c", { ticket: "42", continues: "sess-b" }),
    ];
    expect(chainRootOf(sessions, "sess-a")).toBe("sess-a");
    expect(chainRootOf(sessions, "sess-b")).toBe("sess-a");
    expect(chainRootOf(sessions, "sess-c")).toBe("sess-a");
  });

  test("a continues link to an unregistered id still names that id as root", () => {
    const sessions = [session("sess-b", { continues: "sess-a" })];
    expect(chainRootOf(sessions, "sess-b")).toBe("sess-a");
  });

  test("a malformed registry cycle terminates instead of spinning", () => {
    const sessions = [
      session("sess-a", { continues: "sess-b" }),
      session("sess-b", { continues: "sess-a" }),
    ];
    expect(chainRootOf(sessions, "sess-a")).toBe("sess-b");
    expect(chainRootOf(sessions, "sess-b")).toBe("sess-a");
  });
});
