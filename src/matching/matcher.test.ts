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
