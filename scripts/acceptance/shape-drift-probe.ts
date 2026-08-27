#!/usr/bin/env bun
/**
 * Does the canary detect drift that REALLY HAPPENED? (#100)
 *
 * A canary tested only against shapes its author invented proves the author's
 * imagination, not the canary. So this probe never invents anything:
 *
 *   1. capture the contract from the OLDEST real transcripts on this machine
 *   2. capture what the NEWEST real transcripts actually contain
 *   3. report every fact the old contract had never seen
 *
 * Every line it prints is a shape an agent CLI genuinely started writing at
 * some point between the two, which is exactly the event all four historical
 * attribution bugs were. Read-only throughout; it writes only to the two
 * scratch files it is given and never opens any credential.
 *
 *   bun scripts/acceptance/shape-drift-probe.ts [--scratch <dir>]
 */
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { severityOf, type ShapeBaseline, type ShapeDimension } from "../../src/tailing/shape/contract.ts";

const capture = join(import.meta.dir, "../shape/capture-baseline.ts");

async function run(out: string, env: Record<string, string>): Promise<ShapeBaseline> {
  const proc = Bun.spawn([process.execPath, capture, "--out", out], {
    env: { ...Bun.env, ...env },
    stderr: "inherit",
    stdout: "ignore",
  });
  if ((await proc.exited) !== 0) throw new Error(`capture failed: ${out}`);
  return (await Bun.file(out).json()) as ShapeBaseline;
}

const flag = process.argv.indexOf("--scratch");
const scratch =
  flag === -1 ? await mkdtemp(join(tmpdir(), "argus-shape-probe-")) : process.argv[flag + 1]!;

const [old, fresh] = [
  await run(join(scratch, "oldest.json"), {
    ARGUS_SHAPE_MAX_FILES: "250",
    ARGUS_SHAPE_ORDER: "oldest",
  }),
  await run(join(scratch, "newest.json"), { ARGUS_SHAPE_MAX_FILES: "120" }),
];

console.log(`captured-at        ${old.capturedAt}`);
for (const source of ["claude-code", "codex", "hermes"] as const) {
  console.log(
    `${source.padEnd(12)} oldest ${old.corpus[source]?.records ?? 0} records / ` +
      `newest ${fresh.corpus[source]?.records ?? 0} records`,
  );
}
console.log(`claude versions    installed ${old.versions["claude-code-installed"]?.join(", ")}`);
console.log(`codex versions     installed ${old.versions["codex-installed"]?.join(", ")}`);

let decisionBearing = 0;
for (const source of ["claude-code", "codex", "hermes"] as const) {
  const known = new Set(old.facts[source] ?? []);
  const drift = (fresh.facts[source] ?? []).filter((fact) => !known.has(fact)).sort();
  console.log(`\n=== ${source}: ${drift.length} facts the OLD contract had never seen ===`);
  for (const fact of drift) {
    const severity = severityOf(fact.split("|")[0] as ShapeDimension);
    if (severity === "decision-bearing") decisionBearing += 1;
    console.log(`  [${severity}] ${fact}`);
  }
}
console.log(`\ndecision-bearing drift: ${decisionBearing}`);
