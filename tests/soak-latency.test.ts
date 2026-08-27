/**
 * The pre-registered latency rule has to be exercised BEFORE #109 runs (#110).
 *
 * A decision rule committed ahead of the run it judges is worth nothing if it
 * throws, mislabels, or silently defaults the first time it meets a real
 * series. These tests pin the four things the pre-registration actually
 * promises: the bucketing, the per-query asymmetry (a numeric bar for the two
 * growing queries, a shape rule for the flat one), the straddle clause, and
 * the refusal to apply a registered bar to an unregistered query string.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import {
  ABSOLUTE_BACKSTOP_MS,
  BUCKET_MINUTES,
  bucketsFor,
  judge,
  judgeQuery,
  readSeries,
  REGISTERED,
  WARMUP_MINUTES,
  type Sample,
} from "../scripts/soak/latency.ts";

/**
 * A synthetic series in the sampler's own shape: one sample every 30 s for
 * `minutes`, rows growing at #105's measured ~30 rows per sample, and each
 * query's latency generated from a chosen ms-per-1,000-rows slope.
 */
function series(options: {
  loadAt?: (minute: number) => number;
  minutes: number;
  queries: Record<string, { interceptMs: number; msPer1kRows: number }>;
  spikeAt?: { minute: number; ms: number; query: string };
}): Sample[] {
  const samples: Sample[] = [];
  for (let step = 0; step * 0.5 <= options.minutes; step += 1) {
    const elapsedMinutes = step * 0.5;
    const rows = 10_000 + step * 30;
    const searchMs: Record<string, number> = {};
    for (const [query, shape] of Object.entries(options.queries)) {
      searchMs[query] =
        shape.interceptMs + (shape.msPer1kRows * rows) / 1000;
    }
    if (
      options.spikeAt !== undefined &&
      Math.abs(elapsedMinutes - options.spikeAt.minute) < 0.25
    ) {
      searchMs[options.spikeAt.query] = options.spikeAt.ms;
    }
    const one = options.loadAt?.(elapsedMinutes) ?? 5;
    samples.push({
      elapsedMinutes,
      eyeCount: 5,
      load: { fifteen: one, five: one, one },
      missingRss: 0,
      rows,
      searchMs,
      totalRssMiB: 200,
    });
  }
  return samples;
}

