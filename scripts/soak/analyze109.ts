/**
 * THE PRE-REGISTERED VERDICT FOR #109. Committed BEFORE the run it judges.
 *
 * `analyze.ts` (#105) is NOT edited and NOT imported for its verdict: that
 * file is a record, its output has to stay byte-for-byte reproducible, and
 * #110's `latency.ts` set the precedent by refusing to touch it for the same
 * reason. This file re-implements the same machinery — the usability filter,
 * OLS with a 95% CI, Theil-Sen as the outlier-immune second opinion, the
 * agreement rule, the PID-change restart detector — and adds exactly what a
 * PHASED run needs and a single-rate run did not.
 *
 * Run it against #109's series and it judges #109. Run it against #105's
 * series and it says INSUFFICIENT DATA for everything phase-shaped, because
 * #105 has no phases; that is correct behaviour, not a gap.
 *
 * ===========================================================================
 * 1. WHAT IS ACTUALLY BEING DECIDED
 * ===========================================================================
 * #105 returned the middle verdict — `rss=POSITIVE BUT BELOW THRESHOLD`,
 * +1.2334 MiB/min warmed, CI [+1.1161, +1.3508], Theil-Sen +1.2900 — and then
 * spent §7 explaining that it could not say WHY, because `rows ~ elapsed` was
 * r = 1.000000. "Leaks per minute" and "caches per row" were the same claim.
 *
 * So #109's primary question is NOT "how big is the slope". It is:
 *
 *     Of the growth #105 measured, how much is driven by TIME and how much by
 *     ROWS — and if any of it is driven by time, what is it made of?
 *
 * The headline slope is still computed and still judged against #105's 2.5
 * MiB/min bar, unchanged, so the two runs are comparable. But a phased run's
 * overall slope is a MIXTURE of three traffic rates and is not the right
 * primary statistic for this design. THE VERDICT OF #109 IS THE DECOMPOSITION.
 *
 * ===========================================================================
 * 2. THE MODEL, AND WHY IT IS THE SIMPLEST ONE THAT ANSWERS THE QUESTION
 * ===========================================================================
 * Each of the 12 crossover phases (./phases.ts) yields ONE number: the slope
 * of its floor series over its 60 analysed minutes, in MiB/min. Call it f_p,
 * and let r_p be that phase's known, pre-registered rate in rows per sample
 * (0, 30 or 300). Then fit, over the 12 points:
 *
 *     f_p  =  L  +  c * r_p
 *
 *   L  MiB/min of growth that does NOT stop when the traffic stops. Units and
 *      meaning are identical to #105's headline slope, which is why it is
 *      judged against the SAME 2.5 MiB/min bar rather than a freshly invented
 *      one. This is the leak term.
 *   c  MiB/min per row-per-sample. At two samples per minute this is
 *      500 * c MiB per 1,000 rows. This is the cache/corpus term.
 *
 * It is a two-parameter fit on 12 points with the predictor fixed by design at
 * three well-separated levels and four replicates each. Nothing about it is
 * chosen after the fact: the levels, the replicate count, the order, the
 * settling allowance and the bucket width are all in `phases.ts` and in the
 * constants below, all committed before sample 1.
 *
 * WHY THE FLOOR AND NOT THE MEAN. #105 §4b invented the floor mid-run and then
 * correctly refused to let it overturn anything, for two stated reasons: the
 * bucket width was a free parameter (the answer moved between +0.66 and +1.13
 * across four width-by-warm-up combinations), and n was tiny. Both are fixed
 * here — the width is pinned below and argued, and there are 12 buckets per
 * phase instead of six per run. What made it worth promoting is what #105 §5c
 * found: over the warmed window the floor rose ~+1.1 MiB/min while the peak
 * rose ~+0.8, so the TROUGH is where the signal is cleanest. A trough is also
 * the right statistic under the specific confound this machine has: #105 §7
 * Test 2 measured -1.035 MiB of fleet RSS per unit of load1, i.e. macOS
 * compresses pages under pressure and faults them back when it lifts. That
 * moves the peak far more than it moves the floor.
 *
 * THE MEAN-FIT VERSION IS ALSO COMPUTED AND REPORTED. If the floor-based and
 * mean-based decompositions disagree in sign, the verdict is DISAGREEMENT.
 * Reporting only whichever one reads better is the move this whole
 * pre-registration exists to make unavailable.
 *
 * ===========================================================================
 * 3. THE FLOOR BUCKET WIDTH: 5 MINUTES, FIXED IN ADVANCE
 * ===========================================================================
 * This is the parameter the ticket singles out, so here is the whole argument.
 *
 * The analysis unit in this design is ONE PHASE'S 60 ANALYSED MINUTES, not the
 * whole run. A floor slope has to be fittable INSIDE one phase, which sets the
 * width from both ends:
 *
 *   UPPER BOUND. #105's widths were 15 and 30 minutes. 30 minutes would give
 *   two buckets per phase — not a regression. 15 would give four, which is the
 *   bare minimum and leaves a fit with 2 degrees of freedom. Both are ruled
 *   out by arithmetic, not by taste.
 *
 *   LOWER BOUND. The floor is a MINIMUM over the samples in a bucket, and a
 *   minimum over too few draws is just a noisy sample. At the 30-second
 *   interval, a 5-minute bucket contains 10 samples. Ten is the smallest count
 *   worth taking a minimum of; 2-minute buckets would take it over four, where
 *   the statistic stops being a trough and becomes a jittery low reading.
 *
 *   AND THE PHYSICAL ARGUMENT. The trough exists to skip transient peaks, and
 *   the transients here are macOS reclaim and compressor cycles, which operate
 *   on seconds to a couple of minutes. A 5-minute window brackets at least one
 *   full reclaim opportunity, so each bucket's minimum is "how low did the
 *   fleet get back down to once it had the chance".
 *
 * 5 minutes gives 12 buckets per phase — the same bucket COUNT #105's
 * 15-minute width produced over its whole 180-minute run, which is the count
 * this harness has the most experience fitting, rescaled to the new unit.
 *
 * FIXED MEANS FIXED. `FLOOR_BUCKET_MINUTES` is the ONLY width any verdict
 * field is computed from, structurally: `judge()` reads the constant and no
 * caller can pass a different one. A sensitivity table at 5 / 10 / 15 minutes
 * IS printed, under `sensitivityNotAVerdict`, because hiding it would be worse
 * — but nothing in `verdict` is derived from it, which is exactly the
 * separation #105 §4b said a promoted floor would need.
 *
 * ===========================================================================
 * 4. THE FALSIFIABLE PREDICTIONS, WRITTEN DOWN NOW
 * ===========================================================================
 * All five are computed by this file and printed under `predictions`, each
 * next to what was predicted, so a reader compares rather than reconstructs.
 *
 * P1 — RATE SCALING. The primary discriminator.
 *     CACHE: f_Z ~ 0 and f_B / f_A ~ 10, the rate ratio 300:30.
 *     LEAK:  f_Z ~ f_A ~ f_B, ratio ~ 1, because a leak does not care how many
 *            rows arrive.
 *     Statistic: (f_B - f_Z) / (f_A - f_Z), predicted 10 under cache and
 *     ill-conditioned-around-1 under leak.
 *
 * P2 — THE ZERO-TRAFFIC BLOCK. Phases 3 and 4 are both Z, a CONTIGUOUS
 *     150-MINUTE window at minutes 210-360 with a completely frozen corpus,
 *     as long as #105's entire warmed window.
 *     CACHE: floor slope flat, 95% CI containing zero.
 *     LEAK:  at #105's measured +1.2334 MiB/min that block gains +185 MiB.
 *     There is no third thing 185 MiB could be. This is the single cleanest
 *     comparison in the run.
 *
 * P3 — Z-REPLICATE DECAY. The one honest objection to P2 is that a cache could
 *     still be FILLING against a frozen corpus, having not yet reached steady
 *     state, which would look like a leak. That hypothesis makes its own
 *     prediction and it is testable: each successive Z phase starts from a
 *     larger already-cached corpus, so
 *     CACHE-STILL-FILLING: the four Z-phase slopes DECAY monotonically,
 *            f_Z(3) > f_Z(4) > f_Z(8) > f_Z(10). Spearman rank correlation
 *            against replicate order strongly negative.
 *     LEAK:  no trend across replicates. Spearman ~ 0.
 *     This is why four Z replicates were bought instead of one long one.
 *
 * P4 — PER-ROW INVARIANCE. The same data in the other unit, as a cross-check
 *     that must agree with P1 or something is wrong with the fit.
 *     Let g_p = f_p / (rows added per minute in phase p).
 *     CACHE: g_A ~ g_B, a constant MiB per row; g_Z undefined (0/0).
 *     LEAK:  g_B ~ g_A / 10, because the same MiB/min is spread over 10x rows.
 *
 * P5 — WHAT IT IS MADE OF. The causal arm, from `memprobe.jsonl`
 *     (`src/watch/memprobe.ts`). Per eye, over the analysed window:
 *     SQLITE PAGE CACHE is REFUTED — not merely unsupported — if fleet RSS
 *            rises materially while (a) the archiver's recorded page-cache
 *            UPPER BOUND stays small, and (b) the four eyes that never open a
 *            Database rise too. `src/eyes/archiver/archiver.ts:58` is the only
 *            `new Database` on any watcher path, so page cache can only exist
 *            in ONE of five processes, and its size is bounded by
 *            min(cache_size, page_count) * page_size, which the sampler
 *            records every 30 s. A bound cannot confirm the hypothesis; it can
 *            kill it, and killing one of #105 §7(4)'s three candidates is
 *            progress.
 *     JS HEAP is the cause if heapUsed rises with rss across eyes.
 *     RETAINED BUFFERS if external + arrayBuffers does.
 *     ARENA / UNRETURNED PAGES if NONE of them does while rss climbs — the
 *            residual, rss - (heapUsed + external + arrayBuffers), is the term
 *            #105 had no way to measure and is the "arena that will not return
 *            pages" hypothesis made numeric.
 *
 * ===========================================================================
 * 5. THE DECISION RULES, FIXED
 * ===========================================================================
 * rss= (unchanged from #105, for comparability, over the analysed window)
 *     LEAK                        OLS >= 2.5 AND CI excludes zero AND
 *                                 Theil-Sen agrees in sign
 *     POSITIVE BUT BELOW THRESHOLD CI excludes zero, Theil-Sen agrees, OLS < 2.5
 *     NO SUSTAINED POSITIVE SLOPE  otherwise
 *     INSUFFICIENT DATA            fewer than 10 analysed samples
 *
 * leakVsCache= (the primary verdict of #109)
 *     LEAK              L's 95% CI excludes zero and is positive, AND the
 *                       model-free pooled Z slope's CI excludes zero and is
 *                       positive, AND L >= 2.5 MiB/min
 *     LEAK BELOW THRESHOLD  as LEAK but L < 2.5. #105's middle verdict, now
 *                       with a CAUSE attached instead of an ambiguity
 *     CACHE / CORPUS-TRACKING  c's CI excludes zero and is positive, AND L's CI
 *                       contains zero, AND the pooled Z CI contains zero
 *     BOTH              both L and c CIs exclude zero and both are positive
 *     NEITHER           both CIs contain zero
 *     DISAGREEMENT      OLS and Theil-Sen on L differ in sign, OR the floor
 *                       and mean decompositions differ in sign on L, OR the
 *                       model L and the model-free pooled Z differ in sign
 *     INSUFFICIENT DATA fewer than 9 of 12 phases produced a floor fit
 *
 * DISAGREEMENT IS A VERDICT, not a thing to be resolved in favour of whichever
 * side is convenient. #105 §3 reported its own final-hour straddle that way and
 * #110 built the same clause into `latency.ts`; this is the third instance of
 * the same rule and it is deliberate.
 *
 * WHY L REUSES THE 2.5 BAR RATHER THAN GETTING ITS OWN. L is denominated in
 * fleet MiB/min, exactly as #105's headline was, and it means the same physical
 * thing: growth that does not stop. #105's argument for 2.5 — 0.5 MiB/min/eye,
 * 400x smaller than #86's ~200 MiB/min/eye, and still enough to reach the
 * 512 MiB ceiling from a healthy ~50 MiB baseline inside a day — applies
 * unchanged to the time term. Deriving a second, different number for the same
 * quantity would be inventing one, which is the move this file exists to
 * prevent.
 */
