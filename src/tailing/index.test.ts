import { describe, expect, test } from "bun:test";
import * as tailing from "./index";

describe("public API surface", () => {
  test("exports the tailing toolkit", () => {
    expect(typeof tailing.Tailer).toBe("function");
    expect(typeof tailing.readNewLines).toBe("function");
    expect(typeof tailing.createClaudeCodeSource).toBe("function");
    expect(typeof tailing.claudeProjectDir).toBe("function");
    expect(typeof tailing.createCodexSource).toBe("function");
    expect(typeof tailing.registerCodexScenarios).toBe("function");
    expect(typeof tailing.createHermesSource).toBe("function");
    expect(typeof tailing.registerHermesScenarios).toBe("function");
  });
});
