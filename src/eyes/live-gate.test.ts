import { describe, expect, test } from "bun:test";

import {
  LIVE_HONCHO_GATE,
  LIVE_WATCHER_BRAINS_GATE,
  resolveHonchoGate,
  resolveWatcherBrainGate,
} from "./live-gate";

describe("explicit live integration gates", () => {
  test("uses gate-unset for every value except the exact opt-in", () => {
    for (const value of [undefined, "", "0", "true"]) {
      expect(
        resolveWatcherBrainGate({
          codexInstalled: true,
          env: { [LIVE_WATCHER_BRAINS_GATE]: value },
        }).status,
      ).toBe("gate-unset");
      expect(
        resolveHonchoGate({ [LIVE_HONCHO_GATE]: value }, null).status,
      ).toBe("gate-unset");
    }
  });

  test("reports NOT RUN only after an explicit gate asks for an unavailable integration", () => {
    expect(
      resolveWatcherBrainGate({
        codexInstalled: false,
        env: { [LIVE_WATCHER_BRAINS_GATE]: "1" },
      }),
    ).toEqual({ reason: "the codex CLI is not on PATH", status: "not-run" });
    expect(
      resolveHonchoGate(
        { [LIVE_HONCHO_GATE]: "1" },
        "the local Honcho service is unavailable",
      ),
    ).toEqual({
      reason: "the local Honcho service is unavailable",
      status: "not-run",
    });
  });

  test("missing API keys never block the subscription-backed watcher brain", () => {
    expect(
      resolveWatcherBrainGate({
        codexInstalled: true,
        env: {
          [LIVE_WATCHER_BRAINS_GATE]: "1",
          ANTHROPIC_API_KEY: undefined,
          OPENAI_API_KEY: undefined,
        },
      }).status,
    ).toBe("run");
  });
});
