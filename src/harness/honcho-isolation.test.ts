import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadScaledMs } from "../eyes/test-budget.ts";
import {
  LIVE_HONCHO_GATE,
  liveGateEnabled,
  resolveHonchoGate,
} from "../eyes/live-gate.ts";
import { probeLiveHoncho } from "../eyes/honcho/live-probe.ts";
import {
  describeHonchoIsolationGate,
  gradeHonchoIsolation,
  HONCHO_ISOLATION_MANIFESTS,
  liveHonchoIsolationScenario,
} from "./honcho-isolation.ts";
import { runScenario } from "./index.ts";
import { liveHalfTitle } from "./live-gate.ts";
import { renderVerdictTable } from "./verdicts.ts";

/**
 * Ticket #76 — SPEC §13.9 against a real local Honcho, and the gate that
 * keeps it off the default path.
 *
 * Everything above the live test runs on every `bun test`: the manifest's
 * shape, that its gaps explain themselves, and — the one that matters — that
 * the slot FAILS rather than passing quietly when no instance is reachable.
 * That is the property the ticket turns on: slot 9 must never silently fall
 * back to `FixtureHoncho` while still claiming coverage.
 *
 * What is NOT tested on the default path is the drive itself, because the
 * scenario takes no client seam. A fixture client parameter would make the
 * wiring testable here and would also let a fixture run grade itself as the
 * live rendering, which is the overclaim #63 and #74 exist to delete. The
 * banner prints on every run instead, gate open or shut.
 */
const checkout = fileURLToPath(new URL("../../", import.meta.url));

const probe = liveGateEnabled(LIVE_HONCHO_GATE, Bun.env)
  ? await probeLiveHoncho()
  : { live: null, reason: null };
const gate = resolveHonchoGate(Bun.env, probe.reason);

// `bun test` prints no name for a skipped test, so this line is the whole of
// a skip's visibility on the default path.
console.log(describeHonchoIsolationGate(gate));

const SANDBOX_BUDGET_MS = loadScaledMs(120_000, 360_000);
/** Two sandboxes, two `argus up` runs, and a live round trip per repo. */
const LIVE_BUDGET_MS = loadScaledMs(240_000, 600_000);

const manifest = HONCHO_ISOLATION_MANIFESTS[0]!;

describe("the §13.9 live Honcho manifest", () => {
  test("renders slot 9 additively, and never re-grades the fixture slot", () => {
    expect(HONCHO_ISOLATION_MANIFESTS.map(({ number }) => number)).toEqual([
      "9-live",
    ]);
    // `honcho` is the double this rendering removes. `agent` and `brain` stay,
    // because no agent is spawned — so the slot stays STRUCTURAL and says so.
    expect(manifest.doubles).toEqual(["agent", "brain"]);
  });

  test("every requirement quotes SPEC §13.9 and every gap explains itself", () => {
    for (const requirement of manifest.requirements) {
      expect(requirement.id.startsWith("13.9.")).toBe(true);
      expect(requirement.spec.length).toBeGreaterThan(0);
      if (requirement.assertions.length === 0) {
        expect(requirement.shortfall).not.toBe("");
      }
    }
  });

  test("cannot reach LIVE, whatever a report carries", () => {
    // The honest ceiling, pinned. #63's LIVE means an agent this scenario
    // spawned; this one spawns none. A future edit that empties the doubles
    // to buy the better word has to delete this test first.
    const passing = manifest.requirements.flatMap(({ assertions }) =>
      assertions.map((description) => ({ description, passed: true })),
    );
    for (const liveEvidence of [[], ["a real claude session ran"]]) {
      const [grade] = gradeHonchoIsolation({
        assertions: passing,
        liveEvidence,
        status: "passed",
      });
      expect(grade!.verdict).toBe("STRUCTURAL");
    }
  });

  test("grades the workspace query COVERED and derivation PARTIAL", () => {
    const passing = manifest.requirements.flatMap(({ assertions }) =>
      assertions.map((description) => ({ description, passed: true })),
    );
    const [grade] = gradeHonchoIsolation({
      assertions: passing,
      liveEvidence: [],
      status: "passed",
    });
    expect(
      Object.fromEntries(
        grade!.requirements.map(({ coverage, id }) => [id, coverage]),
      ),
    ).toEqual({
      "13.9.query-workspace": "covered",
      "13.9.representation-johan-only": "partial",
      "13.9.repo-isolation": "partial",
      "13.9.johan-representation-live-agent": "uncovered",
    });
  });
});

test(
  "with no reachable instance the slot FAILS rather than falling back to the fixture",
  async () => {
    // The anti-silent-pass property, asserted directly. This is the whole
    // reason the scenario takes no client seam.
    const reportDirectory = await mkdtemp(join(tmpdir(), "argus-honcho-iso-"));

    try {
      const result = await runScenario({
        checkout,
        name: "9-live. live Honcho isolation with a shut gate",
        reportDirectory,
        scenario: liveHonchoIsolationScenario({
          apiKey: null,
          gate: { reason: `${LIVE_HONCHO_GATE} is unset`, status: "gate-unset" },
        }),
      });

      expect(result.status).toBe("failed");
      expect(result.error).toContain(
        "a real Honcho instance is reachable — this slot never falls back to a fixture",
      );
      expect(result.verdict).toBe("STRUCTURAL");
    } finally {
      await rm(reportDirectory, { force: true, recursive: true });
    }
  },
  SANDBOX_BUDGET_MS,
);

test.skipIf(gate.status !== "run")(
  liveHalfTitle(
    "§13.9 semantic isolation, queried out of a real local Honcho workspace",
    gate,
  ),
  async () => {
    const reportDirectory = await mkdtemp(join(tmpdir(), "argus-honcho-live-"));

    try {
      const result = await runScenario({
        checkout,
        name: "9-live. Semantic isolation (real Honcho)",
        reportDirectory,
        scenario: liveHonchoIsolationScenario({
          apiKey: probe.live!.apiKey,
          gate,
        }),
      });

      const grades = gradeHonchoIsolation(result);
      console.log(renderVerdictTable(grades));

      expect({
        error: result.error,
        failed: result.assertions
          .filter(({ passed }) => !passed)
          .map(({ description }) => description),
        status: result.status,
      }).toEqual({ error: null, failed: [], status: "passed" });
      expect(result.teardown).toBe("completed");

      // STRUCTURAL, on purpose: a real Honcho is not a live agent. What the
      // gate buys is the `honcho` double's removal, not the LIVE word.
      expect(grades.map(({ verdict }) => verdict)).toEqual(["STRUCTURAL"]);
      expect(grades[0]!.counts.missing).toBe(0);
      expect(grades[0]!.counts.covered).toBe(1);
    } finally {
      await rm(reportDirectory, { force: true, recursive: true });
    }
  },
  LIVE_BUDGET_MS,
);