import { readFileSync } from "node:fs";

import {
  CROSSOVER_PHASES,
  PHASE_MINUTES,
  PHASE_SETTLE_MINUTES,
  TOTAL_MINUTES,
  WARMUP_MINUTES,
  crossoverPhases,
  isAnalysed,
  rateName,
  rowsPerMinute,
  type Phase,
} from "./phases.ts";

/**
 * FIXED IN ADVANCE. The only width any verdict field is computed from.
 * See section 3 of the docblock for the whole argument.
 */
export const FLOOR_BUCKET_MINUTES = 5;
/** #105's bar, unchanged, for both the headline slope and the time term L. */
export const LEAK_THRESHOLD_MIB_PER_MIN = 2.5;
/** Widths printed for the reader's eyes only; no verdict reads them. */
const SENSITIVITY_WIDTHS = [5, 10, 15] as const;
/** Below this many phases with a floor fit, the decomposition is not attempted. */
const MIN_PHASES_FOR_DECOMPOSITION = 9;
/**
 * The archiver's page-cache upper bound above which "SQLite page cache" stops
 * being refutable. SQLite's default cache is 2,000 pages or 2,000 KiB
 * depending on build — single-digit MiB either way. 16 MiB is generous room
 * above both, and is still two orders of magnitude below the ~200 MiB fleet
 * rise #105 saw, so a bound under it cannot explain that rise.
 */
