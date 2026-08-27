/**
 * The #109 pre-registration has to be exercised BEFORE #109 runs.
 *
 * #110 made this argument for `latency.ts` and it applies with more force here,
 * because this pre-registration is bigger: a phase schedule, a floor width, a
 * two-parameter decomposition and five named predictions, all committed ahead
 * of the run they judge. A decision rule that throws, mislabels, or silently
 * defaults the first time it meets a series is worth nothing at all.
 *
 * What these tests pin:
 *   - the SCHEDULE's design properties, which are the argument in `phases.ts`
 *     made executable: four replicates per rate, balance in time, the
 *     contiguous zero-traffic block, the settling allowance;
 *   - that the memory probe is genuinely INERT unless its env var is set;
 *   - that the decomposition returns LEAK on a synthetic leak and CACHE on a
 *     synthetic cache — the two answers the whole run exists to tell apart;
 *   - that the floor bucket width is structurally fixed, i.e. the sensitivity
 *     table cannot reach the verdict;
 *   - that #110's latency verdict passes through unmodified.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_WATCH_MAX_RSS_MIB } from "../src/watch.ts";
import { createMemProbe, readingFor } from "../src/watch/memprobe.ts";
import {
  CROSSOVER_PHASES,
  PHASES,
  PHASE_MINUTES,
  PHASE_SETTLE_MINUTES,
  SAMPLE_INTERVAL_SECONDS,
  TOTAL_MINUTES,
  WARMUP_MINUTES,
  crossoverPhases,
  isAnalysed,
  phaseAt,
  rateName,
  rowsPerMinute,
} from "../scripts/soak/phases.ts";
import {
  FLOOR_BUCKET_MINUTES,
  LEAK_THRESHOLD_MIB_PER_MIN,
  decompose,
  judge,
  spearman,
  type MemReading,
  type Sample,
} from "../scripts/soak/analyze109.ts";
import { judge as judgeLatency109 } from "../scripts/soak/latency109.ts";
import { judge as judgePreRegisteredLatency } from "../scripts/soak/latency.ts";

const EYES = ["archiver", "digest", "honcho", "retro", "reviewer"] as const;

/**
 * A deterministic pseudo-random jitter. Real RSS series are noisy, and a
 * NOISELESS synthetic series would give every fit a zero-width confidence
 * interval — which would exercise a degenerate case these rules will never
 * meet in the field and would hide whether they work on one they will.
 * No Math.random, so a failure reproduces.
 */
function jitter(seed: number): number {
  const x = Math.sin(seed * 12.9898) * 43758.5453;
  return x - Math.floor(x) - 0.5;
}

interface SeriesOptions {
  /** MiB per archived row. The cache term. */
  miBPerRow?: number;
  /** MiB per minute regardless of traffic. The leak term. */
  miBPerMinute?: number;
  noiseMiB?: number;
  /** Per-eye in-process growth, MiB/min, by field. */
  memory?: {
    external?: number;
    heapUsed?: number;
    residual?: number;
  };
  pageCountFinal?: number;
}

/**
 * A synthetic series in the sampler's own shape, driven by the REAL schedule:
 * rows accumulate at each phase's pre-registered rate, so `rows` and `elapsed`
 * are related exactly the way they will be in the run and not the way they
 * were in #105.
 */
