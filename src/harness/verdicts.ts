/**
 * Ticket #63 — the honest verdict surface for the SPEC §13 suite.
 *
 * AUDIT.md §4 item 10 is the audit's central finding, and it is not "the tests
 * fail". They pass. The finding is that **"all ten §13 scenarios pass"
 * overstates what passing proves**, and a green suite that overstates itself
 * is the most expensive kind of test: it removes the pressure to build the
 * thing it claims to cover.
 *
 * Three things are wrong with a bare pass, and this module fixes each:
 *
 *  1. **No slot has ever run a live agent.** `SimulationDriverRunner` is never
 *     started by any scenario (`src/harness/index.ts`), every eye brain is a
 *     fixture, `gh` is `createFakeGh`, Honcho is an in-memory array, `cmux` is
 *     a stub and the hooks are called in-process with hand-authored payloads.
 *     So every slot's verdict is **STRUCTURAL**, and it now says so. A
 *     **LIVE** verdict is unreachable by declaration: it requires a report to
 *     carry recorded live evidence, which only an actual agent spawn produces.
 *
 *  2. **The assertion list was the specification.** Whatever a slot happened
 *     to assert *was* the definition of that slot passing, so a requirement
 *     SPEC §13 states and no slot asserts was invisible. The manifests below
 *     are derived from the SPEC §13 TEXT — each requirement quotes the words
 *     it comes from — and a requirement with no covering assertion grades
 *     `uncovered` and is printed. The gap is surfaced rather than hidden.
 *
 *  3. **"Covered" hid its own shortfalls.** #57's closure half and #58's hook
 *     half both graded themselves PARTIAL in prose, in a docblock nothing
 *     reads. `shortfall` makes that machine-readable: a covered requirement
 *     with a shortfall grades `partial` and prints what it still fails to
 *     prove.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO. It does not fail the suite for
 * an `uncovered` or `partial` requirement. Those are honest statements of the
 * gap, not regressions, and failing on them would create exactly the pressure
 * that produced the overclaim: the cheapest way to green a suite that fails on
 * its own honesty is to delete the honesty. What it DOES fail on is `missing`
 * — a requirement the manifest says is covered whose assertion is gone or red
 * — and on the pinned counts drifting, so neither a lost half nor a quiet
 * re-grade can pass unnoticed.
 */
import type {
  CoreScenarioNumber,
  ScenarioReport,
  ScenarioVerdict,
} from "./index.ts";

export type { ScenarioVerdict } from "./index.ts";

/**
 * A component this scenario substituted for the real thing.
 *
 * The list is the evidence for the STRUCTURAL verdict, in the scenario's own
 * words, so a reader is never asked to take "STRUCTURAL" on trust.
 */
export type Double =
  | "agent"
  | "brain"
  | "cmux"
  | "hermes"
  | "honcho"
  | "hooks"
  | "peer-instance"
  | "tracker";

export const DOUBLE_MEANING: Readonly<Record<Double, string>> = {
  agent: "no live Claude or Codex session ran; transcripts are synthesized",
  brain: "every eye brain is a fixture, not a `claude`/`codex` CLI",
  cmux: "`cmux` is a stub; no send reached a real workspace",
  hermes: "no Hermes process ran; sends are appended rows",
  honcho: "Honcho is `FixtureHoncho`, an in-memory array",
  hooks: "hook handlers are called in-process with hand-authored payloads",
  "peer-instance": "the peer repo's eyes never start; its instance is dormant",
  tracker: "`gh` is `createFakeGh`; no tracker was written",
};

/** One requirement, quoted out of the SPEC §13 text rather than the code. */
export interface SpecRequirement {
  /**
   * The suite assertions that cover it, by exact description.
   *
   * EMPTY MEANS UNCOVERED, and that is the point: the manifest is written
   * from the SPEC, so a requirement no slot asserts still appears here, with
   * nothing to point at. That is how the gap becomes visible instead of
   * being defined out of existence by the assertion list.
   */
  assertions: readonly string[];
  /** Stable id, `13.<slot>.<slug>`. */
  id: string;
  /**
   * What the covering assertions still fail to prove. `""` when nothing does
   * — which, across all ten slots, is true of exactly four requirements.
   */
  shortfall: string;
  /** The SPEC §13 words this requirement comes from. Verbatim. */
  spec: string;
}

