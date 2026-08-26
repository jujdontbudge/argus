import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadScaledMs } from "../eyes/test-budget.ts";
import { registerAllScenarios } from "./all-scenarios.ts";
import {
  createScenarioRegistry,
  runScenario,
  type CoreScenarioNumber,
} from "./index.ts";
import { liveHalfTitle } from "./live-gate.ts";
import {
  createLiveProvenanceDriver,
  describeLiveSlotsGate,
  liveSlotScenario,
  LIVE_SLOTS,
  LIVE_SLOTS_GATE,
  LIVE_SLOT_NUMBERS,
  probeLiveSlots,
  resolveLiveSlotsGate,
  runnableLiveSlots,
  type LiveSlotsProbe,
} from "./live-slots.ts";
import { NATIVE_CLAUDE } from "./subscription-gate.ts";
import {
  effectiveDoubles,
  renderVerdictTable,
  gradeScenario,
  SPEC_MANIFESTS,
} from "./verdicts.ts";

/**
 * Ticket #78 — driving the §13 slots themselves against real agents.
 *
 * Everything above the live test runs on every `bun test`: the gate's states,
 * SPEC §1's rule that no missing credential can produce NOT RUN on the Claude
 * side, and the two properties that make a live grade worth reading — that a
 * double is retired by EVIDENCE and never by a manifest, and that the slots
 * chosen are the ones a live driver can honestly serve.
 *
 * What is NOT tested on the default path is the drive itself, and for #63's
 * reason: there is no spawner seam to test it through. A fake spawner would
 * let a fixture run record live evidence and retire a double it never
 * retired, which is the overclaim this whole verdict surface exists to delete.
 * What stops the drive rotting unnoticed (#46) is the banner below, which
 * prints on EVERY run, gate open or shut.
 */
const checkout = fileURLToPath(new URL("../../", import.meta.url));
const gate = resolveLiveSlotsGate(probeLiveSlots());

// Always, both ways: `bun test` prints no name for a skipped test, so this
// line is the whole of a skip's visibility on the default path.
console.log(describeLiveSlotsGate(gate));

/** Six real multi-turn CLI sessions across two slots, plus two sandboxes. */
const LIVE_SLOTS_BUDGET_MS = loadScaledMs(900_000, 2_400_000);

const probe = (overrides: Partial<LiveSlotsProbe> = {}): LiveSlotsProbe => ({
  codexAuthPresent: true,
  codexInstalled: true,
  env: { [LIVE_SLOTS_GATE]: "1" },
  nativeClaudeInstalled: true,
  ...overrides,
});

describe("the LIVE SLOT gate", () => {
  test("is shut by default, and both legs say so", () => {
    const shut = resolveLiveSlotsGate(probe({ env: {} }));

    expect(shut.enabled).toBe(false);
    expect([shut.claude.status, shut.codex.status]).toEqual([
      "gate-unset",
      "gate-unset",
    ]);
    expect(runnableLiveSlots(shut)).toEqual([]);
    expect(liveHalfTitle("x", shut.claude)).toStartWith("x — SKIPPED: ");
    expect(describeLiveSlotsGate(shut)).toContain("SKIPPED");
  });

  test("no other live gate opens it — a different cost needs its own opt-in", () => {
    // #74's rule. ARGUS_LIVE_AGENTS buys two one-sentence round trips and the
    // FULL journey buys five watcher processes; this buys six multi-turn
    // sessions. Rolling one opt-in into another is how a gate stops being one.
    for (const other of [
      "ARGUS_LIVE_AGENTS",
      "ARGUS_LIVE_CLAUDE_SUBSCRIPTION",
      "ARGUS_LIVE_FULL_JOURNEY",
      "ARGUS_LIVE_HONCHO",
    ]) {
      expect(resolveLiveSlotsGate(probe({ env: { [other]: "1" } })).enabled).toBe(
        false,
      );
    }
  });

  test("SPEC §1: no missing credential can make the Claude leg NOT RUN", () => {
    // Items 7 and 8. Subscription mode needs no token, so no branch in the
    // resolver reads one and the only blocking reason left is a missing CLI.
    for (const env of [
      { [LIVE_SLOTS_GATE]: "1" },
      { [LIVE_SLOTS_GATE]: "1", ANTHROPIC_API_KEY: "" },
      { [LIVE_SLOTS_GATE]: "1", CLAUDE_CODE_OAUTH_TOKEN: "" },
    ]) {
      expect(resolveLiveSlotsGate(probe({ env })).claude.status).toBe("run");
    }

    expect(resolveLiveSlotsGate(probe({ nativeClaudeInstalled: false })).claude).toEqual(
      { reason: `the native claude CLI is not at ${NATIVE_CLAUDE}`, status: "not-run" },
    );
  });

  test("an asked-for Codex leg with no CLI or no auth is NOT RUN, never skipped", () => {
    expect(resolveLiveSlotsGate(probe({ codexInstalled: false })).codex).toEqual({
      reason: "the codex CLI is not on PATH",
      status: "not-run",
    });
    expect(
      resolveLiveSlotsGate(probe({ codexAuthPresent: false })).codex.status,
    ).toBe("not-run");
  });

  test("a missing CLI takes its own slot out and leaves the other runnable", () => {
    // Slot 4 is the codex leg and slot 5 the claude leg, so one absent CLI
    // must cost exactly one slot rather than the whole drive.
    expect(runnableLiveSlots(resolveLiveSlotsGate(probe()))).toEqual([4, 5]);
    expect(
      runnableLiveSlots(resolveLiveSlotsGate(probe({ codexInstalled: false }))),
    ).toEqual([5]);
    expect(
      runnableLiveSlots(
        resolveLiveSlotsGate(probe({ nativeClaudeInstalled: false })),
      ),
    ).toEqual([4]);
  });

  test("the open banner names both legs and SPEC §1's no-key rule", () => {
    const banner = describeLiveSlotsGate(resolveLiveSlotsGate(probe()));

    expect(banner).toContain(`${LIVE_SLOTS_GATE}=1`);
    expect(banner).toContain("claude  RUN");
    expect(banner).toContain("codex   RUN");
    expect(banner).toContain("no Anthropic API key, no token, no metered provider");
  });
});

