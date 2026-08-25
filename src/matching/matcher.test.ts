import { describe, expect, test } from "bun:test";
import { SendMatcher } from "./matcher";

// All timestamps are ISO-8601 UTC (what sends.jsonl and both transcripts carry);
// the matcher also accepts epoch milliseconds. Times here are arbitrary but
// internally consistent — the library never reads the real clock.
const T0 = "2026-08-24T12:00:00.000Z";
const t0 = Date.parse(T0);
const at = (offsetMs: number) => t0 + offsetMs;

describe("SendMatcher: oldest-first consumption", () => {
  test("identical repeated sends resolve in timestamp order", () => {
    const m = new SendMatcher();
    // Registered out of order — the OLDER unconsumed send must win each match.
    m.addSend({ ts: at(10_000), text: "continue", id: "later" });
    m.addSend({ ts: T0, text: "continue", id: "earlier" });

    const first = m.classify({ text: "continue", ts: at(11_000) });
    expect(first.author).toBe("hermes");
    expect(first.author === "hermes" && first.send.id).toBe("earlier");

    const second = m.classify({ text: "continue", ts: at(12_000) });
    expect(second.author).toBe("hermes");
    expect(second.author === "hermes" && second.send.id).toBe("later");

    expect(m.classify({ text: "continue", ts: at(13_000) }).author).toBe("johan");
  });
});

describe("SendMatcher: queue-operation enqueue bridge", () => {
  // Claude Code stamps queued user records at DEQUEUE (= turn end), which can
  // be arbitrarily late; the enqueue record near send time bridges the window
  // (findings §3, §7 step "on claude queue-operation enqueue").
  test("enqueue-bridged send matches past the +3600s window", () => {
    const m = new SendMatcher();
    m.addSend({ ts: T0, text: "queued while turn runs" });
    m.onEnqueue({ content: "queued while turn runs", ts: at(150) });
    const r = m.classify({ text: "queued while turn runs", ts: at(3_700_000) });
    expect(r.author).toBe("hermes");
  });

  test("enqueue outside [send_ts - 5s, send_ts + 30s] does not bridge", () => {
    const m = new SendMatcher();
    m.addSend({ ts: T0, text: "stale enqueue" });
    m.onEnqueue({ content: "stale enqueue", ts: at(31_000) });
    expect(m.classify({ text: "stale enqueue", ts: at(3_700_000) }).author).toBe(
      "johan",
    );
  });

  test("enqueue with non-matching content does not bridge", () => {
    const m = new SendMatcher();
    m.addSend({ ts: T0, text: "the real send" });
    m.onEnqueue({ content: "something else entirely", ts: at(150) });
    expect(m.classify({ text: "the real send", ts: at(3_700_000) }).author).toBe(
      "johan",
    );
  });

  test("the bridge does not loosen the lower window bound", () => {
    const m = new SendMatcher();
    m.addSend({ ts: T0, text: "bridged but early" });
    m.onEnqueue({ content: "bridged but early", ts: at(100) });
    expect(m.classify({ text: "bridged but early", ts: at(-6_000) }).author).toBe(
      "johan",
    );
  });
});

describe("SendMatcher: expiry and audit events", () => {
  // Findings §4/§7: an unconsumed non-slash send past the window is loud —
  // audit event, never silence (SPEC §13 scenario 5's visibility principle).
  test("unconsumed prompt send past expiry emits one audit event and retires", () => {
    const m = new SendMatcher();
    m.addSend({ ts: T0, text: "never landed", id: "s1" });
    expect(m.sweepExpired(at(3_600_000))).toEqual([]); // not yet expired
    const events = m.sweepExpired(at(3_600_001));
    expect(events).toHaveLength(1);
    expect(events[0]!.type).toBe("send-expired");
    expect(events[0]!.send.id).toBe("s1");
    expect(m.sweepExpired(at(3_700_000))).toEqual([]); // retired: audited once
  });

  test("zero-landing slash send expires silently", () => {
    const m = new SendMatcher();
    m.addSend({ ts: T0, text: "/help" });
    expect(m.sweepExpired(at(3_600_001))).toEqual([]);
    // and it is really retired, not still pending:
    expect(m.pendingCount()).toBe(0);
  });

  test("bang sends are not slash: expiry is loud", () => {
    const m = new SendMatcher();
    m.addSend({ ts: T0, text: "!echo probe" });
    expect(m.sweepExpired(at(3_600_001))).toHaveLength(1);
  });

  test("a consumed send never expires", () => {
    const m = new SendMatcher();
    m.addSend({ ts: T0, text: "landed fine" });
    m.classify({ text: "landed fine", ts: at(1_000) });
    expect(m.sweepExpired(at(3_600_001))).toEqual([]);
  });

  test("an enqueue-bridged send is exempt from expiry", () => {
    const m = new SendMatcher();
    m.addSend({ ts: T0, text: "long turn ahead" });
    m.onEnqueue({ content: "long turn ahead", ts: at(200) });
    expect(m.sweepExpired(at(3_600_001))).toEqual([]);
    // still matchable afterwards — the dequeued record may land arbitrarily late
    expect(m.classify({ text: "long turn ahead", ts: at(4_000_000) }).author).toBe(
      "hermes",
    );
  });
});