export interface ScenarioManifest {
  doubles: readonly Double[];
  number: CoreScenarioNumber;
  requirements: readonly SpecRequirement[];
  title: string;
}

export type RequirementCoverage =
  /** Asserted, and nothing is known to be missing from what it proves. */
  | "covered"
  /** Asserted against a live agent's own output. */
  | "live"
  /** The manifest says it is covered and the assertion is gone or red. */
  | "missing"
  /** Asserted, but the assertions do not reach what SPEC §13 describes. */
  | "partial"
  /** SPEC §13 says it; no assertion in the suite covers it. */
  | "uncovered";

export interface RequirementGrade extends SpecRequirement {
  coverage: RequirementCoverage;
  /** Assertions the manifest named that the report did not pass. */
  absent: readonly string[];
}

export interface ScenarioGrade {
  counts: Readonly<Record<RequirementCoverage, number>>;
  doubles: readonly Double[];
  liveEvidence: readonly string[];
  number: CoreScenarioNumber;
  requirements: readonly RequirementGrade[];
  status: ScenarioReport["status"];
  title: string;
  verdict: ScenarioVerdict;
}

/**
 * The verdict rule, in one place and derived from evidence only.
 *
 * A scenario is LIVE only when it recorded live evidence AND declares no
 * doubles. `recordLiveEvidence` is reachable only from a scenario that
 * actually spawned an agent, so LIVE cannot be reached by editing a manifest
 * — which is the property that makes the STRUCTURAL verdicts below worth
 * printing.
 */
export function verdictFor(
  doubles: readonly Double[],
  liveEvidence: readonly string[],
): ScenarioVerdict {
  return doubles.length === 0 && liveEvidence.length > 0 ? "LIVE" : "STRUCTURAL";
}

export function gradeScenario(
  manifest: ScenarioManifest,
  report: Pick<ScenarioReport, "assertions" | "liveEvidence" | "status">,
): ScenarioGrade {
  const passed = new Set(
    report.assertions
      .filter(({ passed: ok }) => ok)
      .map(({ description }) => description),
  );
  const verdict = verdictFor(manifest.doubles, report.liveEvidence);
  const requirements = manifest.requirements.map((requirement): RequirementGrade => {
    const absent = requirement.assertions.filter((name) => !passed.has(name));
    if (requirement.assertions.length === 0) {
      return { ...requirement, absent, coverage: "uncovered" };
    }
    if (absent.length > 0) return { ...requirement, absent, coverage: "missing" };
    if (requirement.shortfall !== "") {
      return { ...requirement, absent, coverage: "partial" };
    }
    return {
      ...requirement,
      absent,
      coverage: verdict === "LIVE" ? "live" : "covered",
    };
  });

  const counts: Record<RequirementCoverage, number> = {
    covered: 0,
    live: 0,
    missing: 0,
    partial: 0,
    uncovered: 0,
  };
  for (const { coverage } of requirements) counts[coverage] += 1;

  return {
    counts,
    doubles: manifest.doubles,
    liveEvidence: report.liveEvidence,
    number: manifest.number,
    requirements,
    status: report.status,
    title: manifest.title,
    verdict,
  };
}

/**
 * The ten manifests, derived from SPEC §13's scenario list.
 *
 * Every `spec` field is a quote. Every `shortfall` is a statement about what
 * the slot's own code does, checkable against the module named in it. Nothing
 * here is aspirational: when a shortfall is closed, its text is deleted and
 * the pinned counts in `verdicts.test.ts` move, which is the only way the
 * numbers in this suite are allowed to improve.
 */
export const SPEC_MANIFESTS: Readonly<
  Record<CoreScenarioNumber, ScenarioManifest>
