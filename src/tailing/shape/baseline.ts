/**
 * The captured contract, loaded (#100). Kept behind a function so a caller can
 * substitute a corpus in a test without the module-level import order deciding
 * anything, and cached because every parser instance asks for it.
 *
 * The JSON is produced by `scripts/shape/capture-baseline.ts` from real
 * transcripts and the real Hermes schema. Do not hand-edit it: a fact typed in
 * by a human is exactly the restatement this ticket exists to stop.
 */
import captured from "./baseline.json" with { type: "json" };
import type { ShapeBaseline } from "./contract.ts";

let cached: ShapeBaseline | null = null;

export function loadShapeBaseline(): ShapeBaseline {
  cached ??= captured as ShapeBaseline;
  return cached;
}