describe("pre-registered soak latency rule (#110, judging #109)", () => {
  test("the pre-registration is fixed at the values #105 measured", () => {
    expect(BUCKET_MINUTES).toBe(15);
    expect(WARMUP_MINUTES).toBe(30);
    // src/search/search.ts:105 `PRAGMA busy_timeout = 5000`, not a desk number.
    expect(ABSOLUTE_BACKSTOP_MS).toBe(5_000);
    expect(Object.keys(REGISTERED).sort()).toEqual([
      "provenance cursor",
      "soak traffic",
      "sqlite backlog",
    ]);
    // The flat query deliberately has no numeric bar; the other two do, and
    // each sits at 2x the upper bound of #105's own 95% CI.
    expect(REGISTERED["provenance cursor"]!.barMsPer1kRows).toBeNull();
    expect(REGISTERED["soak traffic"]!.barMsPer1kRows).toBe(5.2);
    expect(REGISTERED["sqlite backlog"]!.barMsPer1kRows).toBe(4.7);
    for (const registration of Object.values(REGISTERED)) {
      if (registration.barMsPer1kRows === null) continue;
      expect(registration.barMsPer1kRows).toBeGreaterThan(
        2 * registration.measuredCiHigh - 0.05,
      );
    }
  });

  test("buckets are 15 minutes wide and start only after the warm-up", () => {
    const buckets = bucketsFor(
      series({
        minutes: 180,
        queries: { "soak traffic": { interceptMs: 0, msPer1kRows: 2 } },
      }),
      "soak traffic",
    );
    // 30-45, 45-60, ... 165-180 plus the closing 180 sample's own bucket.
    expect(buckets.map((bucket) => bucket.startMinute)).toEqual([
      30, 45, 60, 75, 90, 105, 120, 135, 150, 165, 180,
    ]);
    expect(buckets[0]!.rowsThousands).toBeGreaterThan(10);
  });

  test("a sample that could not see all five eyes is excluded, as in analyze.ts", () => {
    const samples = series({
      minutes: 180,
      queries: { "soak traffic": { interceptMs: 0, msPer1kRows: 2 } },
    }).map((sample) => ({ ...sample, eyeCount: 4 }));
    expect(bucketsFor(samples, "soak traffic")).toHaveLength(0);
    expect(judgeQuery(samples, "soak traffic").verdict).toBe(
      "INSUFFICIENT DATA",
    );
  });

  test("#105's own constants pass; the rule does not fail the code that produced it", () => {
    const report = judge(
      series({
        minutes: 180,
        queries: {
          "soak traffic": { interceptMs: -20.5, msPer1kRows: 2.1542 },
          "sqlite backlog": { interceptMs: -4.2, msPer1kRows: 1.5182 },
        },
      }),
    );
    expect(report.verdict).toContain("soak traffic=WITHIN BUDGET");
    expect(report.verdict).toContain("sqlite backlog=WITHIN BUDGET");
  });

  /**
   * The strongest available check: run the committed rule over #105's OWN
   * series, the one that produced the constants. If the bar failed this it
   * would be a bar invented against the current code, which is the specific
   * mistake this ticket exists to avoid.
   *
   * The scratch root is #105's and #109 wants it as a baseline arm, so it is
   * read-only here and may be gone on some future machine — hence the skip
   * rather than a hard dependency.
   */
  test("#105's real series is WITHIN BUDGET on both bars and STILL FLAT on the third", () => {
    const path = "/private/tmp/argus-soak-czkoLx/series.jsonl";
    if (!existsSync(path)) {
      console.log(
        `soak latency: #105 series absent at ${path}; live check SKIPPED`,
      );
      return;
    }
    const report = judge(readSeries(path));
    expect(report.verdict).toBe(
      "provenance cursor=STILL FLAT soak traffic=WITHIN BUDGET sqlite backlog=WITHIN BUDGET",
    );
    const broad = report.queries.find(
      (query) => query.query === "soak traffic",
    )!;
    // #105 §9 quotes 2.132 ms/1k, "around 55k rows" for 100 ms and "~470k
    // rows" for one second. This rule reproduces all three.
    expect(broad.msPer1kRowsOls!).toBeCloseTo(2.15, 1);
    expect(broad.reaches100msAtRows).toBe(56_107);
    expect(broad.reaches1000msAtRows).toBe(473_890);
  });

  test("a doubling of the per-row constant on the broad query is a REGRESSION", () => {
    const judgement = judgeQuery(
      series({
        minutes: 180,
        queries: { "soak traffic": { interceptMs: 0, msPer1kRows: 6 } },
      }),
      "soak traffic",
    );
    expect(judgement.verdict).toBe("REGRESSION");
    expect(judgement.msPer1kRowsOls!).toBeGreaterThan(5.2);
  });

  test("a bar is never applied to a query string nobody pre-registered", () => {
    const judgement = judgeQuery(
      series({
        minutes: 180,
        queries: { "some new query": { interceptMs: 0, msPer1kRows: 99 } },
      }),
      "some new query",
    );
    expect(judgement.verdict).toBe("UNREGISTERED");
    expect(judgement.barMsPer1kRows).toBeNull();
  });

  test("a registered query that #109 does not run is called out, not passed over", () => {
    const report = judge(
      series({
        minutes: 180,
        queries: { "soak traffic": { interceptMs: 0, msPer1kRows: 2 } },
      }),
    );
    expect(report.verdict).toContain("provenance cursor=NOT RUN");
    expect(report.verdict).toContain("sqlite backlog=NOT RUN");
  });

  describe("the per-query asymmetry that must not be flattened", () => {
    test("a load excursion on the flat query is not a corpus finding", () => {
      // Latency rises with LOAD, and load rises with time; rows also rise with
      // time, so a naive fit sees growth. The rule must read the shape.
      // Load oscillates rather than tracking the clock, so it is NOT collinear
      // with rows — which is exactly the situation #105 §9 found for this
      // query (r(rows) -0.070 against r(load1) +0.394).
      const samples = series({
        loadAt: (minute) => 2 + minute / 20 + 4 * Math.sin(minute / 3),
        minutes: 180,
        queries: { "provenance cursor": { interceptMs: 21, msPer1kRows: 0 } },
      }).map((sample, index) => ({
        ...sample,
        searchMs: {
          "provenance cursor":
            21 + sample.load.one * 3 + (index % 7) * 0.05,
        },
      }));
      const judgement = judgeQuery(samples, "provenance cursor");
      expect(judgement.msPer1kRowsCiLow).toBeGreaterThan(0);
      expect(Math.abs(judgement.correlationWithLoad!)).toBeGreaterThan(
        Math.abs(judgement.correlationWithRows!),
      );
      expect(judgement.verdict).toBe("GREW WITH LOAD, NOT CORPUS");
    });

    test("the flat query failing on corpus-shaped growth is still possible", () => {
      const judgement = judgeQuery(
        series({
          loadAt: () => 5,
          minutes: 180,
          queries: { "provenance cursor": { interceptMs: 20, msPer1kRows: 3 } },
        }),
        "provenance cursor",
      );
      expect(judgement.verdict).toBe("NO LONGER FLAT");
    });

    test("the flat query's crossings are null rather than a number to misuse", () => {
      const judgement = judgeQuery(
        series({
          minutes: 180,
          queries: {
            "provenance cursor": { interceptMs: 21, msPer1kRows: 0 },
          },
        }),
        "provenance cursor",
      );
      expect(judgement.verdict).toBe("STILL FLAT");
      expect(judgement.reaches100msAtRows).toBeNull();
      expect(judgement.reaches1000msAtRows).toBeNull();
    });
  });

  test("estimators on opposite sides of the bar are a STRADDLE, not a decision", () => {
    // One extreme bucket drags OLS over the bar while Theil-Sen, which is the
    // median of pairwise slopes, stays under it.
    const samples = series({
      minutes: 180,
      queries: { "sqlite backlog": { interceptMs: 0, msPer1kRows: 1.5 } },
    });
    for (const sample of samples) {
      if (sample.elapsedMinutes >= 165) {
        sample.searchMs = { "sqlite backlog": 900 };
      }
    }
    const judgement = judgeQuery(samples, "sqlite backlog");
    expect(judgement.msPer1kRowsOls!).toBeGreaterThan(4.7);
    expect(judgement.msPer1kRowsTheilSen!).toBeLessThan(4.7);
    expect(judgement.verdict).toBe("STRADDLE");
  });

  test("the absolute backstop is the busy_timeout, and only catastrophe reaches it", () => {
    const clean = judge(
      series({
        minutes: 180,
        queries: { "soak traffic": { interceptMs: 0, msPer1kRows: 2 } },
      }),
    );
    expect(clean.verdict).not.toContain("backstop=BREACHED");

    const hung = judge(
      series({
        minutes: 180,
        queries: { "soak traffic": { interceptMs: 0, msPer1kRows: 2 } },
        spikeAt: { minute: 100, ms: 7_000, query: "soak traffic" },
      }),
    );
    expect(hung.verdict).toContain("backstop=BREACHED(>=5000ms)");
  });

  test("the report names where its argument lives", () => {
    const report = judge(
      series({
        minutes: 180,
        queries: { "soak traffic": { interceptMs: 0, msPer1kRows: 2 } },
      }),
    );
    expect(report.decisionRule.origin).toContain(
      "docs/adr/0003-search-latency-constant-and-budget.md",
    );
    expect(report.decisionRule.origin).toContain("soak.txt");
  });
});
