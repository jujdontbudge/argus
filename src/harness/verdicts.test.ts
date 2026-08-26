import { describe, expect, test } from "bun:test";

import type { ScenarioReport } from "./index.ts";
import {
  gradeScenario,
  renderVerdictTable,
  SPEC_MANIFESTS,
  verdictFor,
  type ScenarioManifest,
} from "./verdicts.ts";

/**
 * Ticket #63 — the grading machinery, tested where it can be tested purely.
 *
 * The interesting properties are all about what CANNOT be claimed:
 * a scenario cannot reach LIVE by declaration, a manifest cannot make a
 * missing assertion look covered, and a requirement SPEC §13 states with no
 * assertion behind it cannot be graded out of existence. Each of those is a
 * property of `gradeScenario` alone, so none of it needs a sandbox.
 *
 * The per-slot verdicts and the pinned honest numbers live in
 * `all-scenarios.test.ts`, because those need the suite's real reports.
 */
const report = (
  assertions: Array<[string, boolean]>,
  liveEvidence: string[] = [],
): Pick<ScenarioReport, "assertions" | "liveEvidence" | "status"> => ({
  assertions: assertions.map(([description, passed]) => ({ description, passed })),
  liveEvidence,
  status: assertions.every(([, passed]) => passed) ? "passed" : "failed",
});

const manifest = (
  requirements: ScenarioManifest["requirements"],
  doubles: ScenarioManifest["doubles"] = ["brain"],
): ScenarioManifest => ({
  doubles,
  number: 1,
  requirements,
  title: "test manifest",
});

describe("the SPEC §13 verdict", () => {
  test("is STRUCTURAL without live evidence, whatever the manifest declares", () => {
    expect(verdictFor([], [])).toBe("STRUCTURAL");
    expect(verdictFor(["brain"], ["a real claude session ran"])).toBe("STRUCTURAL");
    expect(verdictFor([], ["a real claude session ran"])).toBe("LIVE");
  });

  test("cannot be talked up by emptying a manifest's doubles list", () => {
    // The whole point: LIVE needs `recordLiveEvidence`, which is reachable
    // only from a scenario that actually spawned an agent. Deleting the
    // doubles from a fixture slot's manifest buys nothing.
    const graded = gradeScenario(
      manifest([{ assertions: ["x"], id: "13.1.x", shortfall: "", spec: "x" }], []),
      report([["x", true]]),
    );
    expect(graded.verdict).toBe("STRUCTURAL");
    expect(graded.requirements[0]!.coverage).toBe("covered");
  });
});

describe("requirement coverage", () => {
  test("a requirement with no assertions is UNCOVERED, never absent", () => {
    const graded = gradeScenario(
      manifest([{ assertions: [], id: "13.1.gap", shortfall: "why", spec: "s" }]),
      report([["something else entirely", true]]),
    );
    expect(graded.requirements.map(({ coverage }) => coverage)).toEqual(["uncovered"]);
    expect(graded.counts.uncovered).toBe(1);
  });

  test("a covered requirement with a shortfall is PARTIAL, not covered", () => {
    const graded = gradeScenario(
      manifest([
        { assertions: ["a"], id: "13.1.p", shortfall: "against a double", spec: "s" },
      ]),
      report([["a", true]]),
    );
    expect(graded.requirements[0]!.coverage).toBe("partial");
  });

  test("a manifest assertion the suite lost or failed is MISSING", () => {
    const lost = gradeScenario(
      manifest([{ assertions: ["a", "b"], id: "13.1.m", shortfall: "", spec: "s" }]),
      report([["a", true]]),
    );
    expect(lost.requirements[0]).toMatchObject({
      absent: ["b"],
      coverage: "missing",
    });

    const failed = gradeScenario(
      manifest([{ assertions: ["a"], id: "13.1.m", shortfall: "", spec: "s" }]),
      report([["a", false]]),
    );
    expect(failed.requirements[0]!.coverage).toBe("missing");
  });

  test("a fully covered requirement grades LIVE only when the run was live", () => {
    const requirements = [
      { assertions: ["a"], id: "13.1.l", shortfall: "", spec: "s" },
    ];
    expect(
      gradeScenario(manifest(requirements, []), report([["a", true]], ["ran"]))
        .requirements[0]!.coverage,
    ).toBe("live");
    expect(
      gradeScenario(manifest(requirements, []), report([["a", true]]))
        .requirements[0]!.coverage,
    ).toBe("covered");
  });
});

