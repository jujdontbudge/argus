import { describe, expect, test } from "bun:test";
import { SendMatcher } from "./matcher";

// All timestamps are ISO-8601 UTC (what sends.jsonl and both transcripts carry);
// the matcher also accepts epoch milliseconds. Times here are arbitrary but
// internally consistent — the library never reads the real clock.
const T0 = "2026-08-24T12:00:00.000Z";
const t0 = Date.parse(T0);
const at = (offsetMs: number) => t0 + offsetMs;

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

  test("matching is on normalized content (agent whitespace/unicode mutations)", () => {
    const m = new SendMatcher();
    // Hermes logs with CRLF + trailing spaces + NFD; agent lands NFC/LF/stripped.
    m.addSend({ ts: T0, text: "café line one\r\nline two   " });
    const r = m.classify({ text: "café line one\nline two", ts: at(1_200) });
    expect(r.author).toBe("hermes");
  });
});
