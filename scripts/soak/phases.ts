/**
 * THE #109 PHASE SCHEDULE. Pre-registered, and the whole design lives here.
 *
 * Committed BEFORE the run, like `analyze.ts` (#105) and `latency.ts` (#110),
 * for the same reason: a schedule chosen after seeing the series is not a
 * design. Every number below is argued, and the argument is the file.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS SCHEDULE EXISTS TO SOLVE
 * ---------------------------------------------------------------------------
 * #105 §7 Test 1: over its warmed window, `rows ~ elapsed` had Pearson
 * r = 1.000000. The traffic generator added 29-36 rows every 30-second sample,
 * so corpus size WAS wall-clock, to six decimal places. Consequently
 * `totalRss ~ elapsed` (0.7687), `totalRss ~ rows` (0.7688) and
 * `totalRss ~ archiveBytes` (0.7730) are three correlations with one variable
 * wearing three hats. #105 therefore could not tell "leaks per minute" from
 * "caches per row", and said so rather than picking the comfortable reading.
 *
 * Collinearity is broken by MANIPULATING THE RATE, not by running longer.
 * A run at one rate for 24 hours has exactly the same r = 1.000000 problem
 * that a run at one rate for 3 hours has.
 *
 * ---------------------------------------------------------------------------
 * WHY PHASES AND NOT PARALLEL ARMS
 * ---------------------------------------------------------------------------
 * The obvious design is three concurrent fleets at three rates. It is
 * forbidden and it is also wrong.
 *
 * Forbidden: R5 is one live watcher fleet at a time, and D14 is why — watcher
 * daemons already consumed ~60 GB of this machine's RAM once (#86, 2.2-2.45
 * GiB per eye). Three fleets is three times the blast radius of the incident
 * the threshold was written for.
 *
 * Wrong: three fleets on one machine share one load average, one page cache
 * and one memory compressor. #105 §7 Test 2 had to spend a whole section
 * controlling for load, because load fell from a median of 18.4 to 5.3 across
 * its window while RSS rose (`totalRss ~ load1` r = -0.4005, -1.035 MiB of
 * fleet RSS per unit of load1) — on macOS that is exactly what the compressor
 * does. Concurrent arms would inject that same confound INTO the comparison
 * between arms, which is the one place it must not be.
 *
 * Sequential phases in ONE fleet keep the blast radius at one fleet and make
 * the rate a within-subject manipulation.
 *
 * ---------------------------------------------------------------------------
 * THE THREE RATES
 * ---------------------------------------------------------------------------
 *   Z    0 rows/sample     Zero traffic. The corpus is FROZEN. Any sustained
 *                          growth here is a leak by construction: nothing new
 *                          is arriving, so nothing new can be being cached.
 *                          This is #105 §7's arm 2.
 *   A   30 rows/sample     One row per second. #105's rate EXACTLY (it measured
 *                          29-36 rows/sample, mean 30.27). Chosen so #105 is a
 *                          usable baseline arm rather than a differently-shaped
 *                          run, and so the #110 latency constants — which are
 *                          per-archived-row and were derived from this traffic
 *                          text — apply unchanged.
 *  B  300 rows/sample      Ten rows per second. #105 §7's arm 1, at the 10x it
 *                          named. Ten is large enough that a corpus-driven
 *                          slope must separate from a time-driven one by an
 *                          order of magnitude, and small enough that the
 *                          archiver still commits every batch (600 rows/min
 *                          against #105's 117 rows/min, and against a cold
 *                          catchUp that ingests ~12,000 rows in under a
 *                          minute — so 600/min is nowhere near the ingest
 *                          ceiling and the manipulation stays a manipulation
 *                          rather than a saturation test).
 *
 * The message TEXT is unchanged from `traffic.ts` and the seed vocabulary is
 * unchanged from `seed.ts`. That is a PRECONDITION of #110's bars, which
 * `latency.ts`'s docblock states explicitly: they are per-ARCHIVED-row, and the
 * archived-to-matched conversion is a property of that vocabulary. Only the
 * RATE moves here, and #110's x-axis is rows, not minutes, so the constant it
 * budgets is rate-invariant by construction.
 *
 * ---------------------------------------------------------------------------
 * WHY A BALANCED CROSSOVER AND NOT Z-THEN-A-THEN-B
 * ---------------------------------------------------------------------------
 * The naive schedule — zero traffic, then 30, then 300 — is confounded exactly
 * as badly as #105 was, just in a new way. #105's series was CONVEX: thirds of
 * its warmed window fitted -0.023, +0.402 and +3.296 MiB/min. A monotone
 * ascending rate schedule laid over a convex-in-time series would show the
 * highest slope in the highest-rate phase FOR REASONS OF TIME ALONE, and would
 * read as a perfect corpus-driven result. That failure mode is not hypothetical
 * here; it is the documented shape of the only prior run.
 *
 * So each rate is REPLICATED FOUR TIMES and the order is balanced so that no
 * rate sits systematically early or late. Mean phase midpoint, minutes:
 *
 *     A  (97.5 + 397.5 + 697.5 + 922.5) / 4 = 528.75
 *     B  (172.5 + 472.5 + 547.5 + 847.5) / 4 = 510.00
 *     Z  (247.5 + 322.5 + 622.5 + 772.5) / 4 = 491.25
 *
 * against a grand mean of 510 — a spread of 37.5 minutes across a 900-minute
 * crossover, i.e. 4%. Every rate also appears exactly twice in each half of
 * the crossover. Any monotone-in-time drift (convexity, thermal, the
 * machine emptying overnight) is therefore charged almost equally to all three
 * rates instead of to one, and what remains in the rate contrast is rate.
 *
 * Replication is also what turns a point estimate into a spread: four
 * independent slope estimates per rate mean the report can show
 * between-replicate variability rather than one fit whose CI is the only
 * evidence about its own stability. #105's floor metric failed partly because
 * six buckets gave a CI of [+0.175, +1.328].
 *
 * TWO ADJACENCIES ARE DELIBERATE. Phases 3-4 are both Z, making a CONTIGUOUS
 * 150-MINUTE ZERO-TRAFFIC BLOCK at minutes 210-360 — as long as #105's entire
 * warmed window, against a completely frozen corpus. Phases 6-7 are both B,
 * making a contiguous 150-minute high-rate block, which is the matching
 * long-window observation at the other extreme. Those two blocks are the
 * strongest single comparison in the run and they are placed on purpose.
 *
 * ---------------------------------------------------------------------------
 * THE NUMBERS: 60 + 12 x 75 = 960 MINUTES (16 HOURS)
 * ---------------------------------------------------------------------------
 * TOTAL 16 h, inside the ticket's 12-24 h. 16 is the smallest total that buys
 * four replicates per rate at a phase length long enough to fit a floor slope
 * inside one phase (see below). 12 h would give three replicates, 24 h six;
 * four is where the between-replicate spread becomes reportable without
 * spending a whole day of Johan's machine. It is also 5.3x #105's 180 minutes
 * and 6.4x past the minute-150 bend that #105 ended inside.
 *
 * WARM-UP 60 MINUTES, discarded entirely, run at rate A.
 *   #105 pre-registered 30 minutes and its data justified the choice: fleet RSS
 *   was 491.7 MiB at 0.50 min, peaked at 495.7 at 1.01 min, and had fallen to
 *   ~143 MiB by minute 20 — the transient was gone with 10 minutes to spare.
 *   60 is double that, and the doubling buys something specific: this design's
 *   power comes from comparing phases TO EACH OTHER, so the first crossover
 *   phase must not be systematically different from the other eleven. A
 *   warm-up that is its own phase, thrown away whole, guarantees that. It runs
 *   at A rather than Z so the warm-up is directly comparable to #105's own
 *   first hour.
 *
 * PHASE LENGTH 75 MINUTES, first 15 discarded, 60 analysed.
 *   A rate step changes per-poll work instantly, but the fleet's working set
 *   takes time to re-equilibrate, and a phase boundary is NOT a leak — the
 *   analysis must not read it as one. 15 minutes is the settling allowance.
 *   It is not a guess: the largest settling time ever measured on this harness
 *   is the COLD catchUp, under one minute (`analyze.ts` docblock), and a rate
 *   step is strictly smaller than a cold start because the cursors are already
 *   at EOF and the JIT is already tiered up. 15 minutes is >15x that, mirroring
 *   #105's own "~30x the settling time" reasoning at the scale of a step
 *   rather than a start.
 *   The 60 analysed minutes are then set by the floor metric: at a 30-second
 *   sample interval and the 5-minute floor bucket fixed in `analyze109.ts`,
 *   60 minutes is 12 buckets — the same bucket COUNT #105's 15-minute width
 *   produced over its whole run, which is the count that harness has the most
 *   experience fitting. 120 usable samples per phase, 12 floor points per
 *   phase, 12 phases.
 *
 * ---------------------------------------------------------------------------
 * WHAT THE RUN COSTS THE ARCHIVE
 * ---------------------------------------------------------------------------
 * Rows added: warm-up 60 min x 60 = 3,600; A 300 min x 60 = 18,000;
 * B 300 min x 600 = 180,000; Z 0. Plus the ~12,100 seeded rows: ~213,700 rows
 * final, against #105's 21,066. That is a deliberate side effect worth naming:
 * #110's constant (2.15 ms per 1,000 rows on the broad query) predicts ~460 ms
 * at that corpus, so this run tests a constant fitted at 21k rows TEN TIMES
 * OUT OF SAMPLE, and stays an order of magnitude under the 5,000 ms
 * `PRAGMA busy_timeout` backstop while doing it.
 */