const PAGE_CACHE_REFUTATION_CEILING_BYTES = 16 * 1024 * 1024;
/** Fleet RSS rise over the analysed window that makes P5's refutation meaningful. */
const MATERIAL_RISE_MIB = 50;

const EYES = ["archiver", "digest", "honcho", "retro", "reviewer"] as const;
/** The one eye holding a Database; src/eyes/archiver/archiver.ts:58. */
const DATABASE_EYE = "archiver";

export interface SqliteShape {
  cacheSize: number | null;
  freelistCount: number | null;
  pageCacheBoundBytes: number | null;
  pageCount: number | null;
  pageSize: number | null;
}

export interface Sample {
  archiveBytes: number | null;
  at: string;
  elapsedMinutes: number;
  eyeCount: number;
  eyes: Record<string, { pid: number; rssKiB: number | null }>;
  load: { fifteen: number; five: number; one: number };
  missingRss: number;
  phase: {
    label: string;
    rate: string;
    rowsPerSample: number;
    startMinute: number;
  } | null;
  restartLines: number | null;
  rows: number | null;
  searchMs: Record<string, number> | null;
  sqlite: SqliteShape | null;
  totalRssMiB: number;
  walBytes: number | null;
}

export interface MemReading {
  arrayBuffers: number;
  at: string;
  external: number;
  eye: string;
  heapTotal: number;
  heapUsed: number;
  pid: number;
  residual: number;
  rss: number;
  uptimeSeconds: number;
}

// ---------------------------------------------------------------------------
// Estimators. Same shapes as analyze.ts, re-implemented rather than imported
// so that file stays a sealed record.
// ---------------------------------------------------------------------------

export interface Fit {
  ciHigh: number;
  ciLow: number;
  intercept: number;
  n: number;
  slope: number;
  stdError: number;
}

export function ols(xs: readonly number[], ys: readonly number[]): Fit | null {
  const n = xs.length;
  if (n < 3) return null;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sxx += (xs[i]! - meanX) ** 2;
    sxy += (xs[i]! - meanX) * (ys[i]! - meanY);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  let sse = 0;
  for (let i = 0; i < n; i += 1) sse += (ys[i]! - (intercept + slope * xs[i]!)) ** 2;
  const stdError = Math.sqrt(sse / (n - 2) / sxx);
  const t = tCritical(n - 2);
  return {
    ciHigh: slope + t * stdError,
    ciLow: slope - t * stdError,
    intercept,
    n,
    slope,
    stdError,
  };
}

/**
 * Two-sided 95% t. #105 used the flat 1.96 normal approximation and said why:
 * with hundreds of samples the correction is in the third decimal. This file
 * fits 12-point and 4-point regressions, where t(10) = 2.228 and t(3) = 3.182
 * are NOT third-decimal corrections — using 1.96 there would report a CI
 * materially narrower than the truth and make every "CI excludes zero" clause
 * fire too easily. The headline sample-level fits are unaffected either way.
 */
export function tCritical(df: number): number {
  const table: Record<number, number> = {
    1: 12.706, 2: 4.303, 3: 3.182, 4: 2.776, 5: 2.571,
    6: 2.447, 7: 2.365, 8: 2.306, 9: 2.262, 10: 2.228,
    11: 2.201, 12: 2.179, 15: 2.131, 20: 2.086, 30: 2.042,
  };
  if (df <= 0) return Number.POSITIVE_INFINITY;
  if (table[df] !== undefined) return table[df]!;
  if (df < 15) return table[10]!;
  if (df < 20) return table[15]!;
  if (df < 30) return table[20]!;
  if (df < 60) return table[30]!;
  return 1.96;
}

export function theilSen(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const slopes: number[] = [];
  const step = Math.max(1, Math.floor(n / 300));
  for (let i = 0; i < n; i += step) {
    for (let j = i + step; j < n; j += step) {
      const dx = xs[j]! - xs[i]!;
      if (dx !== 0) slopes.push((ys[j]! - ys[i]!) / dx);
    }
  }
  if (slopes.length === 0) return null;
  slopes.sort((a, b) => a - b);
  const middle = Math.floor(slopes.length / 2);
  return slopes.length % 2 === 0
    ? (slopes[middle - 1]! + slopes[middle]!) / 2
    : slopes[middle]!;
}

