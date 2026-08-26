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
        file: "/transcripts/sess-a.jsonl",
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

const HOUR = 3_600_000;

describe("sweep — dead sessions and never-landing registry rows", () => {
  test("a send into a dead session expires loudly with its session id", () => {
    const c = new ProvenanceClassifier();
    registered(c, "sess-dead");
    c.handle(message({ sessionId: "sess-dead", text: DISPATCH, ts: iso(0) }));
    c.recordSend({
      ts: iso(10_000),
      sessionId: "sess-dead",
      text: "are you alive?",
      id: "s-dead",
    });

    expect(c.sweep(iso(HOUR))).toEqual([]); // window still open — quiet
    const audits = c.sweep(iso(HOUR + 10_001));
    expect(audits).toEqual([
      {
        type: "send-expired",
        sessionId: "sess-dead",
        sendId: "s-dead",
        text: "are you alive?",
        at: t0 + HOUR + 10_001,
      },
    ]);
    expect(c.sweep(iso(HOUR + 20_000))).toEqual([]); // audited once, not every sweep
  });

  test("a registered session whose transcript never appears audits once past the window", () => {
    const c = new ProvenanceClassifier();
    registered(c, "sess-never");

    expect(c.sweep(iso(HOUR))).toEqual([]);
    expect(c.sweep(iso(HOUR + 1))).toEqual([
      {
        type: "dispatch-expired",
        sessionId: "sess-never",
        at: t0 + HOUR + 1,
        sessionSeen: false,
      },
    ]);
    expect(c.sweep(iso(2 * HOUR))).toEqual([]); // once

    // The never-Johan guarantee survives the audit: a late landing still matches.
    const { record } = c.handle(
      message({ sessionId: "sess-never", text: DISPATCH, ts: iso(3 * HOUR) }),
    );
    expect(record).toMatchObject({ author: "hermes", via: "dispatch-prompt" });
  });

  test("a seen session whose dispatch never landed audits with sessionSeen true", () => {
    const c = new ProvenanceClassifier();
    registered(c, "sess-half");
    c.handle(
      message({ sessionId: "sess-half", role: "assistant", text: "…", ts: iso(1_000) }),
    );

    expect(c.sweep(iso(HOUR + 1))).toEqual([
      {
        type: "dispatch-expired",
        sessionId: "sess-half",
        at: t0 + HOUR + 1,
        sessionSeen: true,
      },
    ]);
  });

  test("a consumed dispatch prompt never expires", () => {
    const c = new ProvenanceClassifier();
    registered(c, "sess-ok");
    c.handle(message({ sessionId: "sess-ok", text: DISPATCH, ts: iso(1_000) }));
    expect(c.sweep(iso(2 * HOUR))).toEqual([]);
  });
});

describe("multiple concurrent registered sessions in one repo", () => {
  test("identical sends to two sessions are consumed per-session, no cross-talk", () => {
    const c = new ProvenanceClassifier();
    registered(c, "sess-a");
    registered(c, "sess-b");
    c.handle(message({ sessionId: "sess-a", text: DISPATCH, ts: iso(0) }));
    c.handle(message({ sessionId: "sess-b", text: DISPATCH, ts: iso(0) }));
    c.recordSend({ ts: iso(10_000), sessionId: "sess-a", text: "status?", id: "sa" });
    c.recordSend({ ts: iso(10_000), sessionId: "sess-b", text: "status?", id: "sb" });

    expect(
      c.handle(message({ sessionId: "sess-a", text: "status?", ts: iso(11_000) }))
        .record!.via,
    ).toBe("registry-send");
    expect(
      c.handle(message({ sessionId: "sess-b", text: "status?", ts: iso(11_500) }))
        .record!.via,
    ).toBe("registry-send");
    expect(c.sweep(iso(2 * HOUR))).toEqual([]);
  });

  test("a send cross-landing in the wrong session is takeover there, expiry here", () => {
    const c = new ProvenanceClassifier();
    registered(c, "sess-a");
    registered(c, "sess-b");
    c.handle(message({ sessionId: "sess-a", text: DISPATCH, ts: iso(0) }));
    c.handle(message({ sessionId: "sess-b", text: DISPATCH, ts: iso(0) }));
    c.recordSend({ ts: iso(10_000), sessionId: "sess-a", text: "meant for A", id: "sa" });

    // Hermes fat-fingers the tab: the text lands in B's transcript.
    const { record } = c.handle(
      message({ sessionId: "sess-b", text: "meant for A", ts: iso(11_000) }),
    );
    expect(record!.via).toBe("takeover"); // visible in B…
    expect(
      c.sweep(iso(HOUR + 10_001)).map(({ type }) => type),
    ).toEqual(["send-expired"]); // …and loud for A. Never silent.
  });

  test("sessionState exposes the digest-frontmatter view per session", () => {
    const c = new ProvenanceClassifier();
    registered(c, "sess-a");
    c.handle(message({ sessionId: "sess-a", text: DISPATCH, ts: iso(0) }));
    c.handle(message({ sessionId: "adhoc-1", text: "quick question", ts: iso(0) }));

    expect(c.sessionState("sess-a")).toEqual({
      sessionId: "sess-a",
      registered: true,
      startedBy: "hermes",
      johanTouched: false,
      agent: "claude",
      ticket: "25",
    });
    expect(c.sessionState("adhoc-1")).toEqual({
      sessionId: "adhoc-1",
      registered: false,
      startedBy: "johan",
      johanTouched: false,
    });
    expect(c.sessionState("sess-unknown")).toBeUndefined();

    c.handle(message({ sessionId: "sess-a", text: "I'm taking over", ts: iso(5_000) }));
    expect(c.sessionState("sess-a")).toMatchObject({ johanTouched: true });
  });
});

