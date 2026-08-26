import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadScaledMs } from "../eyes/test-budget.ts";
import { runScenario } from "./index.ts";
import { liveHalfTitle } from "./live-gate.ts";
import {
  describeFullJourneyGate,
  fullJourneyScenario,
  FULL_JOURNEY_GATE,
  FULL_JOURNEY_MANIFEST,
  probeFullJourney,
  resolveFullJourneyGate,
  type FullJourneyProbe,
} from "./full-journey.ts";
import { NATIVE_CLAUDE } from "./subscription-gate.ts";
import { gradeScenario, renderVerdictTable } from "./verdicts.ts";

/**
 * Ticket #63 — the FULL real-driver journey, and the gate that keeps it off
 * the default path.
 *
 * Everything above the live test runs on every `bun test`: the gate's six
 * states, SPEC §1's invariant that no missing credential can ever produce NOT
 * RUN on the Claude side, and — the one that matters most — that the journey
 * REFUSES to pass when no leg is runnable. A journey that quietly asserts
 * nothing when the gate is shut is the silent pass this ticket exists to
 * delete, so it is tested as an explicit failure rather than trusted.
 *
 * What is NOT tested on the default path is the drive itself, because the
 * journey takes no spawner seam: a fake spawner would let a fixture run record
 * live evidence and grade LIVE. That trade is stated in `full-journey.ts` and
 * paid for by the banner, which prints on every run whether the gate is open
 * or shut.
 */
const checkout = fileURLToPath(new URL("../../", import.meta.url));
const gate = resolveFullJourneyGate(probeFullJourney());

// Always, both ways: `bun test` prints no name for a skipped test, so this
// line is the whole of a skip's visibility on the default path.
console.log(describeFullJourneyGate(gate));

const SANDBOX_BUDGET_MS = loadScaledMs(120_000, 360_000);
/** Two real round trips, five watcher processes and an archive settle. */
const JOURNEY_BUDGET_MS = loadScaledMs(600_000, 1_800_000);

const probe = (overrides: Partial<FullJourneyProbe> = {}): FullJourneyProbe => ({
  codexAuthPresent: true,
  codexInstalled: true,
  env: { [FULL_JOURNEY_GATE]: "1" },
  nativeClaudeInstalled: true,
  ...overrides,
});

describe("the FULL journey gate", () => {
  test("is shut by default, and both legs say so", () => {
    const shut = resolveFullJourneyGate(probe({ env: {} }));

    expect(shut.enabled).toBe(false);
    expect([shut.claude.status, shut.codex.status]).toEqual([
      "gate-unset",
      "gate-unset",
    ]);
    expect(liveHalfTitle("x", shut.claude)).toStartWith("x — SKIPPED: ");
    expect(describeFullJourneyGate(shut)).toContain("SKIPPED");
  });

  test("#43's gate does NOT open it — a heavier drive needs its own opt-in", () => {
    // ARGUS_LIVE_AGENTS buys two one-sentence round trips. This buys those
    // plus a supervisor and five watcher processes. Upgrading someone's
    // opt-in from the first to the second is how a gate stops being one.
    expect(
      resolveFullJourneyGate(probe({ env: { ARGUS_LIVE_AGENTS: "1" } })).enabled,
    ).toBe(false);
    expect(
      resolveFullJourneyGate(
        probe({ env: { ARGUS_LIVE_CLAUDE_SUBSCRIPTION: "1" } }),
      ).enabled,
    ).toBe(false);
  });

  test("SPEC §1: no missing credential can make the Claude leg NOT RUN", () => {
    // Items 7 and 8. Johan's plan permits no Anthropic API access, so a gate
    // that blocks on a token or a key blocks forever on the only machine
    // Argus runs on. The ONLY blocking reason left is a missing CLI.
    for (const env of [
      { [FULL_JOURNEY_GATE]: "1" },
      { [FULL_JOURNEY_GATE]: "1", ANTHROPIC_API_KEY: "" },
      { [FULL_JOURNEY_GATE]: "1", CLAUDE_CODE_OAUTH_TOKEN: "" },
    ]) {
      expect(resolveFullJourneyGate(probe({ env })).claude.status).toBe("run");
    }

    const noCli = resolveFullJourneyGate(probe({ nativeClaudeInstalled: false }));
    expect(noCli.claude).toEqual({
      reason: `the native claude CLI is not at ${NATIVE_CLAUDE}`,
      status: "not-run",
    });
  });

  test("an asked-for Codex leg with no CLI or no auth is NOT RUN, never skipped", () => {
    expect(
      resolveFullJourneyGate(probe({ codexInstalled: false })).codex,
    ).toEqual({ reason: "the codex CLI is not on PATH", status: "not-run" });
    expect(
      resolveFullJourneyGate(probe({ codexAuthPresent: false })).codex.status,
    ).toBe("not-run");
    expect(
      liveHalfTitle("x", resolveFullJourneyGate(probe({ codexInstalled: false })).codex),
    ).toStartWith("x — NOT RUN: ");
  });

  test("the open banner names both legs and SPEC §1's no-key rule", () => {
    const banner = describeFullJourneyGate(resolveFullJourneyGate(probe()));

    expect(banner).toContain(`${FULL_JOURNEY_GATE}=1`);
    expect(banner).toContain("claude  RUN");
    expect(banner).toContain("codex   RUN");
    expect(banner).toContain("no Anthropic API key, no token, no metered provider");
  });
});

