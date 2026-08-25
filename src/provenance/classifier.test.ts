import { describe, expect, test } from "bun:test";
import type { MessageEvent } from "../tailing";
import { ProvenanceClassifier } from "./classifier";

// All timestamps ISO-8601 UTC, like transcripts and the registry carry.
const T0 = "2026-08-24T12:00:00.000Z";
const t0 = Date.parse(T0);
const iso = (offsetMs: number) => new Date(t0 + offsetMs).toISOString();

let uuidCounter = 0;
function message(overrides: Partial<MessageEvent> & { sessionId: string }): MessageEvent {
  return {
    type: "message",
    role: "user",
    text: "hello",
    ts: T0,
    uuid: `uuid-${++uuidCounter}`,
    candidate: true,
    file: `/transcripts/${overrides.sessionId}.jsonl`,
    ...overrides,
  };
}

describe("unregistered sessions (SPEC §5 rule 3a)", () => {
  test("every candidate user message is Johan-authored", () => {
    const c = new ProvenanceClassifier();

    const { record, audits } = c.handle(
      message({ sessionId: "adhoc-1", text: "let's refactor the tailer", ts: iso(0) }),
    );

    expect(audits).toEqual([]);
    expect(record).toMatchObject({
      sessionId: "adhoc-1",
      author: "johan",
      via: "unregistered-session",
      registered: false,
      startedBy: "johan",
      johanTouched: false,
      ts: iso(0),
      text: "let's refactor the tailer",
    });
    expect(record!.event.uuid).toBeDefined();
  });

  test("assistant messages are agent-authored; non-candidate user records are system", () => {
    const c = new ProvenanceClassifier();

    const assistant = c.handle(
      message({ sessionId: "adhoc-1", role: "assistant", text: "On it." }),
    );
    expect(assistant.record).toMatchObject({ author: "agent", via: "assistant" });

    const stdout = c.handle(
      message({
        sessionId: "adhoc-1",
        text: "<bash-stdout>ok</bash-stdout>",
        candidate: false,
      }),
    );
    expect(stdout.record).toMatchObject({ author: "system", via: "non-candidate" });
  });
});

const DISPATCH = "You are a BUILD worker. Implement ticket #25 exactly as scoped.";

function registered(c: ProvenanceClassifier, sessionId: string, ts = T0): void {
  const audits = c.registerSession({
    ts,
    sessionId,
    agent: "claude",
    ticket: "25",
    dispatchPrompt: DISPATCH,
  });
  expect(audits).toEqual([]);
}

describe("registered sessions — the dispatch prompt (SPEC §5 rule 1)", () => {
  test("the dispatch prompt landing classifies Hermes with deployment metadata", () => {
    const c = new ProvenanceClassifier();
    registered(c, "sess-a");

    const { record } = c.handle(
      message({ sessionId: "sess-a", text: DISPATCH, ts: iso(1_000) }),
    );

    expect(record).toMatchObject({
      author: "hermes",
      via: "dispatch-prompt",
      registered: true,
      startedBy: "hermes",
      johanTouched: false,
      agent: "claude",
      ticket: "25",
    });
  });

  test("NEVER Johan: matches even when the transcript clock precedes the registry ts", () => {
    const c = new ProvenanceClassifier();
    registered(c, "sess-a", iso(60_000)); // registry row stamped a minute AFTER the landing
    const { record } = c.handle(message({ sessionId: "sess-a", text: DISPATCH, ts: T0 }));
    expect(record!.author).toBe("hermes");
    expect(record!.via).toBe("dispatch-prompt");
  });

  test("consumed once: Johan re-pasting the dispatch text later reads as takeover", () => {
    const c = new ProvenanceClassifier();
    registered(c, "sess-a");
    expect(
      c.handle(message({ sessionId: "sess-a", text: DISPATCH, ts: iso(500) })).record!
        .author,
    ).toBe("hermes");
    expect(
      c.handle(message({ sessionId: "sess-a", text: DISPATCH, ts: iso(9_000) })).record!
        .author,
    ).toBe("johan");
  });

  test("duplicate registration of a session audits and keeps the first record", () => {
    const c = new ProvenanceClassifier();
    registered(c, "sess-a");
    const audits = c.registerSession({
      ts: iso(5_000),
      sessionId: "sess-a",
      agent: "codex",
      dispatchPrompt: "different prompt",
    });
    expect(audits).toEqual([
      { type: "duplicate-session-registration", sessionId: "sess-a" },
    ]);
    const { record } = c.handle(
      message({ sessionId: "sess-a", text: DISPATCH, ts: iso(1_000) }),
    );
    expect(record).toMatchObject({ author: "hermes", agent: "claude" });
  });
});