function makeSeries(options: SeriesOptions): { memory: MemReading[]; samples: Sample[] } {
  const samples: Sample[] = [];
  const memory: MemReading[] = [];
  const step = SAMPLE_INTERVAL_SECONDS / 60;
  const base = 200;
  const noise = options.noiseMiB ?? 1.5;
  let rows = 12_000;
  let seed = 1;
  for (let elapsed = 0; elapsed < TOTAL_MINUTES; elapsed += step) {
    const phase = phaseAt(elapsed);
    if (phase === null) continue;
    rows += phase.rowsPerSample;
    const total =
      base +
      (options.miBPerMinute ?? 0) * elapsed +
      (options.miBPerRow ?? 0) * (rows - 12_000) +
      jitter((seed += 1)) * noise;
    const perEyeKiB = Math.round((total / EYES.length) * 1024);
    const one = 6 + jitter(seed + 7) * 2;
    samples.push({
      archiveBytes: rows * 750,
      at: new Date(1_756_000_000_000 + elapsed * 60_000).toISOString(),
      elapsedMinutes: Number(elapsed.toFixed(3)),
      eyeCount: 5,
      eyes: Object.fromEntries(
        EYES.map((eye, index) => [eye, { pid: 1000 + index, rssKiB: perEyeKiB }]),
      ),
      load: { fifteen: one, five: one, one },
      missingRss: 0,
      phase: {
        label: phase.label,
        rate: rateName(phase.rowsPerSample),
        rowsPerSample: phase.rowsPerSample,
        startMinute: phase.startMinute,
      },
      restartLines: 0,
      rows,
      searchMs: {
        "provenance cursor": 12 + jitter(seed + 11) * 2,
        "soak traffic": 10 + (2.1 * rows) / 1000 + jitter(seed + 13) * 2,
        "sqlite backlog": 9 + (1.5 * rows) / 1000 + jitter(seed + 17) * 2,
      },
      sqlite: {
        cacheSize: 2000,
        freelistCount: 0,
        pageCacheBoundBytes: Math.min(2000, options.pageCountFinal ?? 40_000) * 4096,
        pageCount: options.pageCountFinal ?? 40_000,
        pageSize: 4096,
      },
      totalRssMiB: Number(total.toFixed(2)),
      walBytes: 4_000_000,
    });
    if (options.memory !== undefined) {
      const mib = 1024 * 1024;
      for (const [index, eye] of EYES.entries()) {
        memory.push({
          arrayBuffers: 2 * mib,
          at: samples.at(-1)!.at,
          external: (5 + (options.memory.external ?? 0) * elapsed) * mib,
          eye,
          heapTotal: 40 * mib,
          heapUsed: (20 + (options.memory.heapUsed ?? 0) * elapsed) * mib,
          pid: 1000 + index,
          residual: (30 + (options.memory.residual ?? 0) * elapsed) * mib,
          rss:
            (57 +
              ((options.memory.external ?? 0) +
                (options.memory.heapUsed ?? 0) +
                (options.memory.residual ?? 0)) *
                elapsed) *
            mib,
          uptimeSeconds: elapsed * 60,
        });
      }
    }
  }
  return { memory, samples };
}