export function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i += 1) {
    sxy += (xs[i]! - meanX) * (ys[i]! - meanY);
    sxx += (xs[i]! - meanX) ** 2;
    syy += (ys[i]! - meanY) ** 2;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

function ranks(values: readonly number[]): number[] {
  const order = values
    .map((value, index) => ({ index, value }))
    .sort((a, b) => a.value - b.value);
  const out = new Array<number>(values.length);
  let i = 0;
  while (i < order.length) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]!.value === order[i]!.value) j += 1;
    const rank = (i + j) / 2 + 1;
    for (let k = i; k <= j; k += 1) out[order[k]!.index] = rank;
    i = j + 1;
  }
  return out;
}

/** Spearman rank correlation. P3 is stated in ranks, so it is measured in ranks. */
export function spearman(xs: readonly number[], ys: readonly number[]): number | null {
  if (xs.length < 3) return null;
  return pearson(ranks(xs), ranks(ys));
}

export function round(value: number | null, places = 4): number | null {
  return value === null || !Number.isFinite(value) ? null : Number(value.toFixed(places));
}

/** Mean with a t-based 95% CI. Used for the model-free pooled per-rate slopes. */
export function meanWithCi(values: readonly number[]): {
  ciHigh: number | null;
  ciLow: number | null;
  mean: number | null;
  n: number;
  sd: number | null;
} {
  const n = values.length;
  if (n === 0) return { ciHigh: null, ciLow: null, mean: null, n: 0, sd: null };
  const mean = values.reduce((a, b) => a + b, 0) / n;
  if (n === 1) return { ciHigh: null, ciLow: null, mean, n, sd: null };
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const sd = Math.sqrt(variance);
  const half = tCritical(n - 1) * (sd / Math.sqrt(n));
  return { ciHigh: mean + half, ciLow: mean - half, mean, n, sd };
}

// ---------------------------------------------------------------------------
// The floor metric.
// ---------------------------------------------------------------------------

export interface FloorPoint {
  centreMinute: number;
  floorMiB: number;
  n: number;
  peakMiB: number;
}

/**
 * Bucket minima within one phase's ANALYSED window. Buckets are anchored to
 * the PHASE start, not to the run start, so every phase is bucketed the same
 * way relative to its own boundary and a phase's first bucket is never a
 * half-bucket straddling the settling cut.
 */
export function floorSeries(
  samples: readonly Sample[],
  phase: Phase,
  widthMinutes: number,
): FloorPoint[] {
  const inWindow = samples.filter((sample) => isAnalysed(sample.elapsedMinutes, phase));
  const grouped = new Map<number, number[]>();
  for (const sample of inWindow) {
    const offset = sample.elapsedMinutes - phase.startMinute;
    const bucket = Math.floor(offset / widthMinutes);
    const list = grouped.get(bucket) ?? [];
    list.push(sample.totalRssMiB);
    grouped.set(bucket, list);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a - b)
    .map(([bucket, values]) => ({
      centreMinute: phase.startMinute + bucket * widthMinutes + widthMinutes / 2,
      floorMiB: Math.min(...values),
      n: values.length,
      peakMiB: Math.max(...values),
    }));
}

export interface PhaseFit {
  analysedSamples: number;
  buckets: number;
  /** Floor slope, MiB/min. The primary per-phase number. */
  floorSlope: number | null;
  floorCiHigh: number | null;
  floorCiLow: number | null;
  floorTheilSen: number | null;
  label: string;
  /** Mean-fit slope over raw analysed samples, MiB/min. The cross-check. */
  meanSlope: number | null;
  medianLoadOne: number | null;
  /** MiB per 1,000 rows implied by this phase; null for the Z phases. */
  miBPer1kRows: number | null;
  rate: "A" | "B" | "Z";
  rowsPerMinute: number;
  rowsPerSample: number;
  startMinute: number;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1]! + sorted[middle]!) / 2
    : sorted[middle]!;
}

export function fitPhase(samples: readonly Sample[], phase: Phase): PhaseFit {
  const inWindow = samples.filter((sample) => isAnalysed(sample.elapsedMinutes, phase));
  const floor = floorSeries(samples, phase, FLOOR_BUCKET_MINUTES);
  const floorFit = ols(
    floor.map((point) => point.centreMinute),
    floor.map((point) => point.floorMiB),
  );
  const meanFit = ols(
    inWindow.map((sample) => sample.elapsedMinutes),
    inWindow.map((sample) => sample.totalRssMiB),
  );
  const perMinute = rowsPerMinute(phase);
  return {
    analysedSamples: inWindow.length,
    buckets: floor.length,
    floorCiHigh: round(floorFit?.ciHigh ?? null),
    floorCiLow: round(floorFit?.ciLow ?? null),
    floorSlope: round(floorFit?.slope ?? null),
    floorTheilSen: round(
      theilSen(
        floor.map((point) => point.centreMinute),
        floor.map((point) => point.floorMiB),
      ),
    ),
    label: phase.label,
    meanSlope: round(meanFit?.slope ?? null),
    medianLoadOne: round(median(inWindow.map((sample) => sample.load.one)), 2),
    miBPer1kRows:
      floorFit === null || perMinute === 0
        ? null
        : round((floorFit.slope / perMinute) * 1000),
    rate: rateName(phase.rowsPerSample),
    rowsPerMinute: perMinute,
    rowsPerSample: phase.rowsPerSample,
    startMinute: phase.startMinute,
  };
}

// ---------------------------------------------------------------------------
// The decomposition: f_p = L + c * rate_p.
// ---------------------------------------------------------------------------

export interface Decomposition {
  /** MiB/min per row-per-sample, with CI. The cache term. */
  c: number | null;
  cCiHigh: number | null;
  cCiLow: number | null;
  /** 500 * c: MiB per 1,000 archived rows, the readable form of c. */
  cMiBPer1kRows: number | null;
  /** MiB/min not explained by traffic, with CI. The leak term. */
  l: number | null;
  lCiHigh: number | null;
  lCiLow: number | null;
  n: number;
  /** Theil-Sen on the same 12 points, intercept taken at the median. */
  theilSenC: number | null;
  theilSenL: number | null;
}