/** rows appended per 30-second sampler interval. */
export type PhaseRate = 0 | 30 | 300;

export interface Phase {
  /** Exclusive, minutes since sample 1. */
  endMinute: number;
  /** "warmup" or the 1-based crossover index. */
  label: string;
  /** Rows appended per 30 s sample. */
  rowsPerSample: PhaseRate;
  /** Inclusive, minutes since sample 1. */
  startMinute: number;
}

/** Minutes after a phase boundary excluded from every phase-level statistic. */
export const PHASE_SETTLE_MINUTES = 15;
/** The whole first phase. Discarded; not part of the crossover. */
export const WARMUP_MINUTES = 60;
/** Every crossover phase. */
export const PHASE_MINUTES = 75;
/** 12 crossover phases, 4 replicates x 3 rates. */
export const CROSSOVER_PHASES = 12;
export const TOTAL_MINUTES = WARMUP_MINUTES + CROSSOVER_PHASES * PHASE_MINUTES;
/** The sampler's cadence; the unit `rowsPerSample` is denominated in. */
export const SAMPLE_INTERVAL_SECONDS = 30;

/**
 * The balanced order. Fixed here, in advance, and NOT to be re-derived at
 * analysis time: A B Z Z A B B Z A Z B A.
 */
const ORDER: readonly PhaseRate[] = [
  30, 300, 0, 0, 30, 300, 300, 0, 30, 0, 300, 30,
];

