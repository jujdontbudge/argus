/**
 * The canary at the seam where records enter the tree (#100).
 *
 * One of these lives inside each source parser. It observes every record the
 * parser reads, differences it against the captured contract, and emits a
 * `shape-drift` event BESIDE the ordinary events — never instead of them.
 *
 * WHAT DRIFT DOES, and why. Three choices were available: refuse the record,
 * degrade loudly, or record and continue silently. Silence is the bug this
 * ticket exists to end — all four historical bugs were silent, and each was
 * found only when a live run produced a wrong answer somewhere far away.
 * Refusal is worse than it looks: the eyes are ALWAYS-ON across every enabled
 * repo, and a CLI adding one cosmetic field — a `uuid`, a `slug` — would then
 * stop the fleet observing anything, which is #13.4's deafness with the volume
 * turned to maximum. So: DEGRADE, with a readable reason, exactly the shape
 * #96 gave a silent deployment and #85 gave an alive PID with no health
 * report. The record is parsed and classified by today's rules, no verdict
 * moves, and a durable audit surfaces in `argus status` under AUDIT ALERTS
 * naming the source, the severity, the field path, the unfamiliar token and
 * the session and file it was seen in — enough for an operator to go look.
 *
 * Deduplication is part of the requirement, not an optimisation: a drifted CLI
 * writes its new field on every record, so one alarm per FACT is the
 * difference between an alarm and a firehose. It happens twice — here, per
 * parser, to keep the event stream small, and again in `audits/store.ts`,
 * whose identity hash collapses the same fact across eyes, restarts and repos.
 */
import type { ShapeDriftEvent } from "../events.ts";
import { loadShapeBaseline } from "./baseline.ts";
import {
  driftFrom,
  observe,
  type ShapeBaseline,
  type ShapeFact,
  type ShapeSource,
} from "./contract.ts";

export class ShapeWatcher {
  readonly #baseline: ShapeBaseline;
  readonly #file: string;
  readonly #seen = new Set<string>();
  readonly #source: ShapeSource;

  constructor(source: ShapeSource, file: string, baseline = loadShapeBaseline()) {
    this.#baseline = baseline;
    this.#file = file;
    this.#source = source;
  }

  /** Zero or more `shape-drift` events for one record; empty is the normal case. */
  inspect(record: unknown, sessionId?: string, ts?: string): ShapeDriftEvent[] {
    return this.inspectFacts(observe(this.#source, record), sessionId, ts);
  }

  /**
   * The same difference against facts observed somewhere other than a record —
   * Hermes reads its contract off the database schema, not off a row.
   */
  inspectFacts(facts: readonly ShapeFact[], sessionId?: string, ts?: string): ShapeDriftEvent[] {
    const events: ShapeDriftEvent[] = [];
    for (const drift of driftFrom(this.#baseline, this.#source, facts)) {
      const key = `${drift.dimension}|${drift.path}|${drift.token}`;
      if (this.#seen.has(key)) continue;
      this.#seen.add(key);
      events.push({
        type: "shape-drift",
        source: this.#source,
        drift,
        ...(sessionId !== undefined && { sessionId }),
        ...(ts !== undefined && { ts }),
        file: this.#file,
      });
    }
    return events;
  }
}