describe("SendMatcher: encoding-bug diagnostic", () => {
  // Findings §4: a multi-line send to Claude Code without `\`+LF continuation
  // shatters into N one-line messages. Each is a hash-miss (→ Johan), but a
  // miss equal to a line of a pending multi-line send is flagged so the
  // adapter bug is visible instead of silently poisoning provenance.
  test("hash-miss equal to a line of a pending multi-line send is flagged", () => {
    const m = new SendMatcher();
    m.addSend({ ts: T0, text: "line one\nline two\nline three", id: "multi" });
    const r = m.classify({ text: "line one", ts: at(500) });
    expect(r.author).toBe("johan");
    expect(r.author === "johan" && r.encodingBugSuspect?.id).toBe("multi");
  });

  test("an ordinary Johan message carries no flag", () => {
    const m = new SendMatcher();
    m.addSend({ ts: T0, text: "line one\nline two" });
    const r = m.classify({ text: "unrelated thought", ts: at(500) });
    expect(r.author === "johan" && r.encodingBugSuspect).toBeUndefined();
  });
});

describe("SendMatcher: basic classification", () => {
  test("registry-logged send landing in window is Hermes-authored", () => {
    const m = new SendMatcher();
    m.addSend({ ts: T0, text: "E0 submit semantics probe" });
    const r = m.classify({ text: "E0 submit semantics probe", ts: at(1_000) });
    expect(r.author).toBe("hermes");
  });

  test("message with no matching send is Johan-authored", () => {
    const m = new SendMatcher();
    m.addSend({ ts: T0, text: "something hermes typed" });
    const r = m.classify({ text: "something johan typed", ts: at(1_000) });
    expect(r.author).toBe("johan");
  });

  test("a consumed send never matches again", () => {
    const m = new SendMatcher();
    m.addSend({ ts: T0, text: "continue" });
    expect(m.classify({ text: "continue", ts: at(500) }).author).toBe("hermes");
    expect(m.classify({ text: "continue", ts: at(600) }).author).toBe("johan");
  });

  test("window: message before send_ts - 5s is Johan", () => {
    const m = new SendMatcher();
    m.addSend({ ts: T0, text: "early bird" });
    expect(m.classify({ text: "early bird", ts: at(-5_001) }).author).toBe("johan");
    // -5s exactly is inside the window (T >= send.ts - 5s).
    m.addSend({ ts: T0, text: "on the lower edge" });
    expect(m.classify({ text: "on the lower edge", ts: at(-5_000) }).author).toBe(
      "hermes",
    );
  });

  test("window: message after send_ts + 3600s is Johan", () => {
    const m = new SendMatcher();
    m.addSend({ ts: T0, text: "too late" });
    expect(m.classify({ text: "too late", ts: at(3_600_001) }).author).toBe("johan");
    m.addSend({ ts: T0, text: "on the upper edge" });
    expect(m.classify({ text: "on the upper edge", ts: at(3_600_000) }).author).toBe(
      "hermes",
    );
  });

  test("matching is on normalized content (agent whitespace/unicode mutations)", () => {
    const m = new SendMatcher();
    // Hermes logs with CRLF + trailing spaces + NFD; agent lands NFC/LF/stripped.
    m.addSend({ ts: T0, text: "café line one\r\nline two   " });
    const r = m.classify({ text: "café line one\nline two", ts: at(1_200) });
    expect(r.author).toBe("hermes");
  });
});
