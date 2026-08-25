import { describe, expect, test } from "bun:test";
import { normalize } from "./normalize";

// Behaviors pinned by research/send-transcript-matching.md §7: the pipeline
// NFC-normalizes NFD input (probe E3c) on both agents.
describe("normalize", () => {
  test("NFD input is normalized to NFC", () => {
    const nfd = "café"; // "cafe" + U+0301 combining acute (NFD)
    const nfc = "café"; // precomposed (NFC)
    expect(nfd).not.toBe(nfc); // sanity: the inputs really differ pre-normalization
    expect(normalize(nfd)).toBe(nfc);
  });

  test("CRLF and lone CR become LF", () => {
    expect(normalize("line one\r\nline two\rline three")).toBe(
      "line one\nline two\nline three",
    );
  });

  // E2a: 'E2 line two   <LF>' — Claude strips trailing spaces per line.
  test("trailing whitespace is stripped per line", () => {
    expect(normalize("line one\nline two   \nline three\t")).toBe(
      "line one\nline two\nline three",
    );
  });

  // E4: Codex trims leading whitespace of the whole message, Claude trailing;
  // outer trim covers both directions, including blank first/last lines.
  test("outer whitespace is trimmed", () => {
    expect(normalize("   E4 leading probe")).toBe("E4 leading probe");
    expect(normalize("\n\n  body  \n\n")).toBe("body");
  });

  test("normalize is idempotent", () => {
    const messy = " á  \r\n\tmid line \r x ";
    expect(normalize(normalize(messy))).toBe(normalize(messy));
  });
});
