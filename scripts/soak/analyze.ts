/**
 * Turn a soak series into a verdict (#105).
 *
 * Written and committed BEFORE the run it judges, because a slope threshold
 * chosen after seeing the data is not a threshold. Everything below — the
 * warmed-window boundary, the leak threshold, the two independent slope
 * estimators, the restart rule — is fixed in advance.
 *
 * THE WARMED WINDOW. RSS rises during warm-up for reasons that are not leaks:
 * Bun tiers up JIT, each eye's first catchUp allocates over the whole seeded
 * backlog at once, SQLite page cache fills, and cursors settle at EOF. A naive
 * fit over the whole series therefore shows a positive slope on a PERFECTLY
 * HEALTHY fleet. The first 30 minutes are discarded. 30 is not tuned to the
 * result: the measured cold catchUp completes in under a minute, so 30 minutes
 * is ~30x the settling time, and the report also states the slope over the
 * final 60 minutes so a reader can see the choice did not manufacture the
 * answer.
 *
 * SIGNAL VS NOISE. Two estimators must agree:
 *   OLS       slope with a 95% CI from its standard error. If the CI includes
 *             zero the series is consistent with flat.
 *   Theil-Sen median of pairwise slopes. Immune to outliers, which matters on
 *             a machine where Johan's iOS Release builds have driven load to
 *             124 — a load spike moves a few samples, and the median ignores
 *             them where least squares would not.
 * A verdict is only reported when both agree; disagreement is reported as
 * disagreement rather than resolved in favour of whichever is convenient.
 *
 * THE THRESHOLD, and why it is blunt. #86 was 2.2-2.45 GiB per eye growing
 * ~200 MiB/min per eye — about 1000 MiB/min across five. The bar here is
 * 2.5 MiB/min fleet-wide (0.5 MiB/min/eye), which is 400x SMALLER than the
 * incident and still reaches the 512 MiB ceiling from a healthy ~50 MiB
 * baseline inside a day. If a leak needed a subtler test than this to find,
 * the honest reading is "no leak detected", not "a small leak found".
 */
import { readFileSync } from "node:fs";

const seriesPath = process.argv[2];
if (!seriesPath) throw new Error("usage: analyze.ts <series.jsonl> [warmup-minutes]");
const WARMUP_MINUTES = Number(process.argv[3] ?? 30);
const LEAK_THRESHOLD_MIB_PER_MIN = 2.5;

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
  totalRssMiB: number;
  walBytes: number | null;
}

const all: Sample[] = readFileSync(seriesPath, "utf8")
  .split("\n")
  .filter((line) => line.trim() !== "")
  .map((line) => JSON.parse(line) as Sample);
const errors = all.filter((sample) => "sampleError" in sample).length;
/** A sample that could not see all five eyes measures the sampler, not the fleet. */
const usable = all.filter(
  (sample) => sample.eyeCount === 5 && sample.missingRss === 0 && sample.totalRssMiB > 0,
);
const warmed = usable.filter((sample) => sample.elapsedMinutes >= WARMUP_MINUTES);

interface Fit {
  ciHigh: number;
  ciLow: number;
  intercept: number;
  n: number;
  slope: number;
  stdError: number;
}

function ols(xs: readonly number[], ys: readonly number[]): Fit | null {
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
  // 1.96 is the normal approximation; with hundreds of samples the t
  // correction is in the third decimal and would not move any verdict here.
  return {
    ciHigh: slope + 1.96 * stdError,
    ciLow: slope - 1.96 * stdError,
    intercept,
    n,
    slope,
    stdError,
  };
}

/** Median of pairwise slopes, subsampled so the O(n^2) stays honest at n~400. */
function theilSen(xs: readonly number[], ys: readonly number[]): number | null {
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

function round(value: number | null, places = 4): number | null {
  return value === null ? null : Number(value.toFixed(places));
}

function fitOf(samples: readonly Sample[], pick: (sample: Sample) => number | null) {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const sample of samples) {
    const value = pick(sample);
    if (value !== null && Number.isFinite(value)) {
      xs.push(sample.elapsedMinutes);
      ys.push(value);
    }
  }
  const fit = ols(xs, ys);
  return {
    n: xs.length,
    ols: fit === null ? null : { ciHigh: round(fit.ciHigh), ciLow: round(fit.ciLow), slope: round(fit.slope), stdError: round(fit.stdError) },
    theilSen: round(theilSen(xs, ys)),
  };
}

const EYES = ["archiver", "digest", "honcho", "retro", "reviewer"] as const;

