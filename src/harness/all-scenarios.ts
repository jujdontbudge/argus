/**
 * The FULL SPEC §13 suite — all ten scenarios in one registry.
 *
 * Ten slots, eleven registrars. Every feature ticket registered its own half
 * (or halves) of the scenarios that grade it, but nothing in the tree ever
 * composed them: each module's own test called only its own registrar, so
 * "all ten §13 scenarios green in a single suite run" had no executable
 * meaning before ticket #36.
 *
 * ORDER IS LOAD-BEARING. `ScenarioRegistry.register` is a Map.set, and the
 * registrars are not uniform:
 *
 *   - archiver, hermes, codex, honcho, curator and retro EXTEND — they read
 *     `registry.get(n)` and chain onto whatever is already there, so they are
 *     order-tolerant. Retro chains TWO slots: 3 (rogue session) and, since
 *     #38, 2 (fake-Johan takeover, where its scope-drift half lives).
 *   - provenance (2, 4, 5), reviewer (1, 2, 8), digest (1, 2, 7) and events
 *     (7) OVERWRITE. They are safe only because each one statically imports
 *     and re-runs the half it supersedes — reviewer's slot 2 calls
 *     provenance's `takeoverScenario`, digest's calls reviewer's, events'
 *     slot 7 calls digest's. An overwriter must therefore run BEFORE every
 *     extender that touches the same slot, and AFTER the half it wraps.
 *
 * Register in any other order and halves vanish silently — with the build
 * map's merge order (#22 → #35) scenario 1 keeps 5 of its 9 assertions and
 * scenario 4 keeps 4 of its 5, and the suite still reports ten green. That is
 * what `all-scenarios.test.ts` pins: not just that the slots are filled, but
 * that each contributing ticket's own assertion is still in the transcript.
 *
 * AMENDED BY #63, which is the step this docblock stops one short of. A
 * LOSSLESS composition of all ten slots still overstates itself, because
 * every slot drives fixture brains, a fake `gh`, an in-memory Honcho, a stub
 * `cmux` and hand-authored hook payloads. "Ten green" is therefore never the
 * honest summary; `verdicts.ts` holds the SPEC §13-derived assertion
 * manifests and the STRUCTURAL/LIVE verdict each slot actually earns, and the
 * suite prints them rather than a bare pass.
 *
 * ADDITIVE #72: the fixed ten-slot core is still exactly that. The init/up
 * surface now lives beside it as five labelled setup scenarios, exported
 * below. Keeping the registries separate prevents setup coverage from buying
 * room by weakening or renumbering any existing core verdict.
 */
import { registerCompletionScenarios } from "../complete/scenarios.ts";
import { registerEventScenarios } from "../events/scenarios.ts";
import { registerArchiverScenarios } from "../eyes/archiver/scenarios.ts";
import { registerCuratorScenarios } from "../eyes/curator/scenarios.ts";
import { registerDigestScenarios } from "../eyes/digest/scenarios.ts";
import { registerHonchoScenarios } from "../eyes/honcho/scenarios.ts";
import { registerRetroScenarios } from "../eyes/retro/scenarios.ts";
import { registerReviewerScenarios } from "../eyes/reviewer/scenarios.ts";
import { registerProvenanceScenarios } from "../provenance/scenarios.ts";
import { registerCodexScenarios } from "../tailing/codex-scenarios.ts";
import { registerHermesScenarios } from "../tailing/hermes-scenarios.ts";
import { registerWatchScenarios } from "../watch/scenarios.ts";
import type { Brain } from "../eyes/brain.ts";
import {
  createScenarioRegistry,
  fakeJohanBindingScenario,
  type ScenarioRegistry,
} from "./index.ts";

export {
  gradeInitUpScenarios,
  INIT_UP_MANIFESTS,
  INIT_UP_SCENARIOS,
  type InitUpScenarioId,
} from "./init-up-scenarios.ts";

/** Existing production `Brain` seam, threaded only for the opt-in #77 run. */
export interface ScenarioBrainOverrides {
  completion?: Brain;
  curator?: Brain;
  digest?: Brain;
  retro?: Brain;
  reviewer?: Brain;
}

export interface AllScenarioOptions {
  brains?: ScenarioBrainOverrides;
}

/** Compose every ticket's §13 halves onto an existing registry. */
export function registerAllScenarios(
  registry: ScenarioRegistry,
  options: AllScenarioOptions = {},
): void {
  const brains = options.brains ?? {};
  // Overwriters first, innermost half outward: #25 → #30 → #31 → #34.
  registerProvenanceScenarios(registry);
  registerReviewerScenarios(registry, undefined, brains.reviewer);
  registerDigestScenarios(registry, undefined, {
    ...(brains.digest !== undefined && { digest: brains.digest }),
    ...(brains.reviewer !== undefined && { reviewer: brains.reviewer }),
  });
  registerEventScenarios(registry, undefined, brains.digest);

  // Then the extenders, which chain onto whatever is registered.
  registerCompletionScenarios(registry, brains.completion);
  registerCuratorScenarios(registry, undefined, {
    ...(brains.curator !== undefined && { curator: brains.curator }),
    ...(brains.reviewer !== undefined && { reviewer: brains.reviewer }),
  });
  registerRetroScenarios(registry, undefined, undefined, {
    ...(brains.digest !== undefined && { digest: brains.digest }),
    ...(brains.retro !== undefined && { retro: brains.retro }),
  });
  registerArchiverScenarios(registry);
  registerHermesScenarios(registry);
  registerCodexScenarios(registry);
  registerHonchoScenarios(registry);
  registerWatchScenarios(registry);

  // #28's slot-2 half is the one the overwriters drop: the base registry
  // seeds slot 2 with the agent-binding scenario and provenance replaces it
  // without re-running it. Put it back at the front of the chain, where the
  // base registry had it.
  const composed = registry.get(2);
  if (composed === undefined) throw new Error("slot 2 lost its scenario");
  registry.register(2, async (context) => {
    await fakeJohanBindingScenario(context);
    await composed(context);
  });
}

/** A registry with all ten SPEC §13 scenarios implemented. */
export function createFullScenarioRegistry(
  options: AllScenarioOptions = {},
): ScenarioRegistry {
  const registry = createScenarioRegistry();
  registerAllScenarios(registry, options);
  return registry;
}