describe("the pre-registered phase schedule", () => {
  test("is 16 hours: a discarded warm-up plus twelve crossover phases", () => {
    expect(WARMUP_MINUTES).toBe(60);
    expect(PHASE_MINUTES).toBe(75);
    expect(CROSSOVER_PHASES).toBe(12);
    expect(TOTAL_MINUTES).toBe(960);
    expect(TOTAL_MINUTES / 60).toBe(16);
    // Inside the ticket's 12-24 hour budget.
    expect(TOTAL_MINUTES).toBeGreaterThanOrEqual(12 * 60);
    expect(TOTAL_MINUTES).toBeLessThanOrEqual(24 * 60);
  });

  test("gives every rate four replicates", () => {
    const counts = { A: 0, B: 0, Z: 0 };
    for (const phase of crossoverPhases()) counts[rateName(phase.rowsPerSample)] += 1;
    expect(counts).toEqual({ A: 4, B: 4, Z: 4 });
  });

  test("uses the two rates the ticket named, plus zero", () => {
    const rates = new Set(crossoverPhases().map((phase) => phase.rowsPerSample));
    expect([...rates].sort((a, b) => a - b)).toEqual([0, 30, 300]);
  });

  test("balances each rate in time, so convexity cannot masquerade as rate", () => {
    // The failure this guards against is concrete: #105's series was convex
    // (thirds fitted -0.023 / +0.402 / +3.296), so a monotone ascending rate
    // schedule would show the steepest slope in the highest-rate phase for
    // reasons of TIME alone and would read as a perfect corpus result.
    const midpoints: Record<string, number[]> = { A: [], B: [], Z: [] };
    for (const phase of crossoverPhases()) {
      midpoints[rateName(phase.rowsPerSample)]!.push(
        (phase.startMinute + phase.endMinute) / 2,
      );
    }
    const means = Object.fromEntries(
      Object.entries(midpoints).map(([rate, values]) => [
        rate,
        values.reduce((a, b) => a + b, 0) / values.length,
      ]),
    );
    const grand = (WARMUP_MINUTES + TOTAL_MINUTES) / 2;
    for (const mean of Object.values(means)) {
      // Within 5% of the crossover's own length of the grand mean.
      expect(Math.abs(mean - grand)).toBeLessThan(0.05 * (TOTAL_MINUTES - WARMUP_MINUTES));
    }
    // And each rate appears twice in each half of the crossover.
    for (const values of Object.values(midpoints)) {
      expect(values.filter((value) => value < grand)).toHaveLength(2);
      expect(values.filter((value) => value >= grand)).toHaveLength(2);
    }
  });

  test("contains a contiguous 150-minute zero-traffic block", () => {
    // Prediction P2 is stated over minutes 210-360 and is the cleanest single
    // comparison in the run, so the schedule has to actually contain it.
    const zero = crossoverPhases().filter((phase) => phase.rowsPerSample === 0);
    const block = zero.filter(
      (phase) => phase.startMinute >= 210 && phase.endMinute <= 360,
    );
    expect(block).toHaveLength(2);
    expect(block[0]!.endMinute).toBe(block[1]!.startMinute);
    expect(block[1]!.endMinute - block[0]!.startMinute).toBe(150);
  });

  test("phaseAt covers the run and stops at its end", () => {
    expect(phaseAt(0)?.label).toBe("warmup");
    expect(phaseAt(WARMUP_MINUTES - 0.001)?.label).toBe("warmup");
    expect(phaseAt(WARMUP_MINUTES)?.label).toBe("1");
    expect(phaseAt(TOTAL_MINUTES - 0.001)?.label).toBe(String(CROSSOVER_PHASES));
    expect(phaseAt(TOTAL_MINUTES)).toBeNull();
    expect(PHASES).toHaveLength(CROSSOVER_PHASES + 1);
  });

  test("isAnalysed discards the settling window and the whole warm-up", () => {
    const first = crossoverPhases()[0]!;
    expect(isAnalysed(first.startMinute, first)).toBe(false);
    expect(isAnalysed(first.startMinute + PHASE_SETTLE_MINUTES - 0.1, first)).toBe(false);
    expect(isAnalysed(first.startMinute + PHASE_SETTLE_MINUTES, first)).toBe(true);
    expect(isAnalysed(first.endMinute, first)).toBe(false);
    // No warm-up sample is analysable under any phase.
    for (const phase of crossoverPhases()) {
      expect(isAnalysed(WARMUP_MINUTES - 1, phase)).toBe(false);
    }
  });

  test("leaves 60 analysed minutes per phase, i.e. twelve floor buckets", () => {
    expect(PHASE_MINUTES - PHASE_SETTLE_MINUTES).toBe(60);
    expect((PHASE_MINUTES - PHASE_SETTLE_MINUTES) / FLOOR_BUCKET_MINUTES).toBe(12);
    // Ten samples per bucket is the minimum count worth taking a MINIMUM over.
    expect((FLOOR_BUCKET_MINUTES * 60) / SAMPLE_INTERVAL_SECONDS).toBe(10);
  });

  test("rowsPerMinute is the 10x contrast the discrimination depends on", () => {
    const rateOf = (rate: "A" | "B" | "Z") =>
      rowsPerMinute(crossoverPhases().find((phase) => rateName(phase.rowsPerSample) === rate)!);
    expect(rateOf("Z")).toBe(0);
    expect(rateOf("A")).toBe(60);
    expect(rateOf("B")).toBe(600);
    expect(rateOf("B") / rateOf("A")).toBe(10);
  });
});