export function decompose(
  points: ReadonlyArray<{ rate: number; slope: number }>,
): Decomposition | null {
  if (points.length < 3) return null;
  const xs = points.map((point) => point.rate);
  const ys = points.map((point) => point.slope);
  const fit = ols(xs, ys);
  if (fit === null) return null;
  // The intercept's standard error is not the slope's; deriving it properly
  // matters because L IS the intercept and its CI is what the verdict reads.
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  for (const x of xs) sxx += (x - meanX) ** 2;
  let sse = 0;
  for (let i = 0; i < n; i += 1) {
    sse += (ys[i]! - (fit.intercept + fit.slope * xs[i]!)) ** 2;
  }
  const residualSd = Math.sqrt(sse / (n - 2));
  const interceptSe = residualSd * Math.sqrt(1 / n + meanX ** 2 / sxx);
  const t = tCritical(n - 2);
  const robustSlope = theilSen(xs, ys);
  const robustIntercept =
    robustSlope === null
      ? null
      : median(ys.map((y, i) => y - robustSlope * xs[i]!));
  return {
    c: round(fit.slope, 6),
    cCiHigh: round(fit.ciHigh, 6),
    cCiLow: round(fit.ciLow, 6),
    cMiBPer1kRows: round(fit.slope * 500),
    l: round(fit.intercept),
    lCiHigh: round(fit.intercept + t * interceptSe),
    lCiLow: round(fit.intercept - t * interceptSe),
    n,
    theilSenC: round(robustSlope, 6),
    theilSenL: round(robustIntercept),
  };
}

// ---------------------------------------------------------------------------
// Reading the inputs.
// ---------------------------------------------------------------------------

export function readSeries(path: string): Sample[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Sample);
}

export function readMemProbe(path: string): MemReading[] {
  try {
    return readFileSync(path, "utf8")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as MemReading];
        } catch {
          // A torn last line is the normal cost of five appenders and a hard
          // stop. Dropping it is right; failing the whole analysis is not.
          return [];
        }
      });
  } catch {
    return [];
  }
}

/** Identical to #105's rule, so the two reports talk about the same rows. */
export function usableSamples(all: readonly Sample[]): Sample[] {
  return all.filter(
    (sample) =>
      sample.eyeCount === 5 && sample.missingRss === 0 && sample.totalRssMiB > 0,
  );
}

// ---------------------------------------------------------------------------
// The report.
// ---------------------------------------------------------------------------

const MIB = 1024 * 1024;

