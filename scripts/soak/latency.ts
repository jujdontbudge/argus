/**
 * Pre-registered search-latency judgment for the NEXT soak (#110, to judge #109).
 *
 * Written and committed BEFORE the run it judges, for the same reason
 * `analyze.ts` was: a latency bar chosen after seeing the data is not a bar.
 * #105 measured search latency for three hours and had nothing to fail
 * against, so a number anywhere between 25 ms and 2,500 ms would have passed
 * equally. Everything below — the bucketing, the estimators, the per-query
 * bars, the straddle rule — is fixed here, in advance.
 *
 * This file does NOT touch `analyze.ts`. #105's RSS verdict is a record and
 * has to stay byte-for-byte reproducible.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS IS A BUDGET *FOR*, WHICH IS THE WHOLE QUESTION
 * ---------------------------------------------------------------------------
 * The budget follows the consumers. Every consumer of the FTS path was
 * enumerated from the tree (there is exactly one `MATCH` in it,
 * `src/search/search.ts:75`):
 *
 *   1. `argus search` at a terminal, `src/cli.ts:292`. One-shot, interactive,
 *      no timeout, no spinner, no cancellation. Tolerance NOT KNOWABLE from
 *      the code as a number.
 *   2. An agent calling `argus search` as a tool — `skills/argus-orchestrator/
 *      SKILL.md:281` ("the lowest useful resolution", last in a four-step zoom
 *      order) and the AGENTS.md pointer block every enrolled repo gets,
 *      `src/up/scaffold.ts:68`. On no schedule at all; the model decides.
 *      Tolerance NOT KNOWABLE from the code.
 *   3. `src/harness/batch-search.ts:1064`, the #92 acceptance harness. Spawns
 *      the CLI twice at the end of a batch and awaits `child.exited` with NO
 *      timeout — note the same file sets `sessionTimeoutMs = 600_000` at :686,
 *      so the author reaches for a timeout when there is a tolerance to state
 *      and did not reach for one here. Tolerance NOT KNOWABLE.
 *   4. `scripts/soak/sampler.ts:109`, every 30 s. Not a consumer of the
 *      product; it is the instrument. Its only bound is that three queries
 *      plus RSS collection fit inside 30 s. Knowable, and vacuous.
 *
 * AND THE ONE THAT DOES NOT EXIST. The obvious tight-tolerance consumer — a
 * watcher polling search every 250 ms — is not in this tree. `ARGUS_WATCH_POLL_MS`
 * (`src/watch.ts:263`, default 250) and `src/eyes/cap.ts:64` are the only
 * 250 ms cadences here, and neither calls `openArchiveSearch`. The watchers
 * WRITE archive rows; nothing reads them back through FTS on a clock. That
 * absence is load-bearing: with no consumer on a cadence, an absolute
 * milliseconds budget in the tens or hundreds of ms protects nobody. 25 ms and
 * 250 ms are equally invisible to a human at a prompt, and both are noise
 * inside the ~5.3 s median brain call ADR-0002 already accepts.
 *
 * So this file does NOT budget milliseconds. It budgets THE CONSTANT: cost per
 * 1,000 archived rows. That is the quantity #105 actually measured, it is the
 * quantity that decides whether a repo meets a slow search in weeks or in
 * years, and — unlike absolute latency — a regression in it is visible inside
 * a single three-hour run.
 *
 * REGIME, stated plainly: this is a REGRESSION DETECTOR ON A THREE-HOUR
 * TIMESCALE, not a user-experience guard. It trips when a code change makes
 * search cost more per row than #105 measured. It deliberately cannot trip on
 * corpus growth: at #105's ~3,600 rows/hour the broad query needs ~25 days of
 * continuous heavy traffic to reach 194 ms at 100k rows, and no 3-hour soak
 * can see that. Whether 194 ms at 100k rows is acceptable to a human is left
 * OPEN in ADR-0003, because no consumer in the tree states a tolerance and
 * inventing one at a desk is the thing this ticket exists to avoid.
 *
 * ---------------------------------------------------------------------------
 * WHY THE THREE QUERIES GET THREE RULES AND MUST NOT BE FLATTENED
 * ---------------------------------------------------------------------------
 * #105 §9: `provenance cursor` did not grow at all (r(rows) = -0.070,
 * r(load1) = +0.394; its 193.78 ms maximum is the machine, not the corpus),
 * while `soak traffic` grew 17x and `sqlite backlog` 3.5x with r(rows) of
 * +0.553 and a slope that survives a low-load subset.
 *
 * One number over all three would therefore convert a LOAD SPIKE on the flat
 * query into evidence of CORPUS GROWTH — the exact misreading #105 spent a
 * section correcting. So the flat query is judged by a different rule: it may
 * only fail if it starts growing AND the growth is corpus-shaped rather than
 * load-shaped (|r(rows)| >= |r(load1)|). A latency excursion on that query with
 * load correlation dominating is reported as what it is and is not a failure.
 *
 * WHAT THE THREE NUMBERS ARE NOT, measured for ADR-0003 against #105's own
 * final store on an idle machine: three query CLASSES. #105 labels them broad /
 * mid / cursor-scoped, which implies selectivity. It is not selectivity. The
 * seed vocabulary is 18 words (`scripts/soak/seed.ts:46-59`) and every traffic
 * message contains all 18 plus "traffic" (`scripts/soak/traffic.ts:53`), so all
 * three strings match roughly half the final corpus — 11,389 / 11,407 / 10,754
 * rows — and all three cost the SAME 13.4-13.6 ms against it today. Cost tracks
 * MATCHED rows (~0.7-0.9 ms per 1,000 matched), and the per-archived-row spread
 * is a property of #105's run, not of the query strings.
 *
 * PRECONDITION THIS FILE CANNOT CHECK: the two numeric bars below are
 * per-ARCHIVED-row, and the archived-to-matched conversion is a property of
 * that seed vocabulary and that traffic text. They are valid only for a #109
 * that re-runs `scripts/soak/seed.ts` and `scripts/soak/traffic.ts` unchanged.
 * Change the corpus generator and new bars must be derived from the
 * per-matched-row constant in ADR-0003 instead.
 *
 * ---------------------------------------------------------------------------
 * THE ESTIMATOR, FIXED IN ADVANCE
 * ---------------------------------------------------------------------------
 * Per-sample latencies here spike to 100-280 ms on load excursions, so a
 * per-sample fit is dominated by the machine. #105's published constants come
 * from bucket MEDIANS, and this file reproduces that method exactly:
 *
 *   - 15-minute buckets. WIDTH IS FIXED HERE because #105 §4b's own critique of
 *     its post-hoc floor metric was that bucket width is a free parameter the
 *     answer moves with. Fixing it in advance is the point.
 *   - Buckets whose window STARTS at >= 30 min (the same warm-up `analyze.ts`
 *     pre-registered, for the same reasons).
 *   - y = median searchMs in the bucket; x = that bucket's last `rows` / 1000.
 *   - OLS with a 95% CI, and Theil-Sen as the outlier-immune second opinion.
 *
 * The method is pinned rather than approximated, and it was checked twice.
 * Re-fitting #105's PUBLISHED §9 bucket table gives 0.3548 / 2.1288 / 1.4918
 * ms per 1,000 rows against its stated 0.355 / 2.132 / 1.494, and 0.0893 ms/min
 * in the time domain for `sqlite backlog` against its stated +0.0893. Running
 * this file against the RAW series gives 0.4041 / 2.1542 / 1.5182 — the small
 * spread is the table's 2-decimal rounding — and reproduces #105's other §9
 * numbers exactly: r(rows) -0.070 / +0.553, r(load1) +0.394 / -0.141, warmed
 * maxima 193.781 / 102.740 / 277.209 ms, and the crossings it quotes as
 * "around 55k rows" for 100 ms and "~470k rows" for one second (56,107 and
 * 473,890 here).
 *
 * NOTE ON THE FLAT-CLASS CROSSINGS: they are printed as null. Extrapolating a
 * slope whose CI spans zero produces a corpus size nobody should use.
 *
 * ---------------------------------------------------------------------------
 * THE BARS, AND WHY EACH IS THAT NUMBER
 * ---------------------------------------------------------------------------
 * #105's warmed bucket fits, with the uncertainty it is honest to carry:
 *
 *   provenance cursor   0.4041 ms/1k   CI [-1.303, +2.111]   Theil-Sen 0.5052
 *   soak traffic        2.1542 ms/1k   CI [+1.725, +2.584]   Theil-Sen 2.1125
 *   sqlite backlog      1.5182 ms/1k   CI [+0.698, +2.339]   Theil-Sen 1.3084
 *
 * A bar set at a multiple of the POINT estimate ignores that a re-run of the
 * same code lands anywhere in that interval. Each bar is therefore 2x the
 * UPPER bound of #105's own 95% CI — "twice the worst #105 could have been,
 * given its own uncertainty":
 *
 *   soak traffic     2 x 2.584 -> 5.2 ms/1k   (2.41x the measured point)
 *   sqlite backlog   2 x 2.339 -> 4.7 ms/1k   (3.10x the measured point)
 *
 * The multiplication is mechanical, so the bar is not a taste judgement about
 * where to put a line: the RULE ("twice the top of #105's own CI") was fixed
 * first and the arithmetic followed.
 *
 * Why 2x and not 1.2x or 10x. 1.2x is inside the sampling noise of #105's own
 * numbers and would fire on a clean re-run. 10x is unreachable by anything
 * short of losing FTS entirely, which needs no threshold to notice. 2x is the
 * scale of the regressions this path can actually suffer: an index not used,
 * bm25 ranking widened over more columns, the JOIN losing its rowid path,
 * `snippet()` evaluated over the match set instead of the LIMIT. Those are
 * step changes of roughly 2-5x. The bar sits above the top of the current CI
 * and below the bottom of that class, which is the only place a bar is worth
 * having.
 *
 * NO BAR FOR `provenance cursor`, and that refusal is deliberate. Its CI,
 * [-1.390, +2.100], is wide enough to CONTAIN the broad query's point estimate.
 * With ten buckets #105 cannot distinguish 0.355 from 2.1 on this query, so any
 * numeric bar for it would be invented rather than measured. Its rule is
 * qualitative instead: it fails only if it stops being flat in a corpus-shaped
 * way.
 *
 * THE ABSOLUTE BACKSTOP, 5,000 ms, IS NOT INVENTED EITHER. It is
 * `PRAGMA busy_timeout = 5000` from `src/search/search.ts:105` — the only
 * latency-shaped number the search path already commits to, the point past
 * which the code itself stops waiting. It is a catastrophe detector and is
 * labelled as one; nothing short of a hung store reaches it.
 *
 * DISAGREEMENT IS REPORTED AS DISAGREEMENT. If OLS and Theil-Sen land on
 * opposite sides of a bar the verdict is STRADDLE, exactly as `analyze.ts`
 * requires and exactly as #105 §3 reported its own final-hour RSS straddle,
 * rather than resolved in favour of whichever side is convenient.
 *
 * A QUERY STRING NOT IN THE TABLE BELOW IS `UNREGISTERED`, never defaulted.
 * The pre-registration is per exact query string; silently applying someone
 * else's bar to a new query would be the desk-invented number again.
 */
