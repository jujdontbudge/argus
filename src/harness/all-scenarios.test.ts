import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFullScenarioRegistry,
  registerAllScenarios,
} from "./all-scenarios.ts";
import {
  createScenarioRegistry,
  runScenarios,
  type CoreScenarioNumber,
  type ScenarioReport,
} from "./index.ts";
import { gradeAll, renderVerdictTable } from "./verdicts.ts";
import { registerArchiverScenarios } from "../eyes/archiver/scenarios.ts";
import { registerDigestScenarios } from "../eyes/digest/scenarios.ts";
import { registerHermesScenarios } from "../tailing/hermes-scenarios.ts";

const checkout = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

/**
 * One assertion per contributing ticket per slot. These are the strings that
 * disappear when a registrar overwrites a half instead of chaining onto it,
 * so they are the actual regression guard — "all ten slots implemented" is
 * not, because a lossy composition still fills all ten.
 */
const CONTRIBUTED: Record<number, string[]> = {
  1: [
    "USER.md stayed byte-identical", // #30 reviewer
    "the session's digest was written with narrative", // #31 digest
    "every autonomous-batch message reached the archive", // #26 archiver
    "Hermes-side messages reached the normalized stream", // #23 hermes
    "Codex autonomous-session messages fed the normalized stream", // #22 codex
    "the autonomous batch closed its ticket on the tracker", // #57 completion
  ],
  2: [
    "Johan is the observable Honcho peer", // #28 bindings
    "Johan's mid-session directive classifies Johan-authored via takeover", // #25
    "USER.md learned from the takeover directive", // #30 reviewer
    "the digest frontmatter carries johan_touched: true", // #31 digest
    "the takeover directive was logged as a Johan-peer observation", // #32 honcho
    "exactly one scope-drift retro was filed for the hijacked ticket session", // #38
    "the in-scope refactor in ticket #9's session filed NOTHING", // #38
  ],
  3: [
    "exactly one retro was filed for the rogue work", // #33 retro
    "rogue Codex session attributed to the sandbox repo", // #22 codex
  ],
  4: [
    "every registry-logged send classifies Hermes-authored", // #25
    "Hermes-authored assistant output never classifies Johan", // #23 hermes
  ],
  5: [
    "the documented failure mode: an unlogged send reads as a Johan takeover", // #25
  ],
  6: [
    "reviewer restarted after death", // #29 supervisor
    "kill-before-commit backfill has the exact message count with no duplicates", // #26
    "a removed repo made its real watcher exit cleanly", // #39 watch command
  ],
  7: [
    "the finished session surfaced status=done in INDEX.md", // #31 digest
    "hooks promptly wrote finish and block event files", // #34 events
  ],
  8: [
    "the novel procedure was written as a SKILL.md under .argus/skills", // #30
    "the planted stale skill is gone from the live skills tree", // #35 curator
  ],
  9: [
    "repos bind separate Honcho workspaces", // #28 bindings
    "Johan's representation contains only Johan-authored messages", // #32 honcho
  ],
  10: [
    "peer .argus state stayed byte-identical", // #27 up
  ],
};

/**
 * #63 — the audit's central finding, as a number that cannot drift.
 *
 * Of 40 SPEC-derived requirements across the ten slots, 4 are COVERED with no
 * known shortfall, 34 are PARTIAL and 2 are UNCOVERED. All four gaps the audit
 * named are in here — scenario 1's closure (13.1.tickets-closed), scenario 7's
 * native hook (13.7.native-hook), scenario 9's representation
 * (13.9.representation-johan-only) and scenario 10's dormant peer
 * (13.10.no-other-instance-noticed) — and none of them is a failing test.
 * Downgrading a claim is what success looks like for this ticket, so `covered`
 * going DOWN is not a failure. Changing silently is.
 */
const PINNED_COVERAGE: Record<number, {
  covered: number;
  partial: number;
  uncovered: number;
}> = {
  1: { covered: 0, partial: 7, uncovered: 0 },
  2: { covered: 0, partial: 3, uncovered: 1 },
  3: { covered: 0, partial: 4, uncovered: 0 },
  4: { covered: 0, partial: 3, uncovered: 0 },
  5: { covered: 1, partial: 2, uncovered: 0 },
  6: { covered: 1, partial: 2, uncovered: 0 },
  7: { covered: 1, partial: 3, uncovered: 0 },
  8: { covered: 0, partial: 3, uncovered: 0 },
  9: { covered: 0, partial: 2, uncovered: 1 },
  10: { covered: 1, partial: 1, uncovered: 0 },
};

