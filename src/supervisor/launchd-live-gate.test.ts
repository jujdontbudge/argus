import { describe, expect, test } from "bun:test";

import {
  LIVE_LAUNCHD_SMOKE_GATE,
  resolveLaunchdSmokeGate,
} from "./launchd-live-gate.ts";

const ready = {
  codexPath: "/scratch/bin/codex",
  env: { [LIVE_LAUNCHD_SMOKE_GATE]: "1" },
  ghPath: "/scratch/bin/gh",
  launchctlAvailable: true,
  platform: "darwin" as const,
};

describe("launchd live-smoke gate", () => {
  test("distinguishes gate-unset, not-run, and run", () => {
    expect(resolveLaunchdSmokeGate({ ...ready, env: {} }).status).toBe(
      "gate-unset",
    );
    expect(
      resolveLaunchdSmokeGate({ ...ready, launchctlAvailable: false }).status,
    ).toBe("not-run");
    expect(resolveLaunchdSmokeGate(ready).status).toBe("run");
  });
});
