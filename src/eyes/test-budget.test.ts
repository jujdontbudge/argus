import { describe, expect, test } from "bun:test";
import { loadScaledMs, scaleBudget } from "./test-budget";

// A 10-core machine, which is what the measurements in ./test-budget.ts were
// taken on.
const CORES = 10;

describe("load-scaled test budgets (#42 item 5)", () => {
  test("a quiet machine gets exactly today's budget — hang detection stays tight", () => {
    expect(scaleBudget({ idleMs: 60_000, ceilingMs: 300_000, load: 0.4, cores: CORES }))
      .toBe(60_000);
    // Fully busy but not oversubscribed is still a machine doing its work at
    // full speed: one core per runnable thread.
    expect(scaleBudget({ idleMs: 60_000, ceilingMs: 300_000, load: 10, cores: CORES }))
      .toBe(60_000);
  });

  test("the budget stretches in proportion to measured oversubscription", () => {
    expect(scaleBudget({ idleMs: 60_000, ceilingMs: 300_000, load: 30, cores: CORES }))
      .toBe(180_000);
  });

  test("the ceiling is the point past which slow stops being distinguishable", () => {
    // Load average 98 on ten cores is what #38's worker measured when two
    // curator tests timed out.
    expect(scaleBudget({ idleMs: 60_000, ceilingMs: 300_000, load: 98, cores: CORES }))
      .toBe(300_000);
    expect(scaleBudget({ idleMs: 240_000, ceilingMs: 600_000, load: 98, cores: CORES }))
      .toBe(600_000);
  });

  test("a budget is never scaled below the idle floor", () => {
    expect(scaleBudget({ idleMs: 60_000, ceilingMs: 10_000, load: 500, cores: CORES }))
      .toBe(60_000);
    expect(scaleBudget({ idleMs: 60_000, ceilingMs: 300_000, load: 0, cores: 0 }))
      .toBe(60_000);
  });

  test("the real reading is a live budget between the floor and the ceiling", () => {
    const budget = loadScaledMs(60_000, 300_000);
    expect(budget).toBeGreaterThanOrEqual(60_000);
    expect(budget).toBeLessThanOrEqual(300_000);
  });
});
