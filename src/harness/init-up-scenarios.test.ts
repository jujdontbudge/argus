import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  gradeInitUpScenarios,
  INIT_UP_MANIFESTS,
  INIT_UP_SCENARIOS,
  type InitUpScenarioId,
} from "./all-scenarios.ts";
import { runScenario, type ScenarioReport } from "./index.ts";
import { renderVerdictTable } from "./verdicts.ts";

const checkout = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

const normalize = (value: string): string => value.replace(/\s+/g, " ").trim();

describe("the additive SPEC §13 init/up surface", () => {
  test("derives every requirement from setup-relevant SPEC text", async () => {
    const spec = normalize(await Bun.file(join(checkout, "SPEC.md")).text());
    const requirements = Object.values(INIT_UP_MANIFESTS).flatMap(
      ({ requirements }) => requirements,
    );
    const ids = requirements.map(({ id }) => id);

    expect(ids.length).toBe(new Set(ids).size);
    for (const requirement of requirements) {
      expect({
        id: requirement.id,
        quoted: spec.includes(normalize(requirement.spec)),
      }).toEqual({ id: requirement.id, quoted: true });
      if (requirement.assertions.length === 0) {
        expect({ id: requirement.id, explained: requirement.shortfall !== "" })
          .toEqual({ id: requirement.id, explained: true });
      }
    }
  });

  test(
    "init, first up, second up, edited memory and tracker-less up report STRUCTURAL verdicts",
    async () => {
      const reportDirectory = await mkdtemp(join(tmpdir(), "argus-init-up-suite-"));
      const reports = new Map<InitUpScenarioId, ScenarioReport>();

      try {
        // Sequential on purpose: each scenario runs production setup commands,
        // and serial scratch-machine convergence makes process ownership and
        // cleanup legible even though the sandboxes are disjoint.
        for (const definition of INIT_UP_SCENARIOS) {
          const report = await runScenario({
            checkout,
            name: `${definition.id}. ${definition.title}`,
            reportDirectory,
            scenario: definition.scenario,
          });
          reports.set(definition.id, report);

          expect({
            id: definition.id,
            error: report.error,
            failed: report.assertions
              .filter(({ passed }) => !passed)
              .map(({ description }) => description),
            liveEvidence: report.liveEvidence,
            status: report.status,
            teardown: report.teardown,
            verdict: report.verdict,
          }).toEqual({
            id: definition.id,
            error: null,
            failed: [],
            liveEvidence: [],
            status: "passed",
            teardown: "completed",
            verdict: "STRUCTURAL",
          });
        }

        const grades = gradeInitUpScenarios(reports);
        console.log(renderVerdictTable(grades));

        expect(grades.map(({ number, verdict }) => ({ number, verdict }))).toEqual(
          INIT_UP_SCENARIOS.map(({ id }) => ({
            number: id,
            verdict: "STRUCTURAL" as const,
          })),
        );
        expect(
          grades.flatMap(({ number, requirements }) =>
            requirements
              .filter(({ coverage }) => coverage === "missing")
              .map(({ absent, id }) => ({ absent, id, number })),
          ),
        ).toEqual([]);
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
          U0: { covered: 2, partial: 2, uncovered: 1 },
          U1: { covered: 2, partial: 4, uncovered: 1 },
          U2: { covered: 1, partial: 1, uncovered: 0 },
          U3: { covered: 1, partial: 2, uncovered: 0 },
          U4: { covered: 1, partial: 2, uncovered: 0 },
        });

        const rendered = renderVerdictTable(grades);
        for (const { id, title } of INIT_UP_SCENARIOS) {
          expect(rendered).toContain(`${id}. STRUCTURAL`);
          expect(rendered).toContain(title);
        }
        expect(rendered).toContain(
          "5 of 5 scenarios are STRUCTURAL; 0 of 5 are LIVE.",
        );
      } finally {
        await rm(reportDirectory, { force: true, recursive: true });
      }
    },
    300_000,
  );
});
