import { describe, expect, test } from "bun:test";
import { applyAutomaticTransitions, DEFAULT_THRESHOLDS } from "./transitions";
import { emptyRecord, type UsageRecord, type UsageSidecar } from "./usage";

const NOW = Date.parse("2026-08-24T12:00:00.000Z");
const DAY = 86_400_000;
const iso = (daysAgo: number): string => new Date(NOW - daysAgo * DAY).toISOString();

function used(daysAgo: number, overrides: Partial<UsageRecord> = {}): UsageRecord {
  return {
    ...emptyRecord(iso(daysAgo + 1)),
    last_used_at: iso(daysAgo),
    ...overrides,
  };
}

function run(sidecar: UsageSidecar, candidates: string[] = Object.keys(sidecar)) {
  return applyAutomaticTransitions(sidecar, candidates, {
    now: NOW,
    ...DEFAULT_THRESHOLDS,
  });
}

const kindOf = (result: ReturnType<typeof run>, name: string): string | undefined =>
  result.transitions.find((transition) => transition.name === name)?.kind;

describe("deterministic 30/90 transitions (lifted: agent/curator.py:255-311)", () => {
  test("a newly seen skill is seeded and deferred, never judged on first sight", () => {
    const result = run({}, ["brand-new"]);
    expect(kindOf(result, "brand-new")).toBe("seeded");
    expect(result.sidecar["brand-new"]!.created_at).toBe(new Date(NOW).toISOString());
    expect(result.sidecar["brand-new"]!.state).toBe("active");
    expect(result.decisions.archive).toEqual([]);
  });

  test("31 days idle goes stale; 91 days idle is decided for archive", () => {
    const result = run({ dusty: used(31), ancient: used(91) });
    expect(kindOf(result, "dusty")).toBe("stale");
    expect(result.sidecar.dusty!.state).toBe("stale");
    expect(kindOf(result, "ancient")).toBe("archive");
    expect(result.decisions.archive).toEqual(["ancient"]);
  });

  test("the archive decision is a decision — the record is only marked by the move", () => {
    const result = run({ ancient: used(91) });
    expect(result.sidecar.ancient!.state).toBe("active");
    expect(result.sidecar.ancient!.archived_at).toBeNull();
  });

  test("29 days idle is left alone", () => {
    const result = run({ fresh: used(29) });
    expect(kindOf(result, "fresh")).toBe("unchanged");
    expect(result.sidecar.fresh!.state).toBe("active");
  });

  test("activity newer than the stale cutoff reactivates a stale skill", () => {
    const result = run({ revived: used(1, { state: "stale" }) });
    expect(kindOf(result, "revived")).toBe("reactivated");
    expect(result.sidecar.revived!.state).toBe("active");
  });

  test("pinned bypasses everything, however ancient", () => {
    const result = run({ ritual: used(400, { pinned: true }) });
    expect(kindOf(result, "ritual")).toBe("pinned");
    expect(result.decisions.archive).toEqual([]);
    expect(result.sidecar.ritual!.state).toBe("active");
  });

  test("the anchor is the newest of use/view/patch, so a recent view keeps a skill alive", () => {
    const result = run({
      viewed: used(200, { last_viewed_at: iso(2), last_patched_at: iso(500) }),
    });
    expect(kindOf(result, "viewed")).toBe("unchanged");
  });

  test("with no activity at all the anchor is created_at — a new skill never archives", () => {
    const result = run({ born: { ...emptyRecord(iso(2)) }, elderly: { ...emptyRecord(iso(120)) } });
    expect(kindOf(result, "born")).toBe("unchanged");
    expect(kindOf(result, "elderly")).toBe("archive");
  });

  test("an already-archived record is not re-judged", () => {
    const result = run({
      gone: used(400, { state: "archived", archived_at: iso(300) }),
    });
    expect(kindOf(result, "gone")).toBe("unchanged");
    expect(result.decisions.archive).toEqual([]);
  });

  test("records for skills no longer on disk are carried, not judged", () => {
    const result = run({ vanished: used(400) }, []);
    expect(result.transitions).toEqual([]);
    expect(result.sidecar.vanished).toBeDefined();
  });

  test("the input sidecar is never mutated", () => {
    const before: UsageSidecar = { dusty: used(31) };
    const snapshot = structuredClone(before);
    run(before);
    expect(before).toEqual(snapshot);
  });
});