describe("the ten SPEC §13 manifests", () => {
  const all = Object.values(SPEC_MANIFESTS);

  test("cover every slot exactly once, with unique requirement ids", () => {
    expect(all.map(({ number }) => number).sort((l, r) => l - r)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
    const ids = all.flatMap(({ requirements }) => requirements.map(({ id }) => id));
    expect(ids.length).toBe(new Set(ids).size);
  });

  test("quote SPEC §13 for every requirement", () => {
    for (const { number, requirements } of all) {
      for (const requirement of requirements) {
        expect({ id: requirement.id, spec: requirement.spec.length > 0 }).toEqual({
          id: requirement.id,
          spec: true,
        });
        expect(requirement.id.startsWith(`13.${number}.`)).toBe(true);
      }
    }
  });

  test("explain every gap: an uncovered requirement always says why", () => {
    // A gap with no explanation is a gap that reads as an oversight rather
    // than as a finding, which is the failure mode this ticket exists to fix.
    for (const { requirements } of all) {
      for (const requirement of requirements) {
        if (requirement.assertions.length > 0) continue;
        expect({ id: requirement.id, explained: requirement.shortfall !== "" })
          .toEqual({ id: requirement.id, explained: true });
      }
    }
  });

  test("declare at least one double each — no slot claims to be live", () => {
    // Derived from the audit's finding, and it must stay true until a slot
    // genuinely stops substituting something. If this ever fails, the slot's
    // manifest was emptied without the slot changing.
    for (const { doubles, number } of all) {
      expect({ number, doubles: doubles.length > 0 }).toEqual({
        number,
        doubles: true,
      });
    }
  });
});

test("the rendered table names the verdict, the counts and every gap", () => {
  const rendered = renderVerdictTable([
    gradeScenario(
      manifest(
        [
          { assertions: ["a"], id: "13.1.ok", shortfall: "", spec: "quoted" },
          { assertions: [], id: "13.1.gap", shortfall: "nothing asserts it", spec: "q" },
        ],
        ["brain", "tracker"],
      ),
      report([["a", true]]),
    ),
  ]);

  expect(rendered).toContain("STRUCTURAL");
  expect(rendered).toContain("1 covered, 0 partial, 1 uncovered");
  expect(rendered).toContain("doubles: brain, tracker");
  expect(rendered).toContain("UNCOVERED 13.1.gap");
  expect(rendered).toContain("nothing asserts it");
  expect(rendered).toContain("1 of 1 scenarios are STRUCTURAL; 0 of 1 are LIVE.");
});

/**
 * Ticket #78 — retiring a double, and the rules that keep it honest.
 *
 * The same property #63 built for LIVE, one level down: a double comes off a
 * slot only when the report carries evidence an agent actually ran, so the
 * default fixture run of every slot keeps every double it has always had and
 * no edit to a manifest can change that.
 */
describe("a live drive retiring a slot's double", () => {
  const drivable = (): ScenarioManifest => ({
    doubles: ["agent", "cmux", "hermes"],
    number: 4,
    requirements: [
      {
        assertions: ["a"],
        id: "13.4.fixture-only",
        liveShortfall: "",
        shortfall: "asserted on a fixture transcript",
        spec: "quoted",
      },
      {
        assertions: ["b"],
        id: "13.4.unchanged",
        shortfall: "still true either way",
        spec: "quoted",
      },
    ],
    retiredByLiveDrive: ["agent"],
    title: "drivable",
  });
  const bothPass: Array<[string, boolean]> = [
    ["a", true],
    ["b", true],
  ];

  test("with no evidence the manifest's claim changes nothing at all", () => {
    const grade = gradeScenario(drivable(), report(bothPass));

    expect(grade.doubles).toEqual(["agent", "cmux", "hermes"]);
    expect(grade.verdict).toBe("STRUCTURAL");
    // The live shortfall is not read either: both requirements stay PARTIAL.
    expect(grade.counts).toMatchObject({ covered: 0, live: 0, partial: 2 });
    expect(grade.requirements[0]!.shortfall).toBe("asserted on a fixture transcript");
  });

  test("with evidence the named double comes off — and only the named one", () => {
    const grade = gradeScenario(drivable(), report(bothPass, ["codex: exit 0"]));

    expect(grade.doubles).toEqual(["cmux", "hermes"]);
    // Retiring `agent` does NOT buy LIVE. Two doubles remain, so the verdict
    // is unchanged, which is the whole reason this is a separate axis from
    // `verdictFor` rather than a second way of spelling it.
    expect(grade.verdict).toBe("STRUCTURAL");
    expect(grade.counts).toMatchObject({ covered: 1, partial: 1 });
    expect(grade.requirements[1]!.shortfall).toBe("still true either way");
  });

  test("a slot that declares no retirement is untouched by evidence", () => {
    const plain = manifest(
      [{ assertions: ["a"], id: "13.1.x", shortfall: "s", spec: "q" }],
      ["agent", "brain"],
    );

    expect(gradeScenario(plain, report([["a", true]], ["x"])).doubles).toEqual([
      "agent",
      "brain",
    ]);
  });

  test("retiring every double DOES reach LIVE, on evidence alone", () => {
    // The rule is one rule, not two: `verdictFor` reads the doubles that
    // survived, so a slot whose last double a live drive retires is LIVE for
    // the same reason #74's journeys are — evidence, never declaration.
    const all: ScenarioManifest = {
      ...drivable(),
      doubles: ["agent"],
      retiredByLiveDrive: ["agent"],
    };

    expect(gradeScenario(all, report(bothPass)).verdict).toBe("STRUCTURAL");
    expect(gradeScenario(all, report(bothPass, ["codex: exit 0"])).verdict).toBe(
      "LIVE",
    );
  });
});
