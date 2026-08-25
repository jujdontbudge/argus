import { describe, expect, test } from "bun:test";
import { Coalescer } from "./coalesce";

const CADENCE = { quietWindowSeconds: 30, maxWaitSeconds: 300 };
const SECOND = 1_000;

describe("debounce/coalesce cadence (ADR-0002: 30s quiet / 300s max)", () => {
  test("nothing pending → no deadline", () => {
    const coalescer = new Coalescer(CADENCE);
    expect(coalescer.dueAt()).toBeNull();
    expect(coalescer.shouldFire(0)).toBe(false);
  });

  test("a single turn fires after the quiet window", () => {
    const coalescer = new Coalescer(CADENCE);
    coalescer.note(0);
    expect(coalescer.dueAt()).toBe(30 * SECOND);
    expect(coalescer.shouldFire(29 * SECOND)).toBe(false);
    expect(coalescer.shouldFire(30 * SECOND)).toBe(true);
  });

  test("each new turn pushes the quiet deadline out (debounce)", () => {
    const coalescer = new Coalescer(CADENCE);
    coalescer.note(0);
    coalescer.note(20 * SECOND);
    expect(coalescer.dueAt()).toBe(50 * SECOND);
    expect(coalescer.shouldFire(49 * SECOND)).toBe(false);
    expect(coalescer.shouldFire(50 * SECOND)).toBe(true);
  });

  test("a busy session cannot starve the eye: max wait caps the deadline", () => {
    const coalescer = new Coalescer(CADENCE);
    for (let t = 0; t <= 290 * SECOND; t += 10 * SECOND) coalescer.note(t);
    // Quiet window alone would say 320s; the 300s cap from the FIRST pending
    // turn wins.
    expect(coalescer.dueAt()).toBe(300 * SECOND);
    expect(coalescer.shouldFire(300 * SECOND)).toBe(true);
  });

  test("flush resets both windows; the next turn starts fresh", () => {
    const coalescer = new Coalescer(CADENCE);
    coalescer.note(0);
    coalescer.flush();
    expect(coalescer.dueAt()).toBeNull();
    coalescer.note(400 * SECOND);
    expect(coalescer.dueAt()).toBe(430 * SECOND);
  });

  test("restart mid-coalesce: seeding with the persisted pending timestamps preserves the max-wait clock", () => {
    const coalescer = new Coalescer(CADENCE, {
      firstPendingAt: 0,
      lastEventAt: 290 * SECOND,
    });
    expect(coalescer.dueAt()).toBe(300 * SECOND);
  });
});
