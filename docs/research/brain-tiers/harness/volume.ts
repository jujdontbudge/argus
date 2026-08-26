/**
 * Ticket #54: derive Johan's REAL watcher-brain call volume from the
 * transcripts on this machine, by replaying the real turn timestamps through
 * the PRODUCTION `Coalescer` at the ADR-0002 cadences.
 *
 * Call volume — not session count — is what a model tier is billed on, and
 * the debounce means the two are not proportional: a 200-turn burst inside
 * one quiet window is ONE call.
 *
 *   bun docs/research/brain-tiers/harness/volume.ts
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { Coalescer } from "../../../../src/eyes/coalesce";
import { DEFAULT_EYES_CONFIG } from "../../../../src/eyes/config";

const HOME = homedir();

/** Every message timestamp the Argus repo's watchers would have seen. */
async function claudeTimestamps(): Promise<Map<string, number[]>> {
  const root = join(HOME, ".claude/projects");
  const slugs = (await readdir(root)).filter((s) => s.includes("-argus"));
  const byDay = new Map<string, number[]>();
  for (const slug of slugs) {
    let files: string[];
    try {
      files = (await readdir(join(root, slug))).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const file of files) {
      const text = await Bun.file(join(root, slug, file)).text();
      for (const line of text.split("\n")) {
        if (line.length === 0) continue;
        let row: Record<string, unknown>;
        try {
          row = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (row.type !== "user" && row.type !== "assistant") continue;
        const ts = row.timestamp;
        if (typeof ts !== "string") continue;
        const at = Date.parse(ts);
        if (Number.isNaN(at)) continue;
        const day = ts.slice(0, 10);
        const list = byDay.get(day) ?? [];
        list.push(at);
        byDay.set(day, list);
      }
    }
  }
  return byDay;
}

/** Replay one day's turns through the real Coalescer; count the fires. */
function fires(times: number[], quiet: number, maxWait: number): number {
  const coalescer = new Coalescer({
    quietWindowSeconds: quiet,
    maxWaitSeconds: maxWait,
  });
  const sorted = [...times].sort((a, b) => a - b);
  let count = 0;
  for (const at of sorted) {
    // Advance the clock to this turn; anything that came due first fires.
    while (coalescer.shouldFire(at)) {
      count += 1;
      coalescer.flush();
    }
    coalescer.note(at);
  }
  // Whatever is still pending fires once the session goes quiet.
  if (coalescer.dueAt() !== null) count += 1;
  return count;
}

const byDay = await claudeTimestamps();
const days = [...byDay.keys()].sort();
const { reviewer, digest, retro } = DEFAULT_EYES_CONFIG;

console.log("day        turns  reviewer  digest  retro   total");
let totals = { turns: 0, reviewer: 0, digest: 0, retro: 0 };
for (const day of days) {
  const times = byDay.get(day)!;
  const r = fires(times, reviewer.quietWindowSeconds, reviewer.maxWaitSeconds);
  const d = fires(times, digest.quietWindowSeconds, digest.maxWaitSeconds);
  const t = fires(times, retro.quietWindowSeconds, retro.maxWaitSeconds);
  totals = {
    turns: totals.turns + times.length,
    reviewer: totals.reviewer + r,
    digest: totals.digest + d,
    retro: totals.retro + t,
  };
  console.log(
    `${day}  ${String(times.length).padStart(5)}  ${String(r).padStart(8)}  ${String(d).padStart(6)}  ${String(t).padStart(5)}  ${String(r + d + t).padStart(6)}`,
  );
}
console.log(
  `\nTOTAL      ${String(totals.turns).padStart(5)}  ${String(totals.reviewer).padStart(8)}  ${String(totals.digest).padStart(6)}  ${String(totals.retro).padStart(5)}  ${String(totals.reviewer + totals.digest + totals.retro).padStart(6)}`,
);
const active = days.filter((d) => (byDay.get(d)?.length ?? 0) >= 50);
console.log(`\nactive days (>=50 turns): ${active.length} of ${days.length}`);
const busiest = days
  .map((d) => ({ d, n: byDay.get(d)!.length }))
  .sort((a, b) => b.n - a.n)
  .slice(0, 3);
console.log(`busiest: ${busiest.map((b) => `${b.d} (${b.n} turns)`).join(", ")}`);
