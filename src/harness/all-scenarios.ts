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
 *     order-tolerant.
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
 */
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
import {
  createScenarioRegistry,
  fakeJohanBindingScenario,
  type ScenarioRegistry,
} from "./index.ts";

/** Compose every ticket's §13 halves onto an existing registry. */
export function registerAllScenarios(registry: ScenarioRegistry): void {
  // Overwriters first, innermost half outward: #25 → #30 → #31 → #34.
  registerProvenanceScenarios(registry);
  registerReviewerScenarios(registry);
  registerDigestScenarios(registry);
  registerEventScenarios(registry);

  // Then the extenders, which chain onto whatever is registered.
  registerCuratorScenarios(registry);
  registerRetroScenarios(registry);
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
export function createFullScenarioRegistry(): ScenarioRegistry {
  const registry = createScenarioRegistry();
  registerAllScenarios(registry);
  return registry;
}
