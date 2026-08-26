/**
 * Ticket #54 cost model.
 *
 * TWO currencies, because Argus's brains run `codex exec` on Johan's ChatGPT
 * subscription (SPEC section 1 item 7), not on the API:
 *
 * 1. QUOTA — the binding constraint today. OpenAI publishes local-message
 *    bands per 5-hour window per model; Luna's band is 25x Sol's on the same
 *    plan, so a model swap is a 25x change in how fast the shared allowance
 *    (shared with Johan's own interactive Codex sessions) drains.
 * 2. DOLLARS — what the same traffic would cost if metered, which is also
 *    what buying credits prices off. Rates below are OpenAI list, Aug 2026.
 *
 * Volumes come from ./volume.ts, which replays the REAL turn timestamps in
 * ~/.claude/projects through the production Coalescer.
 *
 *   bun docs/research/brain-tiers/harness/cost.ts
 */
import { join } from "node:path";

const RESULTS = new URL("../results/", import.meta.url).pathname;

/** USD per 1M tokens, OpenAI list, August 2026. Sol's rate is promotional. */
const PRICE: Record<string, { input: number; output: number }> = {
  "gpt-5.6-luna": { input: 0.2, output: 1.2 },
  "gpt-5.6-sol": { input: 4.0, output: 20.0 },
};

/** Local messages per 5-hour window, ChatGPT Pro 5x (OpenAI published). */
const BAND: Record<string, [number, number]> = {
  "gpt-5.6-luna": [1_250, 10_000],
  "gpt-5.6-sol": [50, 500],
};

/**
 * Brain calls per day per repo, from ./volume.ts over the real transcripts.
 * `heavy` is 2026-08-25 (6,968 turns, the busiest real day); `typical` is the
 * mean over the four observed active days.
 */
const CALLS_PER_DAY = {
  reviewer: { heavy: 242, typical: 103 },
  digest: { heavy: 325, typical: 134 },
  // The Retro eye's brain fires only on UNJUDGED work (retro.ts:503 returns
  // before the brain when there are no signals and no drift candidates, and
  // `state.judged` retires a candidate for good). Its scan cadence would
  // allow 154/day; the questions actually asked are bounded by new ticket
  // sessions with new commits, which on the busiest observed day is ~25.
  retro: { heavy: 25, typical: 10 },
} as const;

interface Run {
  case: string;
  eye: string;
  config: string;
  model: string;
  effort: string;
  ms: number;
  ok: boolean;
  usage?: { inputTokens?: number; outputTokens?: number } | null;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length === 0 ? 0 : s[Math.floor(s.length / 2)]!;
}

const text = await Bun.file(join(RESULTS, "runs.jsonl")).text();
const runs = text
  .split("\n")
  .filter((l) => l.length > 0)
  .map((l) => JSON.parse(l) as Run)
  .filter((r) => r.ok && r.usage);

/** Reviewer and Skills share one eye and one call — fold them together. */
const eyeOf = (eye: string): "reviewer" | "digest" | "retro" =>
  eye === "digest" ? "digest" : eye === "retro-drift" ? "retro" : "reviewer";

const configs = [...new Set(runs.map((r) => r.config))].sort();
const eyes = ["reviewer", "digest", "retro"] as const;

console.log("Per-call medians and per-repo monthly cost (30 days)\n");
console.log(
  "eye       config       n   in-tok  out-tok    $/call   lat s   $/mo typical   $/mo heavy   % of 5h band (heavy)",
);
const table: Record<string, Record<string, { perCall: number; typical: number; heavy: number }>> = {};
for (const eye of eyes) {
  table[eye] = {};
  for (const config of configs) {
    const rows = runs.filter((r) => eyeOf(r.eye) === eye && r.config === config);
    if (rows.length === 0) continue;
    const model = rows[0]!.model;
    const price = PRICE[model]!;
    const inTok = median(rows.map((r) => r.usage!.inputTokens ?? 0));
    const outTok = median(rows.map((r) => r.usage!.outputTokens ?? 0));
    const lat = median(rows.map((r) => r.ms)) / 1000;
    const perCall = (inTok * price.input + outTok * price.output) / 1_000_000;
    const calls = CALLS_PER_DAY[eye];
    const typical = perCall * calls.typical * 30;
    const heavy = perCall * calls.heavy * 30;
    // Calls land across ~4.8 five-hour windows per day.
    const perWindow = calls.heavy / 4.8;
    const band = BAND[model]!;
    const pctHi = (perWindow / band[0]) * 100; // pessimistic end of the band
    const pctLo = (perWindow / band[1]) * 100;
    table[eye]![config] = { perCall, typical, heavy };
    console.log(
      `${eye.padEnd(9)} ${config.padEnd(12)} ${String(rows.length).padStart(2)} ${String(inTok).padStart(7)} ${String(outTok).padStart(8)} ${`$${perCall.toFixed(5)}`.padStart(10)} ${lat.toFixed(0).padStart(6)} ${`$${typical.toFixed(2)}`.padStart(13)} ${`$${heavy.toFixed(2)}`.padStart(12)}   ${pctLo.toFixed(1)}%-${pctHi.toFixed(1)}%`,
    );
  }
  console.log("");
}

console.log("Marginal monthly dollars vs the luna-low baseline (heavy day, one repo)\n");
for (const eye of eyes) {
  const base = table[eye]?.["luna-low"];
  if (base === undefined) continue;
  for (const config of configs) {
    const row = table[eye]![config];
    if (row === undefined || config === "luna-low") continue;
    console.log(
      `  ${eye.padEnd(9)} ${config.padEnd(12)} +$${(row.heavy - base.heavy).toFixed(2)}/mo  (${(row.heavy / base.heavy).toFixed(1)}x)`,
    );
  }
}

const total = (config: string): number =>
  eyes.reduce((sum, eye) => sum + (table[eye]?.[config]?.heavy ?? 0), 0);
console.log("\nAll three eyes on one config, heavy day, one repo:");
for (const config of configs) console.log(`  ${config.padEnd(12)} $${total(config).toFixed(2)}/mo`);