export const PHASES: readonly Phase[] = [
  {
    endMinute: WARMUP_MINUTES,
    label: "warmup",
    rowsPerSample: 30,
    startMinute: 0,
  },
  ...ORDER.map((rowsPerSample, index) => ({
    endMinute: WARMUP_MINUTES + (index + 1) * PHASE_MINUTES,
    label: String(index + 1),
    rowsPerSample,
    startMinute: WARMUP_MINUTES + index * PHASE_MINUTES,
  })),
];

/** Human-readable rate name, used in reports and in the schedule dump. */
export function rateName(rowsPerSample: PhaseRate): "A" | "B" | "Z" {
  if (rowsPerSample === 0) return "Z";
  return rowsPerSample === 30 ? "A" : "B";
}

/** The phase containing `elapsedMinutes`, or null past the end of the run. */
export function phaseAt(elapsedMinutes: number): Phase | null {
  return (
    PHASES.find(
      (phase) =>
        elapsedMinutes >= phase.startMinute && elapsedMinutes < phase.endMinute,
    ) ?? null
  );
}

/**
 * The 12 crossover phases only. The warm-up is never analysed, so it is never
 * returned here — a caller cannot accidentally fit it.
 */
export function crossoverPhases(): readonly Phase[] {
  return PHASES.filter((phase) => phase.label !== "warmup");
}

/**
 * True when a sample is inside `phase`'s ANALYSED window: past the settling
 * allowance and past the global warm-up. Every phase-level statistic in
 * `analyze109.ts` filters through exactly this predicate, so there is one
 * definition of "analysable" and it is pre-registered.
 */
export function isAnalysed(elapsedMinutes: number, phase: Phase): boolean {
  return (
    elapsedMinutes >= Math.max(phase.startMinute + PHASE_SETTLE_MINUTES, WARMUP_MINUTES) &&
    elapsedMinutes < phase.endMinute
  );
}

/** Rows this phase's traffic adds per analysed minute; 0 for the Z phases. */
export function rowsPerMinute(phase: Phase): number {
  return (phase.rowsPerSample * 60) / SAMPLE_INTERVAL_SECONDS;
}