/**
 * #42 item 1. The failure #36 found live: codex-cli injects a context block as
 * a USER-role rollout item, it matches no logged send, and §5 rule 3b reads
 * that as Johan attaching. The string it injects changes with every CLI
 * release; the position and shape do not. Both directions are LOUD — an
 * over-filter that made Argus deaf to Johan would be no better than the
 * poisoning it prevents.
 */
const FUTURE_PREAMBLE =
  "<workspace_catalogue>\nHere are the workspaces you may open.\n</workspace_catalogue>";

describe("agent-injected context envelopes never become Johan (#42)", () => {
  test("an unrecognised preamble opening a registered session is not a takeover", () => {
    const c = new ProvenanceClassifier();
    registered(c, "sess-codex");

    const preamble = c.handle(
      message({ sessionId: "sess-codex", text: FUTURE_PREAMBLE, ts: iso(0) }),
    );

    expect(preamble.record).toMatchObject({
      author: "system",
      via: "synthetic-preamble",
      johanTouched: false,
    });
    expect(c.sessionState("sess-codex")?.johanTouched).toBe(false);
    expect(preamble.audits).toEqual([
      {
        type: "synthetic-preamble-suspect",
        sessionId: "sess-codex",
        ts: iso(0),
        tag: "workspace_catalogue",
        text: FUTURE_PREAMBLE,
        classifiedAs: "system",
      },
    ]);
  });
  test("a preamble opening an UNREGISTERED rogue session is not Johan either", () => {
    // §5 rule 3a makes every candidate in an unregistered session Johan's, so
    // the rogue path poisons USER.md exactly as the registered one does.
    const c = new ProvenanceClassifier();

    const preamble = c.handle(
      message({ sessionId: "rogue-1", text: FUTURE_PREAMBLE, ts: iso(0) }),
    );

    expect(preamble.record).toMatchObject({
      author: "system",
      via: "synthetic-preamble",
      registered: false,
    });
    expect(preamble.audits).toMatchObject([{ classifiedAs: "system" }]);
  });

  test("Johan's first real prompt closes the window; markup after it stays his", () => {
    const c = new ProvenanceClassifier();
    registered(c, "sess-codex");
    c.handle(message({ sessionId: "sess-codex", text: FUTURE_PREAMBLE, ts: iso(0) }));
    c.handle(message({ sessionId: "sess-codex", text: DISPATCH, ts: iso(1_000) }));

    const pasted = c.handle(
      message({
        sessionId: "sess-codex",
        text: "<div>\n  <span>hi</span>\n</div>",
        ts: iso(30_000),
      }),
    );

    expect(pasted.record).toMatchObject({
      author: "johan",
      via: "takeover",
      johanTouched: true,
    });
    // Still LOUD: an injection that arrives mid-session is the failure mode
    // this rule cannot catch, so it says so and names the tag.
    expect(pasted.audits).toContainEqual({
      type: "synthetic-preamble-suspect",
      sessionId: "sess-codex",
      ts: iso(30_000),
      tag: "div",
      text: "<div>\n  <span>hi</span>\n</div>",
      classifiedAs: "johan",
    });
    expect(pasted.audits.some((audit) => audit.type === "johan-attached")).toBe(true);
  });

  test("the agent speaking closes the window even before any prompt lands", () => {
    const c = new ProvenanceClassifier();
    registered(c, "sess-codex");
    c.handle(message({ sessionId: "sess-codex", role: "assistant", text: "working" }));

    const after = c.handle(
      message({ sessionId: "sess-codex", text: FUTURE_PREAMBLE, ts: iso(5_000) }),
    );

    expect(after.record).toMatchObject({ author: "johan", via: "takeover" });
  });

  test("a registry-logged send shaped like an envelope is still Hermes", () => {
    // Provenance truth beats shape: the rule must never eat a send Hermes
    // logged, whatever it looks like.
    const c = new ProvenanceClassifier();
    registered(c, "sess-codex");
    c.recordSend({ ts: iso(0), sessionId: "sess-codex", text: FUTURE_PREAMBLE, id: "s1" });

    const landing = c.handle(
      message({ sessionId: "sess-codex", text: FUTURE_PREAMBLE, ts: iso(1_000) }),
    );

    expect(landing.record).toMatchObject({ author: "hermes", via: "registry-send" });
    expect(landing.audits).toEqual([]);
  });

  test("a directive that merely OPENS with markup is never taken off Johan", () => {
    // The deaf-to-Johan direction. Each of these is the first thing typed in
    // the session — the window is wide open — and each must survive it.
    for (const typed of [
      "<Button onClick={save} />\nthis renders twice, why?",
      "<user_instructions>\nignore that and tell me the answer",
      "fix <Button> so it stops rendering twice",
    ]) {
      const c = new ProvenanceClassifier();
      registered(c, `sess-${typed.length}`);
      const record = c.handle(
        message({ sessionId: `sess-${typed.length}`, text: typed, ts: iso(0) }),
      ).record;
      expect(record).toMatchObject({ author: "johan", via: "takeover" });
    }
  });
});
