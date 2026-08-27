/**
 * #110's latency rule, REUSED UNCHANGED, plus the two things phased traffic
 * makes newly measurable. Committed before the run, like everything else here.
 *
 * ===========================================================================
 * THE VERDICT IS `latency.ts`'s, AND THIS FILE DOES NOT TOUCH IT
 * ===========================================================================
 * `judge()` below calls `latency.judge()` and hands its Report back verbatim
 * under `preRegistered`. The bars (5.2 and 4.7 ms per 1,000 rows, each 2x the
 * upper bound of #105's own 95% CI), the flat-class shape rule for
 * `provenance cursor`, the STRADDLE clause, the 5,000 ms backstop, the
 * 15-minute bucket width and the 30-minute warm-up are all #110's and all
 * unmodified. Nothing in this file can move that verdict; everything it adds
 * is reported alongside, labelled, and never mixed in.
 *
 * WHY #110's BARS SURVIVE PHASED TRAFFIC UNCHANGED — the question the ticket
 * asks. `latency.ts`'s x-axis is ROWS, not minutes: it fits ms against
 * (bucket's last `rows`)/1000. Its constant is therefore RATE-INVARIANT by
 * construction, which is precisely the property that makes it the right thing
 * to carry across a run whose whole design is to vary the rate. A phase change
 * moves how fast buckets travel along x; it does not move the slope in x.
 *
 * Its ONE stated precondition is also met. The docblock says the bars are
 * per-ARCHIVED-row and valid only for "a #109 that re-runs
 * `scripts/soak/seed.ts` and `scripts/soak/traffic.ts` unchanged", because the
 * archived-to-matched conversion is a property of the 18-word seed vocabulary
 * and the traffic message text. #109 changes NEITHER: `seed.ts` is untouched
 * and `traffic.ts`'s message string is byte-identical in phased and unphased
 * mode. Only the rate moves.
 *
 * One consequence is worth stating plainly rather than discovering later.
 * During a Z phase `rows` is CONSTANT, so every 15-minute bucket inside it
 * lands on the same x. Stacked y-values at one x do not bias an OLS slope —
 * they contribute nothing to Sxx and only widen the residual — so #110's fit
 * degrades gracefully rather than wrongly. It also does something useful,
 * which is the next section.
 *
 * ===========================================================================
 * WHAT PHASED TRAFFIC ADDS, AND WHY IT IS WORTH ADDING
 * ===========================================================================
 * 1. LATENCY AT FROZEN CORPUS. #105 could not ask whether search slows down
 *    for reasons other than corpus growth, because its corpus never stopped
 *    growing. The Z phases hold `rows` fixed for 75 minutes at a time, four
 *    times, including a contiguous 150-minute block. Fitting latency against
 *    TIME inside a Z phase asks: does the same query over the same corpus get
 *    slower as the process ages? That is the leak-versus-cache question on the
 *    latency axis, and it is the one place the two analyses meet.
 *      A drift materially above zero at frozen corpus would mean the constant
 *      in ADR-0003 is not the whole story. A flat Z-phase fit is a positive
 *      result for the constant: it says corpus size, not uptime, is what costs.
 *
 * 2. THE CONSTANT, ESTIMATED SEPARATELY AT EACH RATE. #110's constant was
 *    fitted at one rate. If it is a property of the store it must be the same
 *    in the A phases and the B phases; if the A and B estimates disagree, the
 *    per-archived-row framing is hiding a rate dependence and ADR-0003 needs
 *    to know. Reported, never judged — no bar was pre-registered per rate and
 *    inventing one here is the exact move #110 exists to prevent.
 *
 * NEITHER OF THESE CAN FAIL THE RUN. They have no bars. They are measurements
 * carried for the next pre-registration, which is the standing the #105
 * post-hoc floor metric had, and #105 §4b's own rule for such things is that
 * they may inform a future threshold and may not overturn a present one.
 */
import {
  REGISTERED,
  bucketsFor,
  judge as preRegisteredJudge,
  readSeries,
  usableSamples,
  type Sample,
} from "./latency.ts";
import { crossoverPhases, isAnalysed, rateName, type Phase } from "./phases.ts";

