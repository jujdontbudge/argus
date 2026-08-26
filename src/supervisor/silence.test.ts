import { describe, expect, test } from "bun:test";

import {
  SILENT_DEPLOYMENT_MS,
  silenceThresholdMs,
  silentDeployments,
  type SilenceInput,
} from "./silence.ts";
import { WINDOW_AFTER_MS } from "../matching";

/**
 * Ticket #96, half 2 — the silence, which is the dangerous half.
 *
 * #89's third drive had a durable registry row, five live watchers, no
 * transcript and NOTHING NOTICING. From inside Argus that reads identically to
 * five broken eyes. The trust dialog was the cause that day; the CLASS is "a
 * deployment Argus registered, with the archiver live, that has archived zero
 * messages". Nothing below mentions a dialog: a session that died at exec, one
 * whose transcript lands in a home the eyes do not read (#89 finding D), and
 * one sitting on a modal all produce the same input here and all degrade.
 *
 * This is #85's shape one level up: #85 made an alive PID with no matching
 * health report degraded instead of silently running; this makes a live
 * deployment with no archived message degraded instead of silently empty.
 */
const DEPLOYED = "2026-08-26T12:00:00.000Z";
const now = (offsetMs: number): number => Date.parse(DEPLOYED) + offsetMs;

function input(overrides: Partial<SilenceInput> = {}): SilenceInput {
  return {
    archivedSessionIds: new Set<string>(),
    archiverAlive: true,
    now: now(SILENT_DEPLOYMENT_MS + 1),
    repo: "/repo",
    sessions: [
      {
        agent: "claude",
        dispatchPrompt: "You are working ticket #96.",
        sessionId: "session-96",
        ticket: "96",
        ts: DEPLOYED,
      },
    ],
    thresholdMs: SILENT_DEPLOYMENT_MS,
    ...overrides,
  };
}

describe("a live deployment that has archived nothing", () => {
  test("degrades, with a reason an operator can act on", () => {
    const [row, ...rest] = silentDeployments(input());
    expect(rest).toEqual([]);
    expect(row).toBeDefined();
    expect(row!.sessionId).toBe("session-96");
    expect(row!.repo).toBe("/repo");
    expect(row!.ticket).toBe("96");
    expect(row!.agent).toBe("claude");
    expect(row!.state).toBe("degraded");
    expect(row!.silentForMs).toBeGreaterThanOrEqual(SILENT_DEPLOYMENT_MS);
    // The reason names the measurement, not the diagnosis: zero archived
    // messages while the archiver is live. It must be readable without this
    // source file open.
    expect(row!.reason).toMatch(/archived 0 messages/);
    expect(row!.reason).toMatch(/archiver/);
    expect(row!.reason).toMatch(/5m/);
  });

  test("stays quiet inside the threshold: a slow first token is not an outage", () => {
    expect(silentDeployments(input({ now: now(SILENT_DEPLOYMENT_MS - 1) }))).toEqual([]);
  });

  test("one archived message is enough to clear it", () => {
    expect(
      silentDeployments(input({ archivedSessionIds: new Set(["session-96"]) })),
    ).toEqual([]);
  });

  test("says nothing when the archiver is not running — zero proves nothing then", () => {
    // Not a silent deployment: a stopped or crashed archiver is already its own
    // status row (#85). Blaming the deployment for it would be a second, wrong
    // reason for one fault.
    expect(silentDeployments(input({ archiverAlive: false }))).toEqual([]);
  });

  test("hands off to dispatch-expired at the hour and stops repeating it", () => {
    // The classifier already audits a registered dispatch whose transcript
    // never showed, once, at WINDOW_AFTER_MS — and that audit is in `argus
    // status` already. This check owns the gap before it, not forever after.
    expect(silentDeployments(input({ now: now(WINDOW_AFTER_MS - 1) }))).toHaveLength(1);
    expect(silentDeployments(input({ now: now(WINDOW_AFTER_MS + 1) }))).toEqual([]);
  });

  test("an epoch-ms row is measured the same as an ISO one", () => {
    const sessions = [
      {
        dispatchPrompt: "d",
        sessionId: "session-epoch",
        ts: Date.parse(DEPLOYED),
      },
    ];
    expect(silentDeployments(input({ sessions }))).toHaveLength(1);
  });

  test("reports each silent session once, keeping the earliest row for it", () => {
    const sessions = [
      { dispatchPrompt: "d", sessionId: "s", ts: DEPLOYED },
      { dispatchPrompt: "d", sessionId: "s", ts: now(60_000) },
      { dispatchPrompt: "d", sessionId: "loud", ts: DEPLOYED },
    ];
    const rows = silentDeployments(
      input({ archivedSessionIds: new Set(["loud"]), sessions }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.deployedAt).toBe(DEPLOYED);
  });

  test("the cause is never asserted: a session that died at exec degrades too", () => {
    // Same input, no dialog anywhere in it. The class is the value.
    const rows = silentDeployments(
      input({
        sessions: [
          { dispatchPrompt: "codex exec that failed", sessionId: "dead", ts: DEPLOYED },
        ],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.reason).not.toMatch(/trust/i);
  });
});

describe("the threshold", () => {
  test("is five minutes, and is overridable for drives that need it", () => {
    expect(SILENT_DEPLOYMENT_MS).toBe(300_000);
    expect(silenceThresholdMs({})).toBe(300_000);
    expect(silenceThresholdMs({ ARGUS_SILENT_DEPLOYMENT_MS: "90000" })).toBe(90_000);
    expect(silenceThresholdMs({ ARGUS_SILENT_DEPLOYMENT_MS: "nonsense" })).toBe(300_000);
    expect(silenceThresholdMs({ ARGUS_SILENT_DEPLOYMENT_MS: "-1" })).toBe(300_000);
  });
});