describe("what a live slot drive is allowed to claim", () => {
  test("only slots 4 and 5 declare a live drive retires anything", () => {
    // The other eight are not omitted for lack of effort — `live-slots.ts`
    // states why each one is out. Pinning the set here is what stops a later
    // ticket adding a `retiredByLiveDrive` to a slot nothing drives.
    const declared = (Object.keys(SPEC_MANIFESTS) as unknown as string[])
      .map(Number)
      .filter(
        (number) =>
          SPEC_MANIFESTS[number as CoreScenarioNumber].retiredByLiveDrive !==
          undefined,
      );

    expect(declared).toEqual([...LIVE_SLOT_NUMBERS]);
    for (const slot of LIVE_SLOT_NUMBERS) {
      // `agent` and nothing else. `cmux` and `hermes` survive a live drive,
      // because a real session does not make the registry row a real Hermes
      // send or the resumed turn a real `cmux send`.
      expect(SPEC_MANIFESTS[slot].retiredByLiveDrive).toEqual(["agent"]);
      expect(SPEC_MANIFESTS[slot].doubles).toContain("agent");
    }
  });

  test("a double is retired by EVIDENCE, never by the manifest alone", () => {
    for (const slot of LIVE_SLOT_NUMBERS) {
      const manifest = SPEC_MANIFESTS[slot];

      // The fixture run — which is what every default `bun test` does — keeps
      // every double the slot has always declared.
      expect(effectiveDoubles(manifest, [])).toEqual(manifest.doubles);
      // And even with the double retired, the slot stays STRUCTURAL: `cmux`
      // and `hermes` are still doubles, so LIVE is not on offer here.
      const live = effectiveDoubles(manifest, ["codex: exit 0"]);
      expect(live).not.toContain("agent");
      expect([...live]).toEqual(["cmux", "hermes"]);
    }
  });

  test("both CLIs are exercised — one slot each, not two sessions per slot", () => {
    expect(Object.values(LIVE_SLOTS).sort()).toEqual(["claude", "codex"]);
  });
});

test.skipIf(runnableLiveSlots(gate).length === 0)(
  liveHalfTitle(
    "§13 slots 4 and 5 driven by REAL agents — the `agent` double retired in the slot",
    gate.claude.status === "run" ? gate.claude : gate.codex,
  ),
  async () => {
    const reportDirectory = await mkdtemp(join(tmpdir(), "argus-live-slots-"));
    const slots = runnableLiveSlots(gate);
    const grades = [];

    try {
      for (const slot of slots) {
        // A driver per slot. `runScenario` owns the sandbox — the driver takes
        // its scope from the one it is handed — and the two slots must not see
        // each other's sessions.
        const driver = createLiveProvenanceDriver();
        const registry = createScenarioRegistry();
        registerAllScenarios(registry, { driver });

        {
          const result = await runScenario({
            checkout,
            name: `${slot}. live slot drive`,
            reportDirectory,
            scenario: liveSlotScenario(registry.get(slot)!, driver),
          });

          console.log(
            [
              "",
              `slot ${slot} (${LIVE_SLOTS[slot]}) live evidence:`,
              ...result.liveEvidence.map((line) => `  ${line}`),
            ].join("\n"),
          );

          expect({
            slot,
            error: result.error,
            failed: result.assertions
              .filter(({ passed }) => !passed)
              .map(({ description }) => description),
            status: result.status,
          }).toEqual({ slot, error: null, failed: [], status: "passed" });

          // The whole point of the ticket, asserted on the slot's own report.
          expect(result.liveEvidence.length).toBeGreaterThan(0);

          const grade = gradeScenario(SPEC_MANIFESTS[slot], result);
          grades.push(grade);

          // Retired here, and only here. `agent` is gone because a real CLI
          // wrote every message this slot classified.
          expect(grade.doubles).not.toContain("agent");
          // And NOT reached: `cmux` and `hermes` are untouched by a live
          // agent, so the verdict stays STRUCTURAL. An inflated LIVE is what
          // #63, #74 and #76 each refused; this refuses it too.
          expect([...grade.doubles]).toEqual(["cmux", "hermes"]);
          expect(grade.verdict).toBe("STRUCTURAL");
          // A manifest requirement whose assertion vanished is the one grade
          // that IS a regression — the live driver must not have quietly cost
          // the slot a half.
          expect(grade.counts.missing).toBe(0);
        }
      }

      console.log(renderVerdictTable(grades));
    } finally {
      await rm(reportDirectory, { force: true, recursive: true });
    }
  },
  LIVE_SLOTS_BUDGET_MS,
);