> = {
  1: {
    doubles: ["agent", "brain", "tracker"],
    number: 1,
    title: "Autonomous batch, zero human input",
    requirements: [
      {
        assertions: [
          "the batch's ticket session was deployed",
          "the finished ticket passed its gates and merged, with no human input",
        ],
        id: "13.1.batch-end-to-end",
        shortfall:
          "the worker process is a stub and the gate commands are fixtures, so no live agent produced the work the batch merged",
        spec: "run a ticket batch end to end",
      },
      {
        assertions: [
          "the finished ticket passed its gates and merged, with no human input",
        ],
        id: "13.1.zero-human-input",
        shortfall:
          "nothing in the slot COULD have supplied human input — the absence is by construction, never observed under a driver able to interfere",
        spec: "zero human input",
      },
      {
        assertions: ["USER.md stayed byte-identical"],
        id: "13.1.user-md",
        shortfall:
          "a fixture-brain reviewer is what declined to write; no live brain has been shown to leave USER.md alone",
        spec: "`USER.md` byte-identical",
      },
      {
        assertions: [
          "MEMORY.md gained a project fact",
          "the fact file exists beside the index",
        ],
        id: "13.1.memory-md",
        shortfall: "the fact is fixture-brain output, not a live session's reasoning",
        spec: "`MEMORY.md` gained project facts",
      },
      {
        assertions: [
          "the session's digest was written with narrative",
          "INDEX.md gained the session's one line",
        ],
        id: "13.1.digests-index",
        shortfall: "the narrative is fixture-brain output",
        spec: "digests + INDEX updated",
      },
      {
        assertions: [
          "archive grew during the autonomous batch",
          "every autonomous-batch message reached the archive",
        ],
        id: "13.1.archive-grew",
        shortfall:
          "the archiver and its SQLite store are real; the messages it archived are synthesized transcript rows",
        spec: "archive grew",
      },
      {
        assertions: [
          "the autonomous batch closed its ticket on the tracker",
          "the wayfinder map indexed the closed ticket",
          "the merged ticket's worktree was retired",
        ],
        id: "13.1.tickets-closed",
        shortfall:
          "#57 graded this PARTIAL in its own words: `gh`, the review brain, the worker process and the gate commands are all doubles, so it proves the loop closes a ticket against a TRACKER DOUBLE — not that live agent work survives a live review",
        spec: "tickets closed",
      },
    ],
  },
  2: {
    doubles: ["agent", "brain", "cmux", "honcho"],
    number: 2,
    title: "Fake-Johan takeover",
    requirements: [
      {
        assertions: [],
        id: "13.2.driver-attaches",
        shortfall:
          "UNCOVERED: no `SimulationDriverRunner` starts and no `cmux send` is issued. The directives are rows the fixture provenance driver appends to a synthesized transcript, so 'attaches mid-ticket and types' is asserted of nothing that attached or typed",
        spec: "driver attaches mid-ticket and types directives",
      },
      {
        assertions: [
          "Johan's mid-session directive classifies Johan-authored via takeover",
          "the takeover record itself carries johan_touched",
          "johan_touched is set on the session after the takeover",
          "the digest frontmatter carries johan_touched: true",
          "INDEX.md surfaces johan_touched=true",
        ],
        id: "13.2.johan-touched",
        shortfall:
          "the takeover it flags is a fixture-driver row, so the flag is right about an event that never happened",
        spec: "`johan_touched: true`",
      },
      {
        assertions: ["USER.md learned from the takeover directive"],
        id: "13.2.user-md-learned",
        shortfall: "the reviewer that learned it ran on a fixture brain",
        spec: "USER.md learned",
      },
      {
        assertions: ["the takeover directive was logged as a Johan-peer observation"],
        id: "13.2.honcho-observation",
        shortfall:
          "logged into `FixtureHoncho`, an in-memory array — no Honcho workspace was written to and none was queried",
        spec: "Honcho logged a user-peer observation",
      },
    ],
  },
  3: {
    doubles: ["agent", "brain", "tracker"],
    number: 3,
    title: "Rogue session",
    requirements: [
      {
        assertions: [
          "provenance classified exactly Johan's rogue prompt as Johan-authored",
          "the registered ticket session's own work filed no retro",
        ],
        id: "13.3.rogue-session",
        shortfall:
          "no unregistered Claude or Codex session was ever started; the 'random' session is a fixture transcript the driver wrote, so its unregistered-ness is a property of the fixture, not an observation",
        spec: "random unregistered session implements something with no ticket",
      },
      {
        assertions: [
          "exactly one retro was filed for the rogue work",
          "the retro was filed CLOSED (no approval queue)",
          "it is closed as completed — the work already happened",
          "the retro reached the tracker",
        ],
        id: "13.3.retro-closed-subissue",
        shortfall: "filed through `createFakeGh`; no tracker was written",
        spec: "closed `retro` sub-issue filed",
      },
      {
        assertions: [
          "it is a sub-issue of the nearest plausible parent (#15)",
          "the link went through the GitHub sub_issues API",
        ],
        id: "13.3.correct-parent",
        shortfall:
          "the sub_issues API call is asserted against the fake's recorded calls, not against GitHub's behaviour",
        spec: "correct parent",
      },
      {
        assertions: [
          "the body reflects Johan's prompts",
          "the body reflects the diff and cites the commit",
          "the body names the session the work came from",
        ],
        id: "13.3.body-prompts-diff",
        shortfall:
          "the diff and commit are real git; the body around them was composed by a fixture retro brain",
        spec: "body reflects the prompts and diff",
      },
    ],
  },
  4: {
    doubles: ["agent", "cmux", "hermes"],
    number: 4,
    title: "The poisoning test",
    requirements: [
      {
        assertions: ["all four sent messages landed and were classified"],
        id: "13.4.hermes-sends",
        shortfall:
          "no Hermes process ran and no `cmux send` was issued — the nudges are rows appended to the registry and the transcript by the same fixture driver",
        spec: "Hermes sends registry-logged nudges into a session",
      },
      {
        assertions: [
          "every registry-logged send classifies Hermes-authored",
          "Hermes-authored assistant output never classifies Johan",
          "the agent CLI's own injected preamble classifies system, never Johan",
        ],
        id: "13.4.hermes-authored",
        shortfall:
          "asserted on fixture transcripts. The same invariant IS asserted on real Opus and Codex transcripts, but only in the separately gated live drives (`subscription-drive.test.ts`, `live-agents.test.ts`), never in this slot",
        spec: "classified Hermes-authored",
      },
      {
        assertions: [
          "no user-side message classified Johan — USER.md stays untouched",
          "the session is not marked johan_touched by Hermes' own nudges",
        ],
        id: "13.4.user-md-untouched",
        shortfall:
          "USER.md is not read back here; untouched-ness is INFERRED from nothing classifying Johan rather than observed on the file",
        spec: "USER.md untouched",
      },
    ],
  },
  5: {
    doubles: ["agent", "cmux", "hermes"],
    number: 5,
    title: "Fault injection: the unlogged send",
    requirements: [
      {
        assertions: ["the unlogged landing is not silently absorbed as Hermes"],
        id: "13.5.unlogged-send",
        shortfall:
          "the send is synthesized; no real unlogged `cmux send` was issued into a real session",
        spec: "deliberately send into a session without registry logging",
      },
      {
        assertions: [
          "the documented failure mode: an unlogged send reads as a Johan takeover",
        ],
        id: "13.5.documented",
        shortfall: "",
        spec: "Document ... the failure mode",
      },
      {
        assertions: [
          "the misattribution is VISIBLE — a johan-attached audit fires",
          "a logged send that never lands expires as a loud audit",
        ],
        id: "13.5.failure-visible",
        shortfall:
          "visible in an in-process audit sink the scenario supplies. AUDIT.md §4 item 8 records that under the production supervisor the same audit prints into /dev/null, so 'visible, not silent' is true of the harness and false of production",
        spec: "assert the failure mode is visible, not silent",
      },
    ],
  },
  6: {
    doubles: ["agent", "brain"],
    number: 6,
    title: "Watcher death",
    requirements: [
      {
        assertions: [
          "all five real eye commands started",
          "reviewer restarted after death",
          "archiver restarted after death",
          "honcho restarted after death",
          "digest restarted after death",
          "retro restarted after death",
          "supervisor stopped every real eye command",
        ],
        id: "13.6.kill-each-watcher",
        shortfall: "",
        spec: "kill each watcher ... the supervisor restarts it",
      },
      {
        assertions: [
          "two messages committed before watcher death",
          "the killed batch contained two uncommitted messages",
        ],
        id: "13.6.mid-run",
        shortfall:
          "the run they die in the middle of is a fixture transcript replay, not a live agent session still writing",
        spec: "kill each watcher mid-run",
      },
      {
        assertions: [
          "kill-before-commit backfill has the exact message count with no duplicates",
          "the replacement archiver observed a transcript written after restart",
        ],
        id: "13.6.backfill",
        shortfall:
          "the archiver, the kill and the restart are real processes; the transcript backfilled from is synthesized",
        spec: "the archiver backfills from the transcript with no message lost",
      },
    ],
  },
  7: {
    doubles: ["agent", "brain", "cmux", "hooks"],
    number: 7,
    title: "Signal paths",
    requirements: [
      {
        assertions: ["no push event files exist — hooks are disabled"],
        id: "13.7.hooks-disabled",
        shortfall: "",
        spec: "finish and block sessions with hooks disabled",
      },
      {
        assertions: [
          "the finished session surfaced status=done in INDEX.md",
          "the blocked session surfaced status=blocked in INDEX.md",
          "both digests carry the flipped status in frontmatter",
        ],
        id: "13.7.finish-and-block",
        shortfall:
          "the sessions are fixture transcripts; no agent finished and none blocked",
        spec: "finish and block sessions",
      },
      {
        assertions: [
          "the production slow poll delivered finish and block when no push arrived",
          "the slow poll cursor delivered each terminal status once",
          "the pending batch was due within the digest cadence (the poll interval bound)",
        ],
        id: "13.7.slow-poll-within-interval",
        shortfall:
          "the interval is asserted as a computed bound against the configured cadence (`dueAfterMs <= maxWaitSeconds`), never by waiting out a real one",
        spec: "the slow-poll fallback still surfaces both within its interval",
      },
      {
        assertions: [
          "hooks promptly wrote finish and block event files",
          "every guarded mission-control send was logged before cmux",
          "successful pushes were not delivered again by the slow poll",
        ],
        id: "13.7.native-hook",
        shortfall:
          "#58 graded this PARTIAL: `handleClaudeStop` and `handleCodexNotify` are called IN-PROCESS with hand-authored payloads against a stub `cmux`. No native Claude Stop and no Codex notify hook has ever fired into this suite, so the push path the fallback exists to back up is itself unproven",
        spec: "with hooks disabled ... the slow-poll FALLBACK",
      },
    ],
  },
  8: {
    doubles: ["agent", "brain"],
    number: 8,
    title: "Self-learning loop",
    requirements: [
      {
        assertions: ["a skill seen for the first time was seeded, not judged"],
        id: "13.8.repeat-across-sessions",
        shortfall:
          "the two sessions (`sess-novel-1`, `sess-novel-2`) are fixture transcripts from one driver, so the 'repeat' is scripted rather than observed",
        spec: "repeat a novel procedure across sessions",
      },
      {
        assertions: [
          "the novel procedure was written as a SKILL.md under .argus/skills",
        ],
        id: "13.8.reviewer-writes-skill",
        shortfall: "the skill was written by a fixture reviewer brain",
        spec: "the Reviewer writes a skill",
      },
      {
        assertions: [
          "the planted stale skill is gone from the live skills tree",
          "the stale skill is recoverable under .archive/, never deleted",
          "the learned skill was left untouched",
          "the pinned skill was left untouched",
        ],
        id: "13.8.stale-skill-curated",
        shortfall: "the staleness judgement is a fixture curator brain's",
        spec: "a planted stale skill is curated out",
      },
    ],
  },
  9: {
    doubles: ["agent", "brain", "honcho"],
    number: 9,
    title: "Semantic isolation",
    requirements: [
      {
        assertions: [],
        id: "13.9.query-workspace",
        shortfall:
          "UNCOVERED: no Honcho workspace is queried. `FixtureHoncho` is an in-memory array in `src/eyes/honcho/scenarios.ts`; the only code in the tree that talks to a real instance is `src/eyes/honcho/live.test.ts`, behind its own gate and outside this slot",
        spec: "query the repo's Honcho workspace",
      },
      {
        assertions: [
          "Johan's representation contains only Johan-authored messages",
          "agent and orchestration messages remain on their own peers",
        ],
        id: "13.9.representation-johan-only",
        shortfall:
          "`FixtureHoncho.representation` filters `this.messages` by `peer_id`. That is peer ROUTING, and it proves the eye addressed the right peer — it can never prove a DERIVED representation excludes non-Johan content, because no representation is derived",
        spec: "the Johan representation derives only from Johan-authored messages",
      },
      {
        assertions: [
          "repos bind separate Honcho workspaces",
          "repos bind separate Hermes profiles",
          "Hermes memories resolve only inside each repo",
        ],
        id: "13.9.repo-isolation",
        shortfall:
          "the two peers are given different `HERMES_HOME`s, which AUDIT.md §4 item 11 records as hiding the `argus-<basename>` collision that two same-named repos hit under one real HOME",
        spec: "query the repo's Honcho workspace [per-repo isolation]",
      },
    ],
  },
  10: {
    doubles: ["agent", "brain", "peer-instance"],
    number: 10,
    title: "Blast-radius zero",
    requirements: [
      {
        assertions: ["primary .argus state was removed"],
        id: "13.10.wipe",
        shortfall: "",
        spec: "wipe the sandbox repo's `.argus/`",
      },
      {
        assertions: [
          "peer .argus state stayed byte-identical",
          "peer supervisor state stayed byte-identical",
        ],
        id: "13.10.no-other-instance-noticed",
        shortfall:
          "the peer has NO instance running: `blastRadiusZeroScenario` never starts the peer's eyes, so 'noticed nothing' is asserted of a dormant directory. Byte-identity is trivially true when nothing is watching, which is the one thing SPEC §13.10 rests on",
        spec: "no other repo's instance noticed",
      },
    ],
  },
};

