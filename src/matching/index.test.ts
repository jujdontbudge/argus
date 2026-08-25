import { describe, expect, test } from "bun:test";
import * as matching from "./index";

describe("public API surface", () => {
  test("exports the full matcher toolkit", () => {
    expect(typeof matching.normalize).toBe("function");
    expect(typeof matching.sha256Hex).toBe("function");
    expect(typeof matching.hashText).toBe("function");
    expect(typeof matching.deriveKind).toBe("function");
    expect(typeof matching.derivedForms).toBe("function");
    expect(typeof matching.claudeCandidateText).toBe("function");
    expect(typeof matching.codexCandidateText).toBe("function");
    expect(typeof matching.isCodexSubagentThread).toBe("function");
    expect(typeof matching.syntheticEnvelopeTag).toBe("function");
    expect(typeof matching.toEpochMs).toBe("function");
    expect(typeof matching.SendMatcher).toBe("function");
    expect(matching.WINDOW_BEFORE_MS).toBe(5_000);
    expect(matching.WINDOW_AFTER_MS).toBe(3_600_000);
    expect(matching.ENQUEUE_BRIDGE_AFTER_MS).toBe(30_000);
  });
});