import { readFileSync } from "node:fs";

/** 15 minutes. Fixed in advance; see the docblock on #105 §4b. */
export const BUCKET_MINUTES = 15;
/** The same warm-up analyze.ts pre-registered, for the same reasons. */
export const WARMUP_MINUTES = 30;
/** `PRAGMA busy_timeout = 5000`, src/search/search.ts:105. Catastrophe only. */
export const ABSOLUTE_BACKSTOP_MS = 5_000;

export interface QueryRegistration {
  /** null = flat-class: judged by shape, not by a number. See the docblock. */
  barMsPer1kRows: number | null;
  /** #105's measured constant for this exact query string. */
  measuredMsPer1kRows: number;
  /** #105's 95% CI upper bound, which is what the bar is twice of. */
  measuredCiHigh: number;
  note: string;
}

/**
 * Pre-registered per query STRING, matching `scripts/soak/sampler.ts`'s
 * SEARCH_QUERIES verbatim. #109 must re-run these three strings for the
 * comparison to mean anything; a fourth query is reported, not judged.
 */
export const REGISTERED: Readonly<Record<string, QueryRegistration>> = {
  "provenance cursor": {
    barMsPer1kRows: null,
    measuredCiHigh: 2.1113,
    measuredMsPer1kRows: 0.4041,
    note: "flat in #105 (r(rows) -0.070, r(load1) +0.394); CI [-1.303, +2.111] is too wide for a numeric bar",
  },
  "soak traffic": {
    barMsPer1kRows: 5.2,
    measuredCiHigh: 2.584,
    measuredMsPer1kRows: 2.1542,
    note: "the broad query; 5.2 = 2x #105's CI upper bound 2.584, rounded up to one decimal",
  },
  "sqlite backlog": {
    barMsPer1kRows: 4.7,
    measuredCiHigh: 2.3386,
    measuredMsPer1kRows: 1.5182,
    note: "the mid query; 4.7 = 2x #105's CI upper bound 2.339, rounded up to one decimal",
  },
};

