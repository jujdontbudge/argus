/**
 * Ticket #77 — retire the watcher-brain double in the eight core slots that
 * declare it, behind the existing explicit subscription gate.
 *
 * This is ADDITIVE, for the same reason #74 and #76 were additive: the core
 * slots still run fixture brains on every default `bun test`, so their own
 * manifests remain exactly as honest as they were. With
 * `ARGUS_LIVE_WATCHER_BRAINS=1`, this module runs the same slot handlers and
 * the same assertions again, but threads production's existing
 * `createCodexBrain` through every judgment seam. No assertion is inherited
 * from a different run and no live-agent evidence is recorded.
 *
 * Five slots actually spend a brain call: 1, 2, 3, 7 and 8. Slots 6, 9 and 10
 * never ask a brain a question; their core manifests nevertheless carry the
 * blanket `brain` declaration from #63. Their additive renderings retire only
 * that inapplicable declaration. They do not invent a call to buy a label.
 *
 * ALL EIGHT REMAIN STRUCTURAL. Their agents are synthesized, their trackers,
 * Honcho and cmux are still doubles where the core manifests say so, and a
 * real watcher brain is not a live agent session. `recordLiveEvidence` is
 * never called here, so #63's LIVE rule remains unreachable.
 */
import { mkdir } from "node:fs/promises";

import {
  createCodexBrain,
  type Brain,
  type BrainRequest,
} from "../eyes/brain.ts";
import { DEFAULT_EYES_CONFIG } from "../eyes/config.ts";
import {
  describeLiveIntegrationGate,
  LIVE_WATCHER_BRAINS_GATE,
  resolveWatcherBrainGate,
} from "../eyes/live-gate.ts";
import { createFullScenarioRegistry } from "./all-scenarios.ts";
import {
  runScenario,
  type CoreScenarioNumber,
  type ScenarioReport,
  type ScenarioRunResult,
} from "./index.ts";
import type { LiveHalfOutcome } from "./live-gate.ts";
import {
  gradeScenario,
  SPEC_MANIFESTS,
  type LabeledScenarioManifest,
  type ScenarioGrade,
} from "./verdicts.ts";

export const REAL_BRAIN_SLOTS = [1, 2, 3, 6, 7, 8, 9, 10] as const satisfies
  readonly CoreScenarioNumber[];

export type RealBrainSlot = (typeof REAL_BRAIN_SLOTS)[number];

/** Only shortfalls whose stated blocker was the fixture brain move. */
const SHORTFALL_AFTER_REAL_BRAIN: Readonly<Record<string, string>> = {
  "13.1.user-md": "",
  "13.1.memory-md": "",
  "13.1.digests-index": "",
  "13.1.tickets-closed":
    "#57 remains PARTIAL: `gh`, the worker process and the gate command are still doubles, so this proves the loop closes a ticket against a TRACKER DOUBLE — not that live agent work survives a live tracker",
  "13.2.user-md-learned": "",
  "13.3.body-prompts-diff": "",
  "13.8.reviewer-writes-skill": "",
  "13.8.stale-skill-curated": "",
};

function realBrainManifest(slot: RealBrainSlot): LabeledScenarioManifest {
  const core = SPEC_MANIFESTS[slot];
  if (!core.doubles.includes("brain")) {
    throw new Error(`slot ${slot} does not declare a brain double`);
  }
  return {
    doubles: core.doubles.filter((entry) => entry !== "brain"),
    number: `${slot}-real-brain`,
    requirements: core.requirements.map((requirement) => ({
      ...requirement,
      shortfall:
        SHORTFALL_AFTER_REAL_BRAIN[requirement.id] ?? requirement.shortfall,
    })),
    title: `${core.title} — real watcher brain (opt-in)`,
  };
}

/** Eight separately graded renderings; each retires exactly `brain`. */
export const REAL_BRAIN_MANIFESTS: readonly LabeledScenarioManifest[] =
  REAL_BRAIN_SLOTS.map(realBrainManifest);

export function probeRealBrainHarness(): LiveHalfOutcome {
  return resolveWatcherBrainGate({
    codexInstalled: Bun.which("codex") !== null,
    env: Bun.env,
  });
}

export function describeRealBrainHarnessGate(
  outcome: LiveHalfOutcome,
): string {
  return describeLiveIntegrationGate(
    "SPEC §13 real-brain renderings (8 STRUCTURAL slots; 5 spend calls)",
    LIVE_WATCHER_BRAINS_GATE,
    outcome,
  );
}

class CountingBrain implements Brain {
  calls = 0;

  constructor(private readonly delegate: Brain) {}

  async evaluate(request: BrainRequest) {
    this.calls += 1;
    return this.delegate.evaluate(request);
  }
}

export interface RealBrainHarnessRun {
  callsBySlot: Readonly<Record<RealBrainSlot, number>>;
  reports: readonly ScenarioRunResult[];
  totalCalls: number;
}

/**
 * Run sequentially. `runScenarios` is intentionally not used: its parallel
 * sandboxes each own a cap directory, which could exceed ADR-0002's
 * machine-wide concurrency budget and spend several subscription calls at
 * once.
 *
 * There is no brain/spawner/driver/evidence parameter here. The gate is read
 * from the real environment and the only brain constructed is production's
 * subscription-backed `createCodexBrain` at ADR-0002's settled defaults.
 */
export async function runRealBrainHarness(options: {
  checkout: string;
  reportDirectory: string;
}): Promise<RealBrainHarnessRun> {
  const gate = probeRealBrainHarness();
  if (gate.status !== "run") {
    throw new Error(
      `refusing to run real watcher brains: ${gate.status} — ${gate.reason}`,
    );
  }

  await mkdir(options.reportDirectory, { recursive: true });
  const brain = new CountingBrain(
    createCodexBrain({
      model: DEFAULT_EYES_CONFIG.brain.model,
      reasoningEffort: DEFAULT_EYES_CONFIG.brain.reasoningEffort,
    }),
  );
  const registry = createFullScenarioRegistry({
    brains: {
      completion: brain,
      curator: brain,
      digest: brain,
      retro: brain,
      reviewer: brain,
    },
  });

  const reports: ScenarioRunResult[] = [];
  const callsBySlot = {} as Record<RealBrainSlot, number>;
  for (const slot of REAL_BRAIN_SLOTS) {
    const scenario = registry.get(slot);
    if (scenario === undefined) throw new Error(`slot ${slot} is unimplemented`);
    const before = brain.calls;
    reports.push(
      await runScenario({
        checkout: options.checkout,
        name: `${slot}. ${SPEC_MANIFESTS[slot].title} — real watcher brain`,
        reportDirectory: options.reportDirectory,
        scenario,
      }),
    );
    callsBySlot[slot] = brain.calls - before;
  }

  return { callsBySlot, reports, totalCalls: brain.calls };
}

export function gradeRealBrainHarness(
  reports: ReadonlyMap<
    RealBrainSlot,
    Pick<ScenarioReport, "assertions" | "liveEvidence" | "status">
  >,
): ScenarioGrade[] {
  return REAL_BRAIN_MANIFESTS.flatMap((manifest, index) => {
    const slot = REAL_BRAIN_SLOTS[index]!;
    const report = reports.get(slot);
    return report === undefined ? [] : [gradeScenario(manifest, report)];
  });
}
