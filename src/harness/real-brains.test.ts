import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadScaledMs } from "../eyes/test-budget.ts";
import {
  LIVE_WATCHER_BRAINS_GATE,
  resolveWatcherBrainGate,
} from "../eyes/live-gate.ts";
import { liveHalfTitle } from "./live-gate.ts";
import {
  describeRealBrainHarnessGate,
  gradeRealBrainHarness,
  probeRealBrainHarness,
  REAL_BRAIN_MANIFESTS,
  REAL_BRAIN_SLOTS,
  runRealBrainHarness,
  type RealBrainSlot,
} from "./real-brains.ts";
import { renderVerdictTable, SPEC_MANIFESTS } from "./verdicts.ts";

const checkout = fileURLToPath(new URL("../../", import.meta.url));
const gate = probeRealBrainHarness();

// A skipped Bun test does not print its name. The banner is the evidence that
// the expensive half was not silently rounded into the default suite.
console.log(describeRealBrainHarnessGate(gate));

const expectedCalls: Readonly<Record<RealBrainSlot, number>> = {
  1: 4, // Reviewer extraction + skills, Digest, completion review
  2: 4, // Reviewer extraction + skills, Digest, Retro scope drift
  3: 2, // Digest signal + Retro filing
  6: 0, // watcher lifecycle only; no judgment is asked
  7: 1, // Digest status judgment
  8: 3, // Reviewer extraction + skills, Curator
  9: 0, // Honcho routing only; no watcher brain exists on this path
  10: 0, // idle eyes plus Archiver; no judgment is asked
};

describe("the real-brain harness gate", () => {
  test("is exact opt-in and keeps gate-unset distinct from not-run", () => {
    for (const value of [undefined, "", "0", "true"]) {
      expect(
        resolveWatcherBrainGate({
          codexInstalled: true,
          env: { [LIVE_WATCHER_BRAINS_GATE]: value },
        }).status,
      ).toBe("gate-unset");
    }
    const missing = resolveWatcherBrainGate({
      codexInstalled: false,
      env: { [LIVE_WATCHER_BRAINS_GATE]: "1" },
    });
    expect(missing.status).toBe("not-run");
    expect(liveHalfTitle("real brains", missing)).toStartWith(
      "real brains — NOT RUN: ",
    );
  });

  test("the banner says this remains STRUCTURAL and names the spend shape", () => {
    const shut = resolveWatcherBrainGate({ codexInstalled: true, env: {} });
    const banner = describeRealBrainHarnessGate(shut);
    expect(banner).toContain("SKIPPED");
    expect(banner).toContain("8 STRUCTURAL slots; 5 spend calls");
  });
});

describe("the eight real-brain manifests", () => {
  test("retire exactly brain and preserve every core assertion", () => {
    expect(REAL_BRAIN_SLOTS).toEqual([1, 2, 3, 6, 7, 8, 9, 10]);
    expect(REAL_BRAIN_MANIFESTS.map(({ number }) => number)).toEqual(
      REAL_BRAIN_SLOTS.map((slot) => `${slot}-real-brain`),
    );

    for (const [index, rendered] of REAL_BRAIN_MANIFESTS.entries()) {
      const slot = REAL_BRAIN_SLOTS[index]!;
      const core = SPEC_MANIFESTS[slot];
      expect(core.doubles).toContain("brain");
      expect(rendered.doubles).toEqual(
        core.doubles.filter((entry) => entry !== "brain"),
      );
      expect(rendered.requirements.map(({ assertions }) => assertions)).toEqual(
        core.requirements.map(({ assertions }) => assertions),
      );
    }
  });

  test("remain STRUCTURAL and improve only brain-blocked requirement grades", () => {
    const reports = new Map(
      REAL_BRAIN_MANIFESTS.map((manifest, index) => [
        REAL_BRAIN_SLOTS[index]!,
        {
          assertions: manifest.requirements
            .flatMap(({ assertions }) => assertions)
            .map((description) => ({ description, passed: true })),
          liveEvidence: [],
          status: "passed" as const,
        },
      ]),
    );
    const grades = gradeRealBrainHarness(reports);

    expect(grades.map(({ verdict }) => verdict)).toEqual(
      REAL_BRAIN_SLOTS.map(() => "STRUCTURAL"),
    );
    expect(
      Object.fromEntries(
        grades.map(({ counts, number }) => [
          number,
          {
            covered: counts.covered,
            partial: counts.partial,
            uncovered: counts.uncovered,
          },
        ]),
      ),
    ).toEqual({
      "1-real-brain": { covered: 3, partial: 4, uncovered: 0 },
      "2-real-brain": { covered: 1, partial: 2, uncovered: 1 },
      "3-real-brain": { covered: 1, partial: 3, uncovered: 0 },
      "6-real-brain": { covered: 1, partial: 2, uncovered: 0 },
      "7-real-brain": { covered: 1, partial: 3, uncovered: 0 },
      "8-real-brain": { covered: 2, partial: 1, uncovered: 0 },
      "9-real-brain": { covered: 0, partial: 2, uncovered: 1 },
      "10-real-brain": { covered: 2, partial: 0, uncovered: 0 },
    });
  });
});

const HARNESS_BUDGET_MS = loadScaledMs(900_000, 2_700_000);

test.skipIf(gate.status !== "run")(
  liveHalfTitle(
    "SPEC §13 eight-slot real watcher-brain harness (still STRUCTURAL)",
    gate,
  ),
  async () => {
    const reportDirectory = await mkdtemp(join(tmpdir(), "argus-real-brains-"));
    try {
      const run = await runRealBrainHarness({ checkout, reportDirectory });
      const reports = new Map<RealBrainSlot, (typeof run.reports)[number]>();
      run.reports.forEach((report, index) => {
        reports.set(REAL_BRAIN_SLOTS[index]!, report);
      });
      const grades = gradeRealBrainHarness(reports);

      console.log(
        [
          "",
          `real watcher-brain calls: ${run.totalCalls}`,
          ...REAL_BRAIN_SLOTS.map(
            (slot) => `  ${slot}-real-brain: ${run.callsBySlot[slot]}`,
          ),
        ].join("\n"),
      );
      console.log(renderVerdictTable(grades));

      for (const [index, report] of run.reports.entries()) {
        const slot = REAL_BRAIN_SLOTS[index]!;
        expect({
          slot,
          error: report.error,
          failed: report.assertions
            .filter(({ passed }) => !passed)
            .map(({ description }) => description),
          status: report.status,
          teardown: report.teardown,
        }).toEqual({
          slot,
          error: null,
          failed: [],
          status: "passed",
          teardown: "completed",
        });
        expect(report.liveEvidence).toEqual([]);
        expect(report.verdict).toBe("STRUCTURAL");
      }
      expect(run.callsBySlot).toEqual(expectedCalls);
      expect(run.totalCalls).toBe(14);
      expect(grades.every(({ verdict }) => verdict === "STRUCTURAL")).toBe(true);
      expect(grades.every(({ counts }) => counts.missing === 0)).toBe(true);
    } finally {
      await rm(reportDirectory, { force: true, recursive: true });
    }
  },
  HARNESS_BUDGET_MS,
);