describe("the full SPEC §13 suite", () => {
  test("registers all ten scenario slots", () => {
    const slots = createFullScenarioRegistry().list();

    expect(slots).toHaveLength(10);
    expect(slots.filter(({ status }) => status === "unimplemented")).toEqual([]);
  });

  test("a lossy registration order silently drops halves", async () => {
    // The build map merged #23 (hermes) and #26 (archiver) before #31
    // (digest). Both EXTEND slot 1; digest OVERWRITES it. Register in that
    // order and the two earlier halves are gone, with every slot still
    // reporting "implemented".
    const lossy = createScenarioRegistry();
    registerHermesScenarios(lossy);
    registerArchiverScenarios(lossy);
    registerDigestScenarios(lossy);

    expect(
      lossy.list().find(({ number }) => number === 1)?.status,
    ).toBe("implemented");

    const reports = await runScenarios({
      checkout,
      reportDirectory: await mkdtemp(join(tmpdir(), "argus-lossy-")),
      scenarios: [{ name: "1 (lossy order)", scenario: lossy.get(1)! }],
    });
    const descriptions = reports[0]!.assertions.map(
      ({ description }) => description,
    );
    await rm(reports[0]!.reportPath, { force: true });

    expect(reports[0]!.status).toBe("passed");
    expect(descriptions).not.toContain(
      "Hermes-side messages reached the normalized stream",
    );
    expect(descriptions).not.toContain(
      "every autonomous-batch message reached the archive",
    );
  }, 120_000);

  test(
    "all ten scenarios run STRUCTURAL, with every ticket's half asserted and every SPEC §13 gap named",
    async () => {
      const registry = createScenarioRegistry();
      registerAllScenarios(registry);
      const reportDirectory = await mkdtemp(join(tmpdir(), "argus-suite-"));

      try {
        const reports = await runScenarios({
          checkout,
          reportDirectory,
          scenarios: registry
            .list()
            .map(({ number, title }) => ({
              name: `${number}. ${title}`,
              scenario: registry.get(number)!,
            })),
        });

        const byslot = new Map<CoreScenarioNumber, ScenarioReport>();
        for (const report of reports) {
          const slot = Number.parseInt(report.name, 10) as CoreScenarioNumber;
          byslot.set(slot, report);
          const failed = report.assertions.filter(({ passed }) => !passed);
          expect({
            slot,
            error: report.error,
            failed: failed.map(({ description }) => description),
            status: report.status,
          }).toEqual({ slot, error: null, failed: [], status: "passed" });
          expect(report.up.exitCode).toBe(0);
          expect(report.teardown).toBe("completed");

          const descriptions = report.assertions.map(
            ({ description }) => description,
          );
          for (const contributed of CONTRIBUTED[slot] ?? []) {
            expect({ slot, contributed, present: descriptions.includes(contributed) })
              .toEqual({ slot, contributed, present: true });
          }
        }

        // #63 — the surface this ticket exists to build. Printed on every
        // suite run, because "ten green" was never the honest summary and a
        // verdict nobody sees is the same overclaim in a nicer data structure.
        const grades = gradeAll(byslot);
        console.log(renderVerdictTable(grades));

        // NOT RUN is what a bare pass hid. Every slot drives fixture brains,
        // a fake `gh`, an in-memory Honcho, a stub `cmux` and hand-authored
        // hook payloads, so every slot is STRUCTURAL — and the only way that
        // changes is a slot recording evidence from an agent it spawned.
        expect(grades.map(({ number, verdict }) => ({ number, verdict }))).toEqual(
          ([1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as CoreScenarioNumber[]).map(
            (number) => ({ number, verdict: "STRUCTURAL" as const }),
          ),
        );

        // A manifest requirement whose assertion vanished. This is the one
        // grade that IS a regression: the suite lost a half, or a manifest
        // names an assertion the slot never produced.
        expect(
          grades.flatMap(({ number, requirements }) =>
            requirements
              .filter(({ coverage }) => coverage === "missing")
              .map(({ absent, id }) => ({ absent, id, number })),
          ),
        ).toEqual([]);

        // THE HONEST NUMBERS, pinned. Not a target — a statement of where the
        // suite is. `partial` and `uncovered` are findings, not failures, so
        // the assertion is EQUALITY: a gap cannot appear silently, and closing
        // one requires deleting its shortfall in `verdicts.ts` and editing
        // this literal, which is the only way these numbers may improve.
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
        ).toEqual(PINNED_COVERAGE);
      } finally {
        await rm(reportDirectory, { force: true, recursive: true });
      }
    },
    300_000,
  );
});
