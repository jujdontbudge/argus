/**
 * POST-HOC soak diagnostics (#105). NOT a verdict, and deliberately separate.
 *
 * `analyze.ts` is the pre-registered judge: it was committed before the run and
 * its output is THE result. Everything in this file was written AFTER seeing the
 * series, so by construction it cannot overturn, soften, or qualify that result.
 * It exists for two reasons only:
 *
 *   1. To recompute — and where necessary correct — the metrics a human eyeballed
 *      off the live tail while the soak was running, so the corrections are
 *      reproducible rather than asserted.
 *   2. To carry candidate metrics (the bucket floor, the load control, the
 *      corpus-vs-time discrimination) forward as EVIDENCE FOR A FUTURE
 *      PRE-REGISTRATION. If the floor is worth having, it belongs in analyze.ts
 *      with a threshold argued in advance, before the next soak — not here.
 *
 * usage: bun scripts/soak/posthoc.ts <series.jsonl>
 */
import { readFileSync } from "node:fs";

interface Sample {
  archiveBytes: number | null;
  at: string;
  elapsedMinutes: number;
  eyeCount: number;
  eyes: Record<string, { pid: number; rssKiB: number | null }>;
  load: { fifteen: number; five: number; one: number };
  missingRss: number;
  restartLines: number | null;
  rows: number | null;
  searchMs: Record<string, number> | null;
  shmBytes: number | null;
  totalRssMiB: number;
  walBytes: number | null;
}

const seriesPath = process.argv[2];
if (!seriesPath) throw new Error("usage: posthoc.ts <series.jsonl>");

const all: Sample[] = readFileSync(seriesPath, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Sample);
/** Same usability rule as analyze.ts, so the two operate on the same rows. */
const usable = all.filter(
  (sample) => sample.eyeCount === 5 && sample.missingRss === 0 && sample.totalRssMiB > 0,
);
const WARMUP = 30;
const warmed = usable.filter((sample) => sample.elapsedMinutes >= WARMUP);

function round(value: number, places = 4): number {
  return Number(value.toFixed(places));
}

function ols(xs: readonly number[], ys: readonly number[]) {
  const n = xs.length;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i += 1) {
    sxx += (xs[i]! - meanX) ** 2;
    sxy += (xs[i]! - meanX) * (ys[i]! - meanY);
  }
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  let sse = 0;
  for (let i = 0; i < n; i += 1) sse += (ys[i]! - (intercept + slope * xs[i]!)) ** 2;
  const stdError = Math.sqrt(sse / (n - 2) / sxx);
  return { ciHigh: slope + 1.96 * stdError, ciLow: slope - 1.96 * stdError, intercept, n, slope };
}

/** Full O(n^2) here: bucket series are tiny, so no subsampling is needed. */
function theilSen(xs: readonly number[], ys: readonly number[]): number {
  const slopes: number[] = [];
  for (let i = 0; i < xs.length; i += 1) {
    for (let j = i + 1; j < xs.length; j += 1) {
      if (xs[j] !== xs[i]) slopes.push((ys[j]! - ys[i]!) / (xs[j]! - xs[i]!));
    }
  }
  slopes.sort((a, b) => a - b);
  const middle = Math.floor(slopes.length / 2);
  return slopes.length % 2 === 0 ? (slopes[middle - 1]! + slopes[middle]!) / 2 : slopes[middle]!;
}

function pearson(xs: readonly number[], ys: readonly number[]): number {
  const n = xs.length;
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
  return sxy / Math.sqrt(sxx * syy);
}

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
}

// ---- the floor metric, at both bucket widths and both warm-ups --------------
// Bucket width is a FREE PARAMETER chosen after the fact, which is most of why
// this is not a verdict. All four combinations are printed so the sensitivity is
// visible rather than hidden behind whichever one reads best.
const floorTable = [15, 30].flatMap((width) =>
  [0, WARMUP].map((warmup) => {
    const centres: number[] = [];
    const floors: number[] = [];
    const peaks: number[] = [];
    for (let k = 0; k * width < 180; k += 1) {
      const bucket = usable.filter(
        (sample) =>
          sample.elapsedMinutes >= Math.max(k * width, warmup) &&
          sample.elapsedMinutes < (k + 1) * width,
      );
      if (bucket.length === 0) continue;
      centres.push(k * width + width / 2);
      floors.push(Math.min(...bucket.map((sample) => sample.totalRssMiB)));
      peaks.push(Math.max(...bucket.map((sample) => sample.totalRssMiB)));
    }
    const floorFit = ols(centres, floors);
    const peakFit = ols(centres, peaks);
    return {
      bucketMinutes: width,
      floorMiB: floors.map((value) => round(value, 2)),
      floorSlope: {
        ciHigh: round(floorFit.ciHigh),
        ciLow: round(floorFit.ciLow),
        endpoint: round((floors.at(-1)! - floors[0]!) / (centres.at(-1)! - centres[0]!)),
        ols: round(floorFit.slope),
        theilSen: round(theilSen(centres, floors)),
      },
      peakMiB: peaks.map((value) => round(value, 2)),
      peakSlope: {
        ciHigh: round(peakFit.ciHigh),
        ciLow: round(peakFit.ciLow),
        endpoint: round((peaks.at(-1)! - peaks[0]!) / (centres.at(-1)! - centres[0]!)),
        ols: round(peakFit.slope),
        theilSen: round(theilSen(centres, peaks)),
      },
      warmupMinutes: warmup,
    };
  }),
);