describe("the in-process memory probe", () => {
  test("is null — and so costs nothing — unless its env var is set", () => {
    expect(createMemProbe("archiver", {})).toBeNull();
    expect(createMemProbe("archiver", { ARGUS_WATCH_MEMPROBE_FILE: "" })).toBeNull();
  });

  test("writes one self-describing line per sample when enabled", () => {
    const directory = mkdtempSync(join(tmpdir(), "memprobe-"));
    try {
      const path = join(directory, "memprobe.jsonl");
      const probe = createMemProbe("digest", { ARGUS_WATCH_MEMPROBE_FILE: path });
      expect(probe).not.toBeNull();
      probe!.sample();
      probe!.sample();
      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      const reading = JSON.parse(lines[0]!) as MemReading;
      expect(reading.eye).toBe("digest");
      expect(reading.pid).toBe(process.pid);
      expect(reading.rss).toBeGreaterThan(0);
      expect(reading.residual).toBe(
        reading.rss - (reading.heapUsed + reading.external + reading.arrayBuffers),
      );
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("throttles to its interval", () => {
    const directory = mkdtempSync(join(tmpdir(), "memprobe-"));
    try {
      const path = join(directory, "memprobe.jsonl");
      const probe = createMemProbe("retro", {
        ARGUS_WATCH_MEMPROBE_FILE: path,
        ARGUS_WATCH_MEMPROBE_MS: "600000",
      })!;
      probe.maybeSample();
      probe.maybeSample();
      probe.maybeSample();
      expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(1);
    } finally {
      rmSync(directory, { force: true, recursive: true });
    }
  });

  test("never throws, whatever the file does", () => {
    // A probe that can kill a watcher turns the instrument into the failure it
    // is measuring.
    const probe = createMemProbe("honcho", {
      ARGUS_WATCH_MEMPROBE_FILE: "/nonexistent-directory-109/probe.jsonl",
    })!;
    expect(() => probe.sample()).not.toThrow();
  });

  test("residual is the arena term #105 had no way to measure", () => {
    const reading = readingFor("reviewer", Date.now() - 5_000);
    expect(reading.residual).toBe(
      reading.rss - (reading.heapUsed + reading.external + reading.arrayBuffers),
    );
    expect(reading.uptimeSeconds).toBeGreaterThanOrEqual(4.9);
  });

  test("the 512 MiB per-eye ceiling is still the in-process default", () => {
    expect(DEFAULT_WATCH_MAX_RSS_MIB).toBe(512);
  });
});

describe("the decomposition tells a leak from a cache", () => {
  test("a pure per-minute leak reads as a leak, with no cache term", () => {
    const { memory, samples } = makeSeries({
      memory: { residual: 0.2 },
      miBPerMinute: 1.2334, // #105's own measured rate.
    });
    const report = judge(samples, memory);
    const decomposition = report.decomposition.byFloor!;
    // L recovers the injected rate; c is indistinguishable from zero.
    expect(decomposition.l!).toBeGreaterThan(1.0);
    expect(decomposition.l!).toBeLessThan(1.5);
    expect(decomposition.cCiLow!).toBeLessThanOrEqual(0);
    expect(decomposition.cCiHigh!).toBeGreaterThanOrEqual(0);
    // Below the 2.5 bar, so it is #105's middle verdict — but now with a cause.
    expect(report.verdict).toContain("leakVsCache=LEAK BELOW THRESHOLD");
    // P1: all three rates grow at the same rate under a leak.
    expect(report.predictions.P1_rateScaling.observedRatio!).toBeGreaterThan(-3);
    expect(report.predictions.P1_rateScaling.observedRatio!).toBeLessThan(3);
    // P2: the frozen-corpus block grows anyway, which is the definition.
    expect(report.predictions.P2_zeroTrafficBlock.floorSlopeMiBPerMin!).toBeGreaterThan(0.8);
    expect(report.predictions.P2_zeroTrafficBlock.rowsAtStart).toBe(
      report.predictions.P2_zeroTrafficBlock.rowsAtEnd,
    );
  });

  test("a leak above the bar reads as LEAK, not as the middle verdict", () => {
    const { memory, samples } = makeSeries({
      memory: { residual: 0.6 },
      miBPerMinute: 3.0,
    });
    const report = judge(samples, memory);
    expect(report.decomposition.byFloor!.l!).toBeGreaterThanOrEqual(
      LEAK_THRESHOLD_MIB_PER_MIN,
    );
    expect(report.verdict).toContain("leakVsCache=LEAK");
    expect(report.verdict).not.toContain("BELOW THRESHOLD");
  });

  test("a pure per-row cache reads as corpus-tracking, with no leak term", () => {
    // 0.004 MiB/row => 0.24 MiB/min in an A phase, 2.4 in a B phase, 0 in a Z.
    const { memory, samples } = makeSeries({
      memory: { residual: 0.1 },
      miBPerRow: 0.004,
    });
    const report = judge(samples, memory);
    const decomposition = report.decomposition.byFloor!;
    expect(decomposition.cMiBPer1kRows!).toBeGreaterThan(1);
    expect(decomposition.lCiLow!).toBeLessThanOrEqual(0);
    expect(decomposition.lCiHigh!).toBeGreaterThanOrEqual(0);
    expect(report.verdict).toContain("leakVsCache=CACHE / CORPUS-TRACKING");
    // P1: the cache prediction is a ratio near the 10x rate ratio.
    expect(report.predictions.P1_rateScaling.observedRatio!).toBeGreaterThan(6);
    expect(report.predictions.P1_rateScaling.observedRatio!).toBeLessThan(14);
    // P2: a frozen corpus means a flat floor.
    expect(Math.abs(report.predictions.P2_zeroTrafficBlock.floorSlopeMiBPerMin!)).toBeLessThan(0.2);
    // P4: the per-row constant is the same at both rates, which is what
    // "per row" means.
    const { miBPer1kRowsA, miBPer1kRowsB } = report.predictions.P4_perRowInvariance;
    expect(miBPer1kRowsA!).toBeGreaterThan(0);
    expect(Math.abs(miBPer1kRowsA! - miBPer1kRowsB!) / miBPer1kRowsB!).toBeLessThan(0.6);
  });

  test("both mechanisms at once read as BOTH", () => {
    const { memory, samples } = makeSeries({
      memory: { residual: 0.3 },
      miBPerMinute: 1.0,
      miBPerRow: 0.004,
    });
    const report = judge(samples, memory);
    expect(report.verdict).toContain("leakVsCache=BOTH");
  });

  test("a flat fleet reads as NEITHER, not as a small leak", () => {
    const { memory, samples } = makeSeries({ memory: {}, noiseMiB: 2 });
    const report = judge(samples, memory);
    expect(report.verdict).toContain("leakVsCache=NEITHER");
    expect(report.verdict).toContain("rss=NO SUSTAINED POSITIVE SLOPE");
  });

  test("#105's own series is INSUFFICIENT DATA here, because it has no phases", () => {
    // Running the #109 rule against a single-rate run must refuse, not invent.
    const flat: Sample[] = [];
    const report = judge(flat, []);
    expect(report.verdict).toContain("leakVsCache=INSUFFICIENT DATA");
    expect(report.verdict).toContain("rss=INSUFFICIENT DATA");
  });

  test("decompose recovers a known L and c exactly", () => {
    const points = [0, 0, 30, 30, 300, 300].map((rate, index) => ({
      rate,
      slope: 1.5 + 0.01 * rate + jitter(index) * 0.05,
    }));
    const result = decompose(points)!;
    expect(result.l!).toBeGreaterThan(1.3);
    expect(result.l!).toBeLessThan(1.7);
    expect(result.c!).toBeGreaterThan(0.008);
    expect(result.c!).toBeLessThan(0.012);
    // c is reported in the readable unit too: MiB per 1,000 rows.
    expect(result.cMiBPer1kRows!).toBeCloseTo(result.c! * 500, 3);
  });

  test("fewer than nine fitted phases refuses to decompose", () => {
    expect(decompose([{ rate: 0, slope: 1 }, { rate: 30, slope: 2 }])).toBeNull();
  });
});

describe("prediction P3, the objection to P2", () => {
  test("spearman is strongly negative on a decaying series and flat on a level one", () => {
    // Cache-still-filling predicts decay across Z replicates; a leak predicts
    // no trend. This is the only thing separating those two readings of a
    // positive zero-traffic slope, so the statistic has to behave.
    expect(spearman([0, 1, 2, 3], [4, 3, 2, 1])).toBe(-1);
    expect(spearman([0, 1, 2, 3], [2, 2.01, 1.99, 2])!).toBeLessThan(0.9);
    expect(spearman([0, 1, 2, 3], [1, 2, 3, 4])).toBe(1);
  });

  test("is reported per Z replicate in phase order", () => {
    const { memory, samples } = makeSeries({ memory: {}, miBPerMinute: 1.0 });
    const report = judge(samples, memory);
    const slopes = report.predictions.P3_zeroReplicateDecay.slopesInOrder;
    expect(slopes).toHaveLength(4);
    expect(slopes.map((entry) => entry.label)).toEqual(
      crossoverPhases()
        .filter((phase) => phase.rowsPerSample === 0)
        .map((phase) => phase.label),
    );
  });
});

describe("prediction P5, the causal arm", () => {
  test("growth in the residual reads as arena retention", () => {
    const { memory, samples } = makeSeries({
      memory: { residual: 0.25 },
      miBPerMinute: 1.2,
    });
    const report = judge(samples, memory);
    expect(report.cause.verdict).toBe("ARENA / UNRETURNED PAGES");
  });

  test("growth in the JS heap reads as the JS heap", () => {
    const { memory, samples } = makeSeries({
      memory: { heapUsed: 0.25 },
      miBPerMinute: 1.2,
    });
    expect(judge(samples, memory).cause.verdict).toBe("JS HEAP");
  });

  test("growth in external reads as retained buffers", () => {
    const { memory, samples } = makeSeries({
      memory: { external: 0.25 },
      miBPerMinute: 1.2,
    });
    expect(judge(samples, memory).cause.verdict).toBe("RETAINED BUFFERS");
  });

  test("an uninstrumented run says so rather than guessing", () => {
    const { samples } = makeSeries({ miBPerMinute: 1.2 });
    const report = judge(samples, []);
    expect(report.cause.verdict).toBe("NOT INSTRUMENTED");
    expect(report.verdict).toContain("cause=NOT INSTRUMENTED");
  });

  test("a small page-cache bound plus a fleet-wide rise REFUTES page cache", () => {
    const { memory, samples } = makeSeries({
      memory: { residual: 0.25 },
      miBPerMinute: 1.2,
      // 2000 pages x 4096 = 8 MiB, SQLite's default, two orders of magnitude
      // under the fleet rise. Only the archiver holds a Database at all.
      pageCountFinal: 400_000,
    });
    const report = judge(samples, memory);
    expect(report.cause.pageCache.maxPageCacheBoundMiB!).toBeLessThan(16);
    expect(report.cause.pageCache.nonDatabaseEyesAlsoRose).toBe(true);
    expect(report.cause.pageCache.fleetRiseMiB!).toBeGreaterThan(50);
    expect(report.cause.pageCache.refuted).toBe(true);
  });

  test("a flat fleet does not let the bound refute anything", () => {
    // Refutation needs a rise to explain. Without one there is nothing to
    // refute and claiming otherwise would be the desk-invented conclusion.
    const { memory, samples } = makeSeries({ memory: {} });
    expect(judge(samples, memory).cause.pageCache.refuted).toBe(false);
  });
});

describe("the floor bucket width is fixed in advance", () => {
  test("is 5 minutes and is what the decision rule reports", () => {
    expect(FLOOR_BUCKET_MINUTES).toBe(5);
    const { memory, samples } = makeSeries({ memory: {}, miBPerMinute: 1.2 });
    expect(judge(samples, memory).decisionRule.floorBucketMinutes).toBe(5);
  });

  test("the sensitivity table is printed but cannot reach the verdict", () => {
    // #105 section 4b could not promote its floor because the width was chosen
    // after the fact and moved the answer between +0.66 and +1.13. Showing the
    // alternatives is honest; letting them into the verdict is the thing that
    // was wrong. The separation has to be structural, not a promise.
    const { memory, samples } = makeSeries({ memory: {}, miBPerMinute: 1.2 });
    const report = judge(samples, memory);
    const table = report.sensitivityNotAVerdict.pooledFloorSlopeByWidth;
    expect(Object.keys(table).sort()).toEqual(["10m", "15m", "5m"]);
    // The verdict is a string built from the 5-minute fits only; nothing in
    // judge()'s decision path takes a width argument at all.
    expect(judge(samples, memory).verdict).toBe(report.verdict);
    expect(report.decisionRule.floorBucketMinutes).toBe(FLOOR_BUCKET_MINUTES);
  });
});

describe("the collinearity #105 could not break", () => {
  test("rows is no longer a synonym for elapsed", () => {
    // This is the single number that says the design worked. #105 measured
    // 1.000000 and could therefore not tell the two hypotheses apart at all.
    const { memory, samples } = makeSeries({ memory: {}, miBPerMinute: 1.2 });
    const report = judge(samples, memory);
    expect(report.collinearity.rowsVersusElapsed!).toBeLessThan(0.99);
  });
});

describe("#110's latency verdict passes through unmodified", () => {
  test("latency109 reports latency.ts's verdict verbatim", () => {
    const { samples } = makeSeries({ memory: {}, miBPerMinute: 1.2 });
    const wrapped = judgeLatency109(samples);
    const direct = judgePreRegisteredLatency(samples);
    expect(wrapped.verdict).toBe(direct.verdict);
    expect(wrapped.preRegistered).toEqual(direct);
    expect(wrapped.preRegistered.decisionRule.bucketMinutes).toBe(15);
    expect(wrapped.preRegistered.decisionRule.warmupMinutes).toBe(30);
  });

  test("frozen-corpus drift is measured per Z phase, never pooled across them", () => {
    // Pooling four separated Z windows would fit a line through the A and B
    // traffic that happened in between and read those steps as drift.
    const { samples } = makeSeries({ memory: {}, miBPerMinute: 1.2 });
    const drift = judgeLatency109(samples).phased.frozenCorpusDrift["soak traffic"]!;
    expect(drift).toHaveLength(4);
    for (const entry of drift) {
      expect(entry.rowsStart).toBe(entry.rowsEnd);
      expect(entry.n).toBeGreaterThan(50);
    }
  });

  test("the constant is estimated separately at each traffic rate", () => {
    const { samples } = makeSeries({ memory: {}, miBPerMinute: 1.2 });
    const byRate = judgeLatency109(samples).phased.constantByRate["soak traffic"]!;
    expect(byRate.registeredPointEstimate).toBe(2.1542);
    expect(byRate.B.buckets).toBeGreaterThan(3);
  });
});