export interface Sample {
  elapsedMinutes: number;
  eyeCount: number;
  load: { fifteen: number; five: number; one: number };
  missingRss: number;
  rows: number | null;
  searchMs: Record<string, number> | null;
  totalRssMiB: number;
}

interface Fit {
  ciHigh: number;
  ciLow: number;
  intercept: number;
  n: number;
  slope: number;
}

function ols(xs: readonly number[], ys: readonly number[]): Fit | null {
  const n = xs.length;
  if (n < 3) return null;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let index = 0; index < n; index += 1) {
    sxx += (xs[index]! - meanX) ** 2;
    sxy += (xs[index]! - meanX) * (ys[index]! - meanY);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;
  let sse = 0;
  for (let index = 0; index < n; index += 1) {
    sse += (ys[index]! - (intercept + slope * xs[index]!)) ** 2;
  }
  const stdError = Math.sqrt(sse / (n - 2) / sxx);
  // 1.96 is the normal approximation, matching analyze.ts. With ~10 buckets the
  // t correction is real (t(8) = 2.31), so the CI printed here is if anything
  // NARROWER than the truth — which makes every bar derived from it more
  // conservative, never less.
  return {
    ciHigh: slope + 1.96 * stdError,
    ciLow: slope - 1.96 * stdError,
    intercept,
    n,
    slope,
  };
}

