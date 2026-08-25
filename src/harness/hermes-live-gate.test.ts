import { describe, expect, test } from "bun:test";

import {
  LIVE_HERMES_GATE,
  resolveHermesLiveGate,
  type HermesLiveProbe,
} from "./hermes-live-gate.ts";

const READY: HermesLiveProbe = {
  env: { [LIVE_HERMES_GATE]: "1" },
  hermesInstalled: true,
  realProfile: undefined,
};

describe("the live-Hermes gate", () => {
  test("SKIPS the scratch drive when nobody set the gate", () => {
    const gate = resolveHermesLiveGate({ ...READY, env: {} });

    expect(LIVE_HERMES_GATE).toBe("ARGUS_LIVE_HERMES");
    expect(gate.enabled).toBe(false);
    expect(gate.scratch.status).toBe("gate-unset");
    expect(gate.scratch.reason).toContain("ARGUS_LIVE_HERMES");
  });

  test("holds the scratch drive NOT RUN when the hermes CLI is absent", () => {
    const gate = resolveHermesLiveGate({ ...READY, hermesInstalled: false });

    expect(gate.enabled).toBe(true);
    expect(gate.scratch.status).toBe("not-run");
    expect(gate.scratch.reason).toBe("the hermes CLI is not on PATH");
  });

  test("runs the scratch drive once the gate is set and hermes is installed", () => {
    expect(resolveHermesLiveGate(READY).scratch).toEqual({
      half: "scratch",
      reason: "gate set and the hermes CLI is on PATH",
      status: "run",
    });
  });

  test("tells the two skips apart — an unset gate is not a missing CLI", () => {
    // The distinction #43 drew and the one this ticket exists for: collapsing
    // "nobody asked" into "asked, and the machine cannot" is how a half rots.
    const unset = resolveHermesLiveGate({ ...READY, env: {} }).scratch;
    const absent = resolveHermesLiveGate({
      ...READY,
      hermesInstalled: false,
    }).scratch;

    expect(unset.status).not.toBe(absent.status);
    expect(unset.reason).not.toBe(absent.reason);
  });
});