// ---- is the growth corpus-driven, time-driven, or load-driven? --------------
// The traffic generator adds a fixed number of rows per sample, so rows is a
// linear function of wall-clock and the first two are NOT separable in this run.
// Printing the collinearity is the point: it is the finding.
const t = warmed.map((sample) => sample.elapsedMinutes);
const rss = warmed.map((sample) => sample.totalRssMiB);
const rows = warmed.map((sample) => sample.rows ?? 0);
const archive = warmed.map((sample) => sample.archiveBytes ?? 0);
const load = warmed.map((sample) => sample.load.one);

const loadFit = ols(load, rss);
const residual = rss.map((value, i) => value - (loadFit.intercept + loadFit.slope * load[i]!));
const quiet = warmed.filter((sample) => sample.load.one < 10);
const quietFit = ols(
  quiet.map((sample) => sample.elapsedMinutes),
  quiet.map((sample) => sample.totalRssMiB),
);

const thirds = [
  [30, 80],
  [80, 130],
  [130, 181],
].map(([lo, hi]) => {
  const window = warmed.filter(
    (sample) => sample.elapsedMinutes >= lo! && sample.elapsedMinutes < hi!,
  );
  const fit = ols(
    window.map((sample) => sample.elapsedMinutes),
    window.map((sample) => sample.totalRssMiB),
  );
  return {
    ciHigh: round(fit.ciHigh, 3),
    ciLow: round(fit.ciLow, 3),
    medianLoadOne: round(median(window.map((sample) => sample.load.one)), 1),
    n: window.length,
    slope: round(fit.slope, 3),
    window: `${lo}-${hi === 181 ? 180 : hi}m`,
  };
});

// ---- search latency, bucket medians so load spikes cannot drive the fit -----
const queries = Object.keys(usable.at(-1)?.searchMs ?? {});
const latency = Object.fromEntries(
  queries.map((query) => {
    const centres: number[] = [];
    const medians: number[] = [];
    const rowMedians: number[] = [];
    for (let k = 0; k < 12; k += 1) {
      const bucket = usable.filter(
        (sample) => sample.elapsedMinutes >= k * 15 && sample.elapsedMinutes < (k + 1) * 15,
      );
      if (bucket.length === 0) continue;
      centres.push(k * 15 + 7.5);
      medians.push(median(bucket.map((sample) => sample.searchMs?.[query] ?? 0)));
      rowMedians.push(median(bucket.map((sample) => sample.rows ?? 0)));
    }
    const warmedCentres = centres.filter((centre) => centre >= WARMUP);
    const offset = centres.length - warmedCentres.length;
    const versusRows = ols(rowMedians.slice(offset), medians.slice(offset));
    const half = Math.floor(warmedCentres.length / 2);
    return [
      query,
      {
        bucketMedianMs: medians.map((value) => round(value, 2)),
        firstHalfMsPerMin: round(
          ols(warmedCentres.slice(0, half), medians.slice(offset, offset + half)).slope,
          3,
        ),
        msPer1kRows: round(versusRows.slope * 1000, 3),
        quietSlopeMsPerMin: round(
          ols(
            quiet.map((sample) => sample.elapsedMinutes),
            quiet.map((sample) => sample.searchMs?.[query] ?? 0),
          ).slope,
          4,
        ),
        rPearsonVersusLoad: round(
          pearson(load, warmed.map((sample) => sample.searchMs?.[query] ?? 0)),
          3,
        ),
        rPearsonVersusRows: round(
          pearson(rows, warmed.map((sample) => sample.searchMs?.[query] ?? 0)),
          3,
        ),
        secondHalfMsPerMin: round(ols(warmedCentres.slice(half), medians.slice(offset + half)).slope, 3),
      },
    ];
  }),
);

console.log(
  JSON.stringify(
    {
      NOTE: "POST-HOC. Not a verdict. analyze.ts holds the verdict; this is input to the NEXT pre-registration.",
      collinearity: {
        NOTE: "rows ~ elapsed at r=1 means 'grows with corpus' and 'grows with uptime' are the same claim in this run",
        archiveVersusElapsed: round(pearson(archive, t), 6),
        rowsVersusElapsed: round(pearson(rows, t), 6),
        rssVersusArchive: round(pearson(rss, archive), 4),
        rssVersusElapsed: round(pearson(rss, t), 4),
        rssVersusRows: round(pearson(rss, rows), 4),
      },
      floorMetric: floorTable,
      loadControl: {
        NOTE: "load fell as RSS rose; macOS reclaim would produce exactly that, so it must be controlled for",
        miBPerLoadUnit: round(loadFit.slope),
        quietSubsetN: quiet.length,
        quietSubsetSlopeMiBPerMin: round(quietFit.slope),
        residualSlopeMiBPerMin: round(ols(t, residual).slope),
        rssVersusLoadOne: round(pearson(rss, load), 4),
      },
      searchLatency: latency,
      shape: { NOTE: "convex, not linear: a leak is usually linear", thirds },
    },
    null,
    2,
  ),
);
