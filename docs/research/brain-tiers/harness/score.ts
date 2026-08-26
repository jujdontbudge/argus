/**
 * Ticket #54: score the three REPLICATED Reviewer cases (3 reps each), where
 * a single run is not enough to tell a failure mode from a coin flip.
 *
 * Two counters, never averaged into one, because the two failures are not
 * commensurable (#54): a MISS is recoverable — the next session restates the
 * fact — while a WRONG WRITE to USER.md is permanent and steers everything
 * downstream.
 *
 *   bun docs/research/brain-tiers/harness/score.ts
 */
import { join } from "node:path";

import { grade } from "./grade";

const CONFIG_ORDER = ["luna-low", "luna-medium", "luna-max", "sol-low", "sol-medium"];

const graded = await grade();

/** R1: exactly three Johan preferences are stated; all three must land. */
const R1_TARGET = 3;
/** R5 and S2: no USER.md write is supportable from the blocks at all. */
const NO_WRITE_CASES = ["R5-near-miss", "S2-no-procedure"];

console.log("R1-passing-mention — RECALL: Johan preferences reaching USER.md (target 3 per rep)\n");
for (const config of CONFIG_ORDER) {
  const runs = graded
    .filter((g) => g.run.case === "R1-passing-mention" && g.run.config === config)
    .sort((a, b) => a.run.rep - b.run.rep);
  const per = runs.map((g) => g.applied?.userPreferences.length ?? 0);
  const got = per.reduce((a, b) => a + b, 0);
  const max = runs.length * R1_TARGET;
  const rejects = runs.reduce((a, g) => a + (g.rejected?.length ?? 0), 0);
  console.log(
    `  ${config.padEnd(12)} ${got}/${max} preferences (${per.join(", ")})   gate rejections: ${rejects}`,
  );
}

console.log("\nR5 / S2 — WRONG WRITES: USER.md entries with no supportable basis (target 0 per rep)\n");
for (const config of CONFIG_ORDER) {
  const parts: string[] = [];
  let bad = 0;
  let reps = 0;
  for (const name of NO_WRITE_CASES) {
    const runs = graded
      .filter((g) => g.run.case === name && g.run.config === config)
      .sort((a, b) => a.run.rep - b.run.rep);
    const per = runs.map((g) => g.applied?.userPreferences.length ?? 0);
    bad += per.filter((n) => n > 0).length;
    reps += runs.length;
    parts.push(`${name.split("-")[0]}: ${per.join(",")}`);
  }
  console.log(`  ${config.padEnd(12)} ${bad}/${reps} reps wrote something   (${parts.join("   ")})`);
}

console.log("\nOutput tokens per Reviewer call (median across every reviewer/skills run)\n");
for (const config of CONFIG_ORDER) {
  const runs = graded.filter(
    (g) =>
      (g.run.eye === "reviewer" || g.run.eye === "skills") && g.run.config === config,
  );
  const tok = runs
    .map((g) => g.run.usage?.outputTokens ?? 0)
    .sort((a, b) => a - b);
  const med = tok[Math.floor(tok.length / 2)] ?? 0;
  console.log(`  ${config.padEnd(12)} median ${String(med).padStart(5)}   max ${String(tok.at(-1) ?? 0).padStart(5)}   n=${tok.length}`);
}

const all = graded.filter((g) => g.run.ok);
console.log(
  `\nTotals: ${graded.length} runs, ${all.length} completed, ${graded.filter((g) => g.schemaValid).length} schema-valid`,
);
const price: Record<string, [number, number]> = {
  "luna-low": [0.2, 1.2],
  "luna-medium": [0.2, 1.2],
  "luna-max": [0.2, 1.2],
  "sol-low": [4, 20],
  "sol-medium": [4, 20],
};
let spent = 0;
let inTok = 0;
let outTok = 0;
for (const g of all) {
  const [pi, po] = price[g.run.config] ?? [0, 0];
  const i = g.run.usage?.inputTokens ?? 0;
  const o = g.run.usage?.outputTokens ?? 0;
  inTok += i;
  outTok += o;
  spent += (i * pi + o * po) / 1_000_000;
}
console.log(
  `Study cost: ${inTok.toLocaleString()} input + ${outTok.toLocaleString()} output tokens = $${spent.toFixed(2)} API-equivalent`,
);
void join;