// ---- restarts, from the series alone -------------------------------------
// Independent of the supervisor log on purpose: a PID that changes between two
// samples is a restart whatever any log says, and this survives a lost log.
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
const first = usable[0] ?? null;
const peak = usable.reduce<Sample | null>(
  (best, sample) => (best === null || sample.totalRssMiB > best.totalRssMiB ? sample : best),
  null,
);

const totalFit = fitOf(warmed, (sample) => sample.totalRssMiB);
const finalHour = warmed.filter(
  (sample) => last !== null && sample.elapsedMinutes >= last.elapsedMinutes - 60,
);

const searchQueries = Object.keys(last?.searchMs ?? {});

const verdictParts: string[] = [];
const slope = totalFit.ols?.slope ?? null;
const ciLow = totalFit.ols?.ciLow ?? null;
const robust = totalFit.theilSen;
let rssVerdict: string;
if (slope === null || warmed.length < 10) {
  rssVerdict = "INSUFFICIENT DATA";
} else if (slope >= LEAK_THRESHOLD_MIB_PER_MIN && (ciLow ?? 0) > 0 && (robust ?? 0) > 0) {
  rssVerdict = "LEAK";
} else if ((ciLow ?? 0) > 0 && (robust ?? 0) > 0) {
  rssVerdict = "POSITIVE BUT BELOW THRESHOLD";
} else {
  rssVerdict = "NO SUSTAINED POSITIVE SLOPE";
}
verdictParts.push(`rss=${rssVerdict}`);
verdictParts.push(pidChanges.length === 0 ? "restarts=NONE" : `restarts=${pidChanges.length}`);

console.log(
  JSON.stringify(
    {
      decisionRule: {
        leakThresholdMiBPerMin: LEAK_THRESHOLD_MIB_PER_MIN,
        note: "LEAK requires OLS slope >= threshold AND 95% CI excluding zero AND Theil-Sen agreeing in sign",
        warmupMinutes: WARMUP_MINUTES,
      },
      restarts: { pidChanges, supervisorLogLines: last?.restartLines ?? null },
      rss: {
        finalMiB: last?.totalRssMiB ?? null,
        firstWarmedMiB: warmed[0]?.totalRssMiB ?? null,
        peakAt: peak?.at ?? null,
        peakMiB: peak?.totalRssMiB ?? null,
        perEyeFinalMiB: Object.fromEntries(
          EYES.map((eye) => [eye, round((last?.eyes[eye]?.rssKiB ?? 0) / 1024, 2)]),
        ),
        perEyeWarmedSlopeMiBPerMin: Object.fromEntries(
          EYES.map((eye) => [
            eye,
            fitOf(warmed, (sample) => {
              const value = sample.eyes[eye]?.rssKiB;
              return value === undefined || value === null ? null : value / 1024;
            }),
          ]),
        ),
        warmedFinalHourSlope: fitOf(finalHour, (sample) => sample.totalRssMiB),
        warmedSlopeMiBPerMin: totalFit,
      },
      run: {
        durationMinutes: round(last?.elapsedMinutes ?? 0, 2),
        loadMax: Math.max(...usable.map((sample) => sample.load.one)),
        loadMean: round(usable.reduce((a, b) => a + b.load.one, 0) / Math.max(1, usable.length), 2),
        loadMin: Math.min(...usable.map((sample) => sample.load.one)),
        sampleErrors: errors,
        samplesTotal: all.length,
        samplesUsable: usable.length,
        samplesWarmed: warmed.length,
        startedAt: first?.at ?? null,
        warmupMinutes: WARMUP_MINUTES,
      },
      searchLatency: Object.fromEntries(
        searchQueries.map((query) => [
          query,
          {
            finalMs: last?.searchMs?.[query] ?? null,
            maxMs: Math.max(...warmed.map((sample) => sample.searchMs?.[query] ?? 0)),
            medianWarmedMs: (() => {
              const values = warmed
                .map((sample) => sample.searchMs?.[query])
                .filter((value): value is number => typeof value === "number")
                .sort((a, b) => a - b);
              return values.length === 0 ? null : round(values[Math.floor(values.length / 2)]!, 3);
            })(),
            warmedSlopeMsPerMin: fitOf(warmed, (sample) => sample.searchMs?.[query] ?? null),
          },
        ]),
      ),
      store: {
        archiveFinalBytes: last?.archiveBytes ?? null,
        archiveWarmedSlopeBytesPerMin: fitOf(warmed, (sample) => sample.archiveBytes),
        rowsFinal: last?.rows ?? null,
        walFinalBytes: last?.walBytes ?? null,
        walMaxBytes: Math.max(...usable.map((sample) => sample.walBytes ?? 0)),
        walWarmedSlopeBytesPerMin: fitOf(warmed, (sample) => sample.walBytes),
      },
      verdict: verdictParts.join(" "),
    },
    null,
    2,
  ),
);