export function judge(all: readonly Sample[], memory: readonly MemReading[]) {
  const errors = all.filter((sample) => "sampleError" in sample).length;
  const usable = usableSamples(all);
  const phases = crossoverPhases();

  /** Every usable sample inside SOME phase's analysed window. */
  const analysed = usable.filter((sample) =>
    phases.some((phase) => isAnalysed(sample.elapsedMinutes, phase)),
  );

  // ---- headline, on #105's terms, for comparability ------------------------
  const headlineFit = ols(
    analysed.map((sample) => sample.elapsedMinutes),
    analysed.map((sample) => sample.totalRssMiB),
  );
  const headlineRobust = theilSen(
    analysed.map((sample) => sample.elapsedMinutes),
    analysed.map((sample) => sample.totalRssMiB),
  );
  let rssVerdict: string;
  if (headlineFit === null || analysed.length < 10) {
    rssVerdict = "INSUFFICIENT DATA";
  } else if (
    headlineFit.slope >= LEAK_THRESHOLD_MIB_PER_MIN &&
    headlineFit.ciLow > 0 &&
    (headlineRobust ?? 0) > 0
  ) {
    rssVerdict = "LEAK";
  } else if (headlineFit.ciLow > 0 && (headlineRobust ?? 0) > 0) {
    rssVerdict = "POSITIVE BUT BELOW THRESHOLD";
  } else {
    rssVerdict = "NO SUSTAINED POSITIVE SLOPE";
  }

  // ---- per-phase fits ------------------------------------------------------
  const phaseFits = phases.map((phase) => fitPhase(usable, phase));
  const withFloor = phaseFits.filter(
    (fit): fit is PhaseFit & { floorSlope: number } => fit.floorSlope !== null,
  );
  const withMean = phaseFits.filter(
    (fit): fit is PhaseFit & { meanSlope: number } => fit.meanSlope !== null,
  );

  const byRate = (rate: "A" | "B" | "Z") =>
    withFloor.filter((fit) => fit.rate === rate).map((fit) => fit.floorSlope);
  const pooled = {
    A: meanWithCi(byRate("A")),
    B: meanWithCi(byRate("B")),
    Z: meanWithCi(byRate("Z")),
  };

  const floorDecomposition =
    withFloor.length >= MIN_PHASES_FOR_DECOMPOSITION
      ? decompose(withFloor.map((fit) => ({ rate: fit.rowsPerSample, slope: fit.floorSlope })))
      : null;
  const meanDecomposition =
    withMean.length >= MIN_PHASES_FOR_DECOMPOSITION
      ? decompose(withMean.map((fit) => ({ rate: fit.rowsPerSample, slope: fit.meanSlope })))
      : null;

  // ---- P1: rate scaling ----------------------------------------------------
  const fA = pooled.A.mean;
  const fB = pooled.B.mean;
  const fZ = pooled.Z.mean;
  const denominator = fA === null || fZ === null ? null : fA - fZ;
  const rateScalingRatio =
    fB === null || fZ === null || denominator === null || Math.abs(denominator) < 1e-9
      ? null
      : (fB - fZ) / denominator;

  // ---- P2: the contiguous zero-traffic block, minutes 210-360 --------------
  const zeroBlock = phases.filter(
    (phase) => phase.rowsPerSample === 0 && phase.startMinute >= 210 && phase.endMinute <= 360,
  );
  const zeroBlockFloor = zeroBlock.flatMap((phase) =>
    floorSeries(usable, phase, FLOOR_BUCKET_MINUTES),
  );
  const zeroBlockFit = ols(
    zeroBlockFloor.map((point) => point.centreMinute),
    zeroBlockFloor.map((point) => point.floorMiB),
  );
  const zeroBlockSamples = usable.filter((sample) =>
    zeroBlock.some((phase) => isAnalysed(sample.elapsedMinutes, phase)),
  );

  // ---- P3: Z-replicate decay ----------------------------------------------
  const zPhases = withFloor.filter((fit) => fit.rate === "Z");
  const zDecaySpearman = spearman(
    zPhases.map((_, index) => index),
    zPhases.map((fit) => fit.floorSlope),
  );

  // ---- P4: per-row invariance ---------------------------------------------
  const perRow = {
    A: meanWithCi(
      withFloor.filter((f) => f.rate === "A").flatMap((f) => (f.miBPer1kRows === null ? [] : [f.miBPer1kRows])),
    ),
    B: meanWithCi(
      withFloor.filter((f) => f.rate === "B").flatMap((f) => (f.miBPer1kRows === null ? [] : [f.miBPer1kRows])),
    ),
  };

  // ---- P5: what it is made of ---------------------------------------------
  const memoryAnalysed = memory.filter((reading) => {
    const minutes = reading.uptimeSeconds / 60;
    return phases.some((phase) => isAnalysed(minutes, phase));
  });
  const perEyeMemory = Object.fromEntries(
    EYES.map((eye) => {
      const rows = memoryAnalysed.filter((reading) => reading.eye === eye);
      const xs = rows.map((reading) => reading.uptimeSeconds / 60);
      const slopeOf = (pick: (reading: MemReading) => number) =>
        round((ols(xs, rows.map(pick))?.slope ?? 0) / MIB, 5);
      const first = rows[0];
      const last = rows.at(-1);
      return [
        eye,
        {
          arrayBuffersSlopeMiBPerMin: rows.length < 3 ? null : slopeOf((r) => r.arrayBuffers),
          deltaRssMiB:
            first === undefined || last === undefined
              ? null
              : round((last.rss - first.rss) / MIB, 2),
          externalSlopeMiBPerMin: rows.length < 3 ? null : slopeOf((r) => r.external),
          finalHeapUsedMiB: last === undefined ? null : round(last.heapUsed / MIB, 2),
          finalResidualMiB: last === undefined ? null : round(last.residual / MIB, 2),
          finalRssMiB: last === undefined ? null : round(last.rss / MIB, 2),
          heapUsedSlopeMiBPerMin: rows.length < 3 ? null : slopeOf((r) => r.heapUsed),
          readings: rows.length,
          residualSlopeMiBPerMin: rows.length < 3 ? null : slopeOf((r) => r.residual),
          rssSlopeMiBPerMin: rows.length < 3 ? null : slopeOf((r) => r.rss),
        },
      ];
    }),
  );

  const pageCacheBounds = analysed
    .map((sample) => sample.sqlite?.pageCacheBoundBytes ?? null)
    .filter((value): value is number => value !== null);
  const maxPageCacheBound = pageCacheBounds.length === 0 ? null : Math.max(...pageCacheBounds);
  const firstAnalysed = analysed[0] ?? null;
  const lastAnalysed = analysed.at(-1) ?? null;
  const fleetRiseMiB =
    firstAnalysed === null || lastAnalysed === null
      ? null
      : lastAnalysed.totalRssMiB - firstAnalysed.totalRssMiB;
  const nonDatabaseEyesRose = EYES.filter((eye) => eye !== DATABASE_EYE).every((eye) => {
    const slope = (perEyeMemory[eye] as { rssSlopeMiBPerMin: number | null }).rssSlopeMiBPerMin;
    return slope !== null && slope > 0;
  });
  const pageCacheRefuted =
    maxPageCacheBound !== null &&
    maxPageCacheBound < PAGE_CACHE_REFUTATION_CEILING_BYTES &&
    fleetRiseMiB !== null &&
    fleetRiseMiB > MATERIAL_RISE_MIB &&
    nonDatabaseEyesRose;

  let cause: string;
  const residualSlopes = EYES.map(
    (eye) => (perEyeMemory[eye] as { residualSlopeMiBPerMin: number | null }).residualSlopeMiBPerMin,
  ).filter((value): value is number => value !== null);
  const heapSlopes = EYES.map(
    (eye) => (perEyeMemory[eye] as { heapUsedSlopeMiBPerMin: number | null }).heapUsedSlopeMiBPerMin,
  ).filter((value): value is number => value !== null);
  const bufferSlopes = EYES.map((eye) => {
    const entry = perEyeMemory[eye] as {
      arrayBuffersSlopeMiBPerMin: number | null;
      externalSlopeMiBPerMin: number | null;
    };
    return (entry.externalSlopeMiBPerMin ?? 0) + (entry.arrayBuffersSlopeMiBPerMin ?? 0);
  });
  const sum = (values: readonly number[]) => values.reduce((a, b) => a + b, 0);
  if (memoryAnalysed.length === 0) {
    cause = "NOT INSTRUMENTED";
  } else if (residualSlopes.length === 0) {
    cause = "INSUFFICIENT DATA";
  } else {
    const heap = sum(heapSlopes);
    const buffers = sum(bufferSlopes);
    const residual = sum(residualSlopes);
    const largest = Math.max(heap, buffers, residual);
    if (largest <= 0) cause = "NO IN-PROCESS GROWTH";
    else if (largest === residual) cause = "ARENA / UNRETURNED PAGES";
    else if (largest === heap) cause = "JS HEAP";
    else cause = "RETAINED BUFFERS";
  }

  // ---- the primary verdict -------------------------------------------------
  let leakVsCache: string;
  if (floorDecomposition === null) {
    leakVsCache = "INSUFFICIENT DATA";
  } else {
    const l = floorDecomposition.l ?? 0;
    const lExcludesZero =
      floorDecomposition.lCiLow !== null &&
      floorDecomposition.lCiHigh !== null &&
      (floorDecomposition.lCiLow > 0 || floorDecomposition.lCiHigh < 0);
    const lIsPositive = lExcludesZero && (floorDecomposition.lCiLow ?? 0) > 0;
    const cExcludesZero =
      floorDecomposition.cCiLow !== null &&
      floorDecomposition.cCiHigh !== null &&
      (floorDecomposition.cCiLow > 0 || floorDecomposition.cCiHigh < 0);
    const cIsPositive = cExcludesZero && (floorDecomposition.cCiLow ?? 0) > 0;
    const zExcludesZero =
      pooled.Z.ciLow !== null && pooled.Z.ciHigh !== null &&
      (pooled.Z.ciLow > 0 || pooled.Z.ciHigh < 0);
    const zIsPositive = zExcludesZero && (pooled.Z.ciLow ?? 0) > 0;

    const signsDisagree =
      (floorDecomposition.theilSenL !== null &&
        Math.sign(floorDecomposition.theilSenL) !== Math.sign(l) &&
        floorDecomposition.theilSenL !== 0 &&
        l !== 0) ||
      (meanDecomposition !== null &&
        meanDecomposition.l !== null &&
        Math.sign(meanDecomposition.l) !== Math.sign(l) &&
        meanDecomposition.l !== 0 &&
        l !== 0) ||
      (pooled.Z.mean !== null &&
        Math.sign(pooled.Z.mean) !== Math.sign(l) &&
        pooled.Z.mean !== 0 &&
        l !== 0);

    if (signsDisagree) leakVsCache = "DISAGREEMENT";
    else if (lIsPositive && zIsPositive && cIsPositive) leakVsCache = "BOTH";
    else if (lIsPositive && zIsPositive)
      leakVsCache = l >= LEAK_THRESHOLD_MIB_PER_MIN ? "LEAK" : "LEAK BELOW THRESHOLD";
    else if (cIsPositive && !lExcludesZero && !zExcludesZero)
      leakVsCache = "CACHE / CORPUS-TRACKING";
    else if (cIsPositive) leakVsCache = "BOTH";
    else if (!lExcludesZero && !cExcludesZero) leakVsCache = "NEITHER";
    else leakVsCache = "DISAGREEMENT";
  }

  // ---- restarts, from the series alone (identical to #105) ------------------
  const pidChanges: Array<{ at: string; eye: string; from: number; to: number }> = [];
  const seenPids: Record<string, number> = {};
  for (const sample of usable) {
    for (const eye of EYES) {
      const pid = sample.eyes[eye]?.pid;
      if (pid === undefined) continue;
      const previous = seenPids[eye];
      if (previous !== undefined && previous !== pid) {
        pidChanges.push({ at: sample.at, eye, from: previous, to: pid });
      }
      seenPids[eye] = pid;
    }
  }

  const last = usable.at(-1) ?? null;
  const peak = usable.reduce<Sample | null>(
    (best, sample) => (best === null || sample.totalRssMiB > best.totalRssMiB ? sample : best),
    null,
  );
  const loads = usable.map((sample) => sample.load.one).sort((a, b) => a - b);

  // ---- the collinearity #105 could not break, measured ---------------------
  const collinearity = {
    NOTE:
      "#105 had rowsVersusElapsed = 1.000000 over its warmed window, which is why it could " +
      "not tell a leak from a cache. A value materially below 1 here is the design working.",
    rowsVersusElapsed: round(
      pearson(
        analysed.map((sample) => sample.rows ?? 0),
        analysed.map((sample) => sample.elapsedMinutes),
      ),
      6,
    ),
    rssVersusElapsed: round(
      pearson(
        analysed.map((sample) => sample.elapsedMinutes),
        analysed.map((sample) => sample.totalRssMiB),
      ),
    ),
    rssVersusLoadOne: round(
      pearson(
        analysed.map((sample) => sample.load.one),
        analysed.map((sample) => sample.totalRssMiB),
      ),
    ),
    rssVersusRows: round(
      pearson(
        analysed.map((sample) => sample.rows ?? 0),
        analysed.map((sample) => sample.totalRssMiB),
      ),
    ),
  };

  return {
    cause: {
      NOTE:
        "P5. The only arm that can identify a CAUSE rather than a shape (#105 section 7 item 4).",
      pageCache: {
        NOTE:
          "A BOUND, not an occupancy — Bun exposes no sqlite3_db_status/sqlite3_memory_used. " +
          "It can refute the page-cache hypothesis; it cannot confirm it.",
        archiverIsOnlyDatabaseEye: true,
        fleetRiseMiB: round(fleetRiseMiB, 2),
        maxPageCacheBoundMiB: round(
          maxPageCacheBound === null ? null : maxPageCacheBound / MIB,
          3,
        ),
        nonDatabaseEyesAlsoRose: nonDatabaseEyesRose,
        refutationCeilingMiB: PAGE_CACHE_REFUTATION_CEILING_BYTES / MIB,
        refuted: pageCacheRefuted,
      },
      perEye: perEyeMemory,
      readings: memory.length,
      readingsAnalysed: memoryAnalysed.length,
      verdict: cause,
    },
    collinearity,
    decisionRule: {
      NOTE:
        "Fixed before sample 1. leakVsCache is the primary verdict of #109; rss= is reported " +
        "on #105's unchanged terms purely so the two runs are comparable.",
      floorBucketMinutes: FLOOR_BUCKET_MINUTES,
      leakThresholdMiBPerMin: LEAK_THRESHOLD_MIB_PER_MIN,
      minPhasesForDecomposition: MIN_PHASES_FOR_DECOMPOSITION,
      model: "phaseFloorSlope = L + c * rowsPerSample; L is the leak term, c the cache term",
      phaseMinutes: PHASE_MINUTES,
      phaseSettleMinutes: PHASE_SETTLE_MINUTES,
      warmupMinutes: WARMUP_MINUTES,
    },
    decomposition: {
      byFloor: floorDecomposition,
      byMean: meanDecomposition,
      pooledFloorSlopeByRate: {
        A: { ...pooled.A, rowsPerSample: 30 },
        B: { ...pooled.B, rowsPerSample: 300 },
        Z: { ...pooled.Z, rowsPerSample: 0 },
      },
    },
    phases: phaseFits,
    predictions: {
      P1_rateScaling: {
        cachePredicts: "fZ ~ 0 and (fB - fZ)/(fA - fZ) ~ 10",
        leakPredicts: "fZ ~ fA ~ fB, ratio ~ 1",
        observedRatio: round(rateScalingRatio, 3),
        pooledFloorA: round(fA),
        pooledFloorB: round(fB),
        pooledFloorZ: round(fZ),
      },
      P2_zeroTrafficBlock: {
        cachePredicts: "flat; 95% CI contains zero",
        ciHigh: round(zeroBlockFit?.ciHigh ?? null),
        ciLow: round(zeroBlockFit?.ciLow ?? null),
        floorSlopeMiBPerMin: round(zeroBlockFit?.slope ?? null),
        // Compared as a SLOPE, not as a total rise: `observedRiseMiB` spans the
        // two phases' analysed sub-windows (120 of the 150 minutes, with the
        // settling allowance cut out of each), so a raw +185 MiB would not be
        // the same quantity and putting the two side by side would mislead.
        leakPredicts: "floorSlopeMiBPerMin ~ +1.2334 (#105's measured rate); CI excluding zero",
        observedRiseMiB:
          zeroBlockFloor.length < 2
            ? null
            : round(zeroBlockFloor.at(-1)!.floorMiB - zeroBlockFloor[0]!.floorMiB, 2),
        rowsAtEnd: zeroBlockSamples.at(-1)?.rows ?? null,
        rowsAtStart: zeroBlockSamples[0]?.rows ?? null,
        samples: zeroBlockSamples.length,
        windowMinutes: zeroBlock.length === 0 ? null : "210-360",
      },
      P3_zeroReplicateDecay: {
        cacheStillFillingPredicts: "monotone decay across replicates; Spearman strongly negative",
        leakPredicts: "no trend; Spearman ~ 0",
        slopesInOrder: zPhases.map((fit) => ({ label: fit.label, slope: fit.floorSlope })),
        spearman: round(zDecaySpearman, 3),
      },
      P4_perRowInvariance: {
        cachePredicts: "gA ~ gB (a constant MiB per 1,000 rows)",
        leakPredicts: "gB ~ gA / 10",
        miBPer1kRowsA: round(perRow.A.mean),
        miBPer1kRowsB: round(perRow.B.mean),
        ratioAOverB:
          perRow.A.mean === null || perRow.B.mean === null || Math.abs(perRow.B.mean) < 1e-9
            ? null
            : round(perRow.A.mean / perRow.B.mean, 3),
      },
      P5_cause: {
        seeAlso: "cause.verdict and cause.perEye",
      },
    },
    restarts: {
      NOTE:
        "A watcher that breaches the 512 MiB ceiling self-terminates in-process " +
        "(src/watch.ts, DEFAULT_WATCH_MAX_RSS_MIB) and the supervisor restarts it, so a " +
        "pidChange here may be a CEILING BREACH rather than a crash. Cross-check " +
        "supervisor.log and the memprobe reading written at the breach.",
      pidChanges,
      supervisorLogLines: last?.restartLines ?? null,
    },
    rss: {
      analysedSlopeMiBPerMin: {
        ciHigh: round(headlineFit?.ciHigh ?? null),
        ciLow: round(headlineFit?.ciLow ?? null),
        n: analysed.length,
        slope: round(headlineFit?.slope ?? null),
        theilSen: round(headlineRobust),
      },
      finalMiB: last?.totalRssMiB ?? null,
      peakAt: peak?.at ?? null,
      peakMiB: peak?.totalRssMiB ?? null,
      perEyeFinalMiB: Object.fromEntries(
        EYES.map((eye) => [eye, round((last?.eyes[eye]?.rssKiB ?? 0) / 1024, 2)]),
      ),
    },
    run: {
      durationMinutes: round(last?.elapsedMinutes ?? 0, 2),
      loadMax: loads.at(-1) ?? null,
      loadMean: round(loads.reduce((a, b) => a + b, 0) / Math.max(1, loads.length), 2),
      loadMedian: round(median(loads), 2),
      loadMin: loads[0] ?? null,
      loadP90: loads.length === 0 ? null : round(loads[Math.floor(loads.length * 0.9)]!, 2),
      plannedMinutes: TOTAL_MINUTES,
      plannedPhases: CROSSOVER_PHASES,
      sampleErrors: errors,
      samplesAnalysed: analysed.length,
      samplesTotal: all.length,
      samplesUsable: usable.length,
    },
    sensitivityNotAVerdict: {
      NOTE:
        "Printed so the width choice is visible, NOT read by any verdict field. " +
        "judge() computes every decision from FLOOR_BUCKET_MINUTES alone.",
      pooledFloorSlopeByWidth: Object.fromEntries(
        SENSITIVITY_WIDTHS.map((width) => [
          `${width}m`,
          Object.fromEntries(
            (["A", "B", "Z"] as const).map((rate) => [
              rate,
              round(
                meanWithCi(
                  phases
                    .filter((phase) => rateName(phase.rowsPerSample) === rate)
                    .flatMap((phase) => {
                      const points = floorSeries(usable, phase, width);
                      const fit = ols(
                        points.map((point) => point.centreMinute),
                        points.map((point) => point.floorMiB),
                      );
                      return fit === null ? [] : [fit.slope];
                    }),
                ).mean,
              ),
            ]),
          ),
        ]),
      ),
    },
    store: {
      archiveFinalBytes: last?.archiveBytes ?? null,
      rowsFinal: last?.rows ?? null,
      sqliteFinal: last?.sqlite ?? null,
      walFinalBytes: last?.walBytes ?? null,
      walMaxBytes: Math.max(0, ...usable.map((sample) => sample.walBytes ?? 0)),
    },
    verdict: [
      `rss=${rssVerdict}`,
      pidChanges.length === 0 ? "restarts=NONE" : `restarts=${pidChanges.length}`,
      `leakVsCache=${leakVsCache}`,
      `cause=${cause}`,
    ].join(" "),
  };
}

if (import.meta.main) {
  const seriesPath = process.argv[2];
  if (!seriesPath) {
    throw new Error("usage: analyze109.ts <series.jsonl> [memprobe.jsonl]");
  }
  const memPath = process.argv[3] ?? seriesPath.replace(/series\.jsonl$/, "memprobe.jsonl");
  console.log(
    JSON.stringify(judge(readSeries(seriesPath), readMemProbe(memPath)), null, 2),
  );
}