interface PhasedSample extends Sample {
  elapsedMinutes: number;
}

function ols(xs: readonly number[], ys: readonly number[]) {
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
  return { ciHigh: slope + 1.96 * stdError, ciLow: slope - 1.96 * stdError, n, slope };
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function round(value: number | null | undefined, places = 4): number | null {
  return value === null || value === undefined || !Number.isFinite(value)
    ? null
    : Number(value.toFixed(places));
}

/** Analysed samples belonging to phases at one rate. */
function samplesAtRate(all: readonly Sample[], rate: "A" | "B" | "Z"): PhasedSample[] {
  const phases = crossoverPhases().filter(
    (phase) => rateName(phase.rowsPerSample) === rate,
  );
  return usableSamples(all).filter((sample) =>
    phases.some((phase) => isAnalysed(sample.elapsedMinutes, phase)),
  ) as PhasedSample[];
}

/**
 * Drift against TIME at a frozen corpus, per Z phase. Per phase rather than
 * pooled because pooling four Z phases would fit a line through four separated
 * windows and read the STEPS between them — which are exactly the A and B
 * traffic in between — as drift.
 */
function frozenCorpusDrift(all: readonly Sample[], query: string) {
  return crossoverPhases()
    .filter((phase) => phase.rowsPerSample === 0)
    .map((phase: Phase) => {
      const inWindow = usableSamples(all).filter((sample) =>
        isAnalysed(sample.elapsedMinutes, phase),
      );
      const paired = inWindow.flatMap((sample) => {
        const latency = sample.searchMs?.[query];
        return typeof latency === "number"
          ? [{ latency, minutes: sample.elapsedMinutes }]
          : [];
      });
      const fit = ols(
        paired.map((row) => row.minutes),
        paired.map((row) => row.latency),
      );
      return {
        ciHigh: round(fit?.ciHigh),
        ciLow: round(fit?.ciLow),
        medianMs: round(median(paired.map((row) => row.latency)), 3),
        msPerMin: round(fit?.slope),
        n: paired.length,
        phase: phase.label,
        rowsEnd: inWindow.at(-1)?.rows ?? null,
        rowsStart: inWindow[0]?.rows ?? null,
        startMinute: phase.startMinute,
      };
    });
}

/** #110's own bucket method, restricted to one rate's phases. Reported only. */
function constantAtRate(all: readonly Sample[], query: string, rate: "A" | "B") {
  const subset = samplesAtRate(all, rate);
  const buckets = bucketsFor(subset, query);
  const fit = ols(
    buckets.map((bucket) => bucket.rowsThousands),
    buckets.map((bucket) => bucket.latencyMs),
  );
  return {
    buckets: buckets.length,
    ciHigh: round(fit?.ciHigh),
    ciLow: round(fit?.ciLow),
    msPer1kRows: round(fit?.slope),
  };
}

export function judge(all: readonly Sample[]) {
  const queries = [
    ...new Set(usableSamples(all).flatMap((sample) => Object.keys(sample.searchMs ?? {}))),
  ].sort();
  const preRegistered = preRegisteredJudge(all);
  return {
    NOTE:
      "preRegistered is #110's verdict, produced by latency.ts unmodified. Everything under " +
      "phased is a MEASUREMENT with no bar, carried for the next pre-registration, and may " +
      "not overturn preRegistered.verdict.",
    phased: {
      constantByRate: Object.fromEntries(
        queries.map((query) => [
          query,
          {
            A: constantAtRate(all, query, "A"),
            B: constantAtRate(all, query, "B"),
            registeredPointEstimate: REGISTERED[query]?.measuredMsPer1kRows ?? null,
          },
        ]),
      ),
      frozenCorpusDrift: Object.fromEntries(
        queries.map((query) => [query, frozenCorpusDrift(all, query)]),
      ),
    },
    preRegistered,
    verdict: preRegistered.verdict,
  };
}

if (import.meta.main) {
  const seriesPath = process.argv[2];
  if (!seriesPath) throw new Error("usage: latency109.ts <series.jsonl>");
  console.log(JSON.stringify(judge(readSeries(seriesPath)), null, 2));
}