describe("the FULL journey manifest", () => {
  test("declares no doubles, and reports its own gaps rather than slot 1's", () => {
    expect(FULL_JOURNEY_MANIFEST.doubles).toEqual([]);

    const uncovered = FULL_JOURNEY_MANIFEST.requirements
      .filter(({ assertions }) => assertions.length === 0)
      .map(({ id }) => id);
    // The journey does not run the eyes' brains and does not close a ticket.
    // Inheriting slot 1's structural coverage for those would be the same
    // overclaim in a new file, so they are UNCOVERED here on purpose.
    expect(uncovered).toEqual([
      "13.1.memory-md",
      "13.1.digests-index",
      "13.1.tickets-closed",
    ]);
  });

  test("reaches LIVE only on a report carrying live evidence", () => {
    const assertions = FULL_JOURNEY_MANIFEST.requirements
      .flatMap(({ assertions: names }) => names)
      .map((description) => ({ description, passed: true }));

    expect(
      gradeScenario(FULL_JOURNEY_MANIFEST, {
        assertions,
        liveEvidence: [],
        status: "passed",
      }).verdict,
    ).toBe("STRUCTURAL");
    expect(
      gradeScenario(FULL_JOURNEY_MANIFEST, {
        assertions,
        liveEvidence: ["claude: exit 0"],
        status: "passed",
      }).verdict,
    ).toBe("LIVE");
  });
});

test(
  "with no runnable leg the journey FAILS rather than passing quietly",
  async () => {
    // The anti-silent-pass property, asserted directly. A journey whose gate
    // is shut must not run — but if it is ever invoked anyway, it must not
    // report a green scenario that drove nothing.
    const reportDirectory = await mkdtemp(join(tmpdir(), "argus-journey-"));

    try {
      const result = await runScenario({
        checkout,
        name: "full journey with a shut gate",
        reportDirectory,
        scenario: fullJourneyScenario({
          gate: resolveFullJourneyGate(probe({ env: {} })),
        }),
      });

      expect(result.status).toBe("failed");
      expect(result.error).toContain(
        "at least one live agent leg is runnable — the journey is not a no-op",
      );
      expect(result.liveEvidence).toEqual([]);
      expect(result.verdict).toBe("STRUCTURAL");
    } finally {
      await rm(reportDirectory, { force: true, recursive: true });
    }
  },
  SANDBOX_BUDGET_MS,
);

test.skipIf(gate.claude.status !== "run" && gate.codex.status !== "run")(
  liveHalfTitle(
    "§13 FULL real-driver journey: SimulationDriverRunner, real agents, real watchers",
    gate.claude,
  ),
  async () => {
    const reportDirectory = await mkdtemp(join(tmpdir(), "argus-journey-live-"));

    try {
      const result = await runScenario({
        checkout,
        name: "1. FULL real-driver journey",
        reportDirectory,
        scenario: fullJourneyScenario({ gate }),
      });

      const grade = gradeScenario(FULL_JOURNEY_MANIFEST, result);
      console.log(renderVerdictTable([grade]));

      expect({
        error: result.error,
        failed: result.assertions
          .filter(({ passed }) => !passed)
          .map(({ description }) => description),
        status: result.status,
      }).toEqual({ error: null, failed: [], status: "passed" });

      // The verdict this journey exists to earn, and the only place in the
      // tree that earns it: evidence recorded from agents it actually spawned.
      expect(result.verdict).toBe("LIVE");
      expect(grade.verdict).toBe("LIVE");
      expect(result.liveEvidence.length).toBeGreaterThan(0);
      expect(grade.counts.missing).toBe(0);
      expect(grade.counts.live).toBeGreaterThan(0);
    } finally {
      await rm(reportDirectory, { force: true, recursive: true });
    }
  },
  JOURNEY_BUDGET_MS,
);