function theilSen(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const slopes: number[] = [];
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
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

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function pearson(xs: readonly number[], ys: readonly number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let index = 0; index < n; index += 1) {
    const dx = xs[index]! - meanX;
    const dy = ys[index]! - meanY;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

function round(value: number | null, places = 4): number | null {
  return value === null ? null : Number(value.toFixed(places));
}

export interface Bucket {
  latencyMs: number;
  rowsThousands: number;
  startMinute: number;
}

/**
 * A sample that could not see all five eyes measures the sampler, not the
 * fleet — the same usability filter analyze.ts applies, kept identical so the
 * two reports are talking about the same run.
 */
export function usableSamples(all: readonly Sample[]): Sample[] {
  return all.filter(
    (sample) =>
      sample.eyeCount === 5 && sample.missingRss === 0 && sample.totalRssMiB > 0,
  );
}

/** Warmed 15-minute bucket medians for one query string, x = rows/1000. */
export function bucketsFor(all: readonly Sample[], query: string): Bucket[] {
  const grouped = new Map<number, { latencies: number[]; rows: number[] }>();
  for (const sample of usableSamples(all)) {
    const latency = sample.searchMs?.[query];
    if (typeof latency !== "number" || !Number.isFinite(latency)) continue;
    if (sample.rows === null || !Number.isFinite(sample.rows)) continue;
    const startMinute =
      Math.floor(sample.elapsedMinutes / BUCKET_MINUTES) * BUCKET_MINUTES;
    if (startMinute < WARMUP_MINUTES) continue;
    const entry = grouped.get(startMinute) ?? { latencies: [], rows: [] };
    entry.latencies.push(latency);
    entry.rows.push(sample.rows);
    grouped.set(startMinute, entry);
  }
  return [...grouped.entries()]
    .sort(([a], [b]) => a - b)
    .flatMap(([startMinute, entry]) => {
      const latencyMs = median(entry.latencies);
      const lastRows = entry.rows.at(-1);
      if (latencyMs === null || lastRows === undefined) return [];
      return [{ latencyMs, rowsThousands: lastRows / 1000, startMinute }];
    });
}

export type QueryVerdict =
  | "GREW WITH LOAD, NOT CORPUS"
  | "INSUFFICIENT DATA"
  | "NO LONGER FLAT"
  | "REGRESSION"
  | "STILL FLAT"
  | "STRADDLE"
  | "UNREGISTERED"
  | "WITHIN BUDGET";

export interface QueryJudgement {
  backstopBreached: boolean;
  barMsPer1kRows: number | null;
  buckets: number;
  correlationWithLoad: number | null;
  correlationWithRows: number | null;
  maxMs: number | null;
  msPer1kRowsCiHigh: number | null;
  msPer1kRowsCiLow: number | null;
  msPer1kRowsOls: number | null;
  msPer1kRowsTheilSen: number | null;
  query: string;
  /** Corpus size at which the fit crosses 100 ms / 1,000 ms. Reported, never judged. */
  reaches1000msAtRows: number | null;
  reaches100msAtRows: number | null;
  verdict: QueryVerdict;
}

export function judgeQuery(
  all: readonly Sample[],
  query: string,
): QueryJudgement {
  const registration = REGISTERED[query];
  const buckets = bucketsFor(all, query);
  const fit = ols(
    buckets.map((bucket) => bucket.rowsThousands),
    buckets.map((bucket) => bucket.latencyMs),
  );
  const robust = theilSen(
    buckets.map((bucket) => bucket.rowsThousands),
    buckets.map((bucket) => bucket.latencyMs),
  );

  const warmedSamples = usableSamples(all).filter(
    (sample) => sample.elapsedMinutes >= WARMUP_MINUTES,
  );
  const paired = warmedSamples.flatMap((sample) => {
    const latency = sample.searchMs?.[query];
    if (typeof latency !== "number" || sample.rows === null) return [];
    return [{ latency, load: sample.load.one, rows: sample.rows }];
  });
  const correlationWithRows = pearson(
    paired.map((row) => row.rows),
    paired.map((row) => row.latency),
  );
  const correlationWithLoad = pearson(
    paired.map((row) => row.load),
    paired.map((row) => row.latency),
  );
  const maxMs =
    paired.length === 0 ? null : Math.max(...paired.map((row) => row.latency));
  const backstopBreached = maxMs !== null && maxMs >= ABSOLUTE_BACKSTOP_MS;

  // Extrapolating a slope whose CI spans zero would put a spurious corpus size
  // in front of a reader, so the flat-class crossings are reported as null
  // rather than as a number nobody should use.
  const crossing = (target: number): number | null => {
    if (fit === null || fit.slope <= 0 || fit.ciLow <= 0) return null;
    return Math.round(((target - fit.intercept) / fit.slope) * 1000);
  };

  const base = {
    backstopBreached,
    barMsPer1kRows: registration?.barMsPer1kRows ?? null,
    buckets: buckets.length,
    correlationWithLoad: round(correlationWithLoad, 3),
    correlationWithRows: round(correlationWithRows, 3),
    maxMs: round(maxMs, 3),
    msPer1kRowsCiHigh: round(fit?.ciHigh ?? null),
    msPer1kRowsCiLow: round(fit?.ciLow ?? null),
    msPer1kRowsOls: round(fit?.slope ?? null),
    msPer1kRowsTheilSen: round(robust),
    query,
    reaches1000msAtRows: crossing(1_000),
    reaches100msAtRows: crossing(100),
  };

  if (registration === undefined) {
    return { ...base, verdict: "UNREGISTERED" };
  }
  if (fit === null || robust === null || buckets.length < 4) {
    return { ...base, verdict: "INSUFFICIENT DATA" };
  }

  const bar = registration.barMsPer1kRows;
  if (bar === null) {
    // The flat class. Growth alone is not a failure; corpus-shaped growth is.
    // Without this asymmetry a load spike on this query would read as corpus
    // growth, which is the specific misreading #105 §9 had to correct.
    if (fit.ciLow <= 0) return { ...base, verdict: "STILL FLAT" };
    // A null load correlation means load had zero variance over the window, so
    // it cannot be the explanation; treat it as no explanatory power rather
    // than as an excuse. The tie goes to NO LONGER FLAT for the same reason:
    // the asymmetry exists to stop load being read as corpus, not to let a
    // coin-flip excuse growth.
    const rowsShaped =
      correlationWithRows !== null &&
      Math.abs(correlationWithRows) >= Math.abs(correlationWithLoad ?? 0);
    return {
      ...base,
      verdict: rowsShaped ? "NO LONGER FLAT" : "GREW WITH LOAD, NOT CORPUS",
    };
  }

  const olsOver = fit.slope >= bar;
  const robustOver = robust >= bar;
  if (olsOver !== robustOver) return { ...base, verdict: "STRADDLE" };
  if (olsOver && fit.ciLow > 0) return { ...base, verdict: "REGRESSION" };
  return { ...base, verdict: "WITHIN BUDGET" };
}

export interface Report {
  decisionRule: {
    absoluteBackstopMs: number;
    bucketMinutes: number;
    note: string;
    origin: string;
    registered: Readonly<Record<string, QueryRegistration>>;
    warmupMinutes: number;
  };
  queries: QueryJudgement[];
  verdict: string;
}

export function judge(all: readonly Sample[]): Report {
  const usable = usableSamples(all);
  const queries = [
    ...new Set(
      usable.flatMap((sample) => Object.keys(sample.searchMs ?? {})),
    ),
  ].sort();
  const judgements = queries.map((query) => judgeQuery(all, query));
  const parts = judgements.map(
    (judgement) => `${judgement.query}=${judgement.verdict}`,
  );
  if (judgements.some((judgement) => judgement.backstopBreached)) {
    parts.push(`backstop=BREACHED(>=${ABSOLUTE_BACKSTOP_MS}ms)`);
  }
  for (const query of Object.keys(REGISTERED)) {
    if (!queries.includes(query)) parts.push(`${query}=NOT RUN`);
  }
  return {
    decisionRule: {
      absoluteBackstopMs: ABSOLUTE_BACKSTOP_MS,
      bucketMinutes: BUCKET_MINUTES,
      note:
        "REGRESSION requires OLS >= bar AND Theil-Sen >= bar AND the 95% CI excluding zero; " +
        "OLS and Theil-Sen on opposite sides of the bar is STRADDLE and is not resolved. " +
        "The flat-class query fails only on corpus-shaped growth, never on a load excursion.",
      origin:
        "docs/adr/0003-search-latency-constant-and-budget.md; constants measured in docs/acceptance/soak.txt (#105) section 9",
      registered: REGISTERED,
      warmupMinutes: WARMUP_MINUTES,
    },
    queries: judgements,
    verdict: parts.length === 0 ? "NO SEARCH SAMPLES" : parts.join(" "),
  };
}

export function readSeries(path: string): Sample[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Sample);
}

if (import.meta.main) {
  const seriesPath = process.argv[2];
  if (!seriesPath) throw new Error("usage: latency.ts <series.jsonl>");
  console.log(JSON.stringify(judge(readSeries(seriesPath)), null, 2));
}