const COVERAGE_BANNER: Readonly<Record<RequirementCoverage, string>> = {
  covered: "COVERED  ",
  live: "LIVE     ",
  missing: "MISSING  ",
  partial: "PARTIAL  ",
  uncovered: "UNCOVERED",
};

/**
 * The line a scenario reports instead of a bare pass.
 *
 * "1. Autonomous batch, zero human input — passed" is the claim this ticket
 * exists to delete. This is what replaces it.
 */
export function renderVerdictLine(grade: ScenarioGrade): string {
  const { counts } = grade;
  const shape = [
    `${counts.covered + counts.live} covered`,
    `${counts.partial} partial`,
    `${counts.uncovered} uncovered`,
    ...(counts.missing > 0 ? [`${counts.missing} MISSING`] : []),
  ].join(", ");
  return (
    `${String(grade.number).padStart(2)}. ${grade.verdict.padEnd(10)} ` +
    `${grade.status.padEnd(6)} ${shape.padEnd(46)} ${grade.title}`
  );
}

/** The whole surface: ten lines, then every shortfall and gap, spelled out. */
export function renderVerdictTable(grades: readonly ScenarioGrade[]): string {
  const lines: string[] = [
    "",
    "SPEC §13 verdicts — STRUCTURAL means real code paths over substituted components.",
    "A slot reaches LIVE only by recording evidence from an agent it actually spawned.",
    "",
    " #  VERDICT    STATUS REQUIREMENTS                                   SCENARIO",
    ...grades.map(renderVerdictLine),
    "",
  ];

  const totals = {
    live: grades.filter(({ verdict }) => verdict === "LIVE").length,
    structural: grades.filter(({ verdict }) => verdict === "STRUCTURAL").length,
  };
  lines.push(
    `${totals.structural} of ${grades.length} scenarios are STRUCTURAL; ` +
      `${totals.live} of ${grades.length} are LIVE.`,
    "",
  );

  for (const grade of grades) {
    const notable = grade.requirements.filter(
      ({ coverage }) => coverage !== "covered" && coverage !== "live",
    );
    if (notable.length === 0) continue;
    lines.push(`${grade.number}. ${grade.title} — doubles: ${grade.doubles.join(", ")}`);
    for (const requirement of notable) {
      lines.push(
        `   ${COVERAGE_BANNER[requirement.coverage]} ${requirement.id}  "${requirement.spec}"`,
        `             ${requirement.shortfall || requirement.absent.join("; ")}`,
      );
    }
    lines.push("");
  }
  return lines.join("\n");
}

/** Every requirement across all ten slots, with its computed coverage. */
export function gradeAll(
  reports: ReadonlyMap<
    CoreScenarioNumber,
    Pick<ScenarioReport, "assertions" | "liveEvidence" | "status">
  >,
): ScenarioGrade[] {
  const grades: ScenarioGrade[] = [];
  for (const number of Object.keys(SPEC_MANIFESTS)
    .map(Number)
    .sort((left, right) => left - right) as CoreScenarioNumber[]) {
    const report = reports.get(number);
    if (report === undefined) continue;
    grades.push(gradeScenario(SPEC_MANIFESTS[number], report));
  }
  return grades;
}
