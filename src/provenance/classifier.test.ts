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

describe("registered sessions — logged sends via the matcher (SPEC §5 rule 2)", () => {
  test("a sends.jsonl-logged follow-up classifies Hermes through the send matcher", () => {
    const c = new ProvenanceClassifier();
    registered(c, "sess-a");
    c.recordSend({ ts: iso(60_000), sessionId: "sess-a", text: "run the tests again", id: "s1" });

    const { record } = c.handle(
      message({ sessionId: "sess-a", text: "run the tests again", ts: iso(61_000) }),
    );

    expect(record).toMatchObject({
      author: "hermes",
      via: "registry-send",
      johanTouched: false,
    });
  });

  test("matcher clock windows hold: −5s jitter matches, earlier does not", () => {
    const c = new ProvenanceClassifier();
    registered(c, "sess-a");
    c.handle(message({ sessionId: "sess-a", text: DISPATCH, ts: iso(0) }));

    c.recordSend({ ts: iso(120_000), sessionId: "sess-a", text: "jitter probe", id: "s2" });
    expect(
      c.handle(message({ sessionId: "sess-a", text: "jitter probe", ts: iso(116_000) }))
        .record!.via,
    ).toBe("registry-send");

    c.recordSend({ ts: iso(300_000), sessionId: "sess-a", text: "too early", id: "s3" });
    expect(
      c.handle(message({ sessionId: "sess-a", text: "too early", ts: iso(294_000) }))
        .record!.via,
    ).toBe("takeover");
  });

  test("queue-enqueue lifecycle events bridge queued sends past the window", () => {
    const c = new ProvenanceClassifier();
    registered(c, "sess-a");
    c.handle(message({ sessionId: "sess-a", text: DISPATCH, ts: iso(0) }));
    c.recordSend({ ts: iso(10_000), sessionId: "sess-a", text: "queued nudge", id: "s4" });

    const enqueue = c.handle({
      type: "lifecycle",
      kind: "queue-enqueue",
      sessionId: "sess-a",
      ts: iso(11_000),
      content: "queued nudge",
      file: "/transcripts/sess-a.jsonl",
    });
    expect(enqueue.record).toBeNull();

    // Lands two hours later (long turn) — the enqueue record vouches for it.
    const { record } = c.handle(
      message({
        sessionId: "sess-a",
        text: "queued nudge",
        ts: iso(7_200_000),
        promptSource: "queued",
      }),
    );
    expect(record!.via).toBe("registry-send");
  });
});

describe("loud failure surfacing (SPEC §5 rule 3b, §13 scenario 5)", () => {
  test("takeover flips johan_touched stickily and audits johan-attached once", () => {
    const c = new ProvenanceClassifier();
    registered(c, "sess-a");
    c.handle(message({ sessionId: "sess-a", text: DISPATCH, ts: iso(0) }));

    const takeover = c.handle(
      message({ sessionId: "sess-a", text: "stop, do the auth bug first", ts: iso(30_000) }),
    );
    expect(takeover.record).toMatchObject({
      author: "johan",
      via: "takeover",
      johanTouched: true,
    });
    expect(takeover.audits).toEqual([
      {
        type: "johan-attached",
        sessionId: "sess-a",
        ts: iso(30_000),
        text: "stop, do the auth bug first",
        uuid: takeover.record!.event.uuid as string,
      },
    ]);

    // Sticky flag, but the audit fires only on the first attach.
    const second = c.handle(
      message({ sessionId: "sess-a", text: "and add a test", ts: iso(31_000) }),
    );
    expect(second.record).toMatchObject({ author: "johan", johanTouched: true });
    expect(second.audits).toEqual([]);

    // Later Hermes sends still classify Hermes; the session stays touched.
    c.recordSend({ ts: iso(40_000), sessionId: "sess-a", text: "carry on", id: "s5" });
    const resumed = c.handle(
      message({ sessionId: "sess-a", text: "carry on", ts: iso(41_000) }),
    );
    expect(resumed.record).toMatchObject({
      author: "hermes",
      via: "registry-send",
      johanTouched: true,
    });
  });

  test("hash-miss with the one-line-of-a-multi-line-send signature surfaces the suspect", () => {
    const c = new ProvenanceClassifier();
    registered(c, "sess-a");
    c.handle(message({ sessionId: "sess-a", text: DISPATCH, ts: iso(0) }));
    c.recordSend({
      ts: iso(50_000),
      sessionId: "sess-a",
      text: "step one\nstep two",
      id: "s6",
    });

    const { record, audits } = c.handle(
      message({ sessionId: "sess-a", text: "step one", ts: iso(51_000) }),
    );

    expect(record!.author).toBe("johan"); // classification unchanged — diagnostic only
    expect(audits).toContainEqual({
      type: "encoding-bug-suspect",
      sessionId: "sess-a",
      sendId: "s6",
      ts: iso(51_000),
      text: "step one",
    });
  });

  test("a send logged for an unregistered session audits, yet still matches as Hermes", () => {
    const c = new ProvenanceClassifier();
    const audits = c.recordSend({
      ts: iso(0),
      sessionId: "sess-ghost",
      text: "nudge into the void",
      id: "s7",
    });
    expect(audits).toEqual([
      { type: "send-into-unregistered-session", sessionId: "sess-ghost", sendId: "s7" },
    ]);

    // Poison-safety beats spec-literalism: the logged send is registry truth,
    // so its landing must not read as Johan even though the session is not
    // a registered deployment.
    const { record } = c.handle(
      message({ sessionId: "sess-ghost", text: "nudge into the void", ts: iso(1_000) }),
    );
    expect(record).toMatchObject({
      author: "hermes",
      via: "registry-send",
      registered: false,
      startedBy: "johan",
    });
  });
});
