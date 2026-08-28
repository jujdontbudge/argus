/**
 * THE PRE-REGISTERED VERDICT FOR #116. Committed BEFORE the run it judges.
 *
 * Same rule as `scripts/soak/analyze.ts` (#105), `phases.ts` (#109) and
 * `latency.ts` (#110): a threshold chosen after seeing the series is not a
 * threshold. Every bar below is argued here, in advance, and the argument is
 * the file. Anything this file cannot judge in advance is REPORTED and labelled
 * as reported, never quietly promoted into a pass.
 *
 * This file does not edit `scripts/soak/latency.ts` and does not restate its
 * bars. It IMPORTS `judge()` and runs it, unchanged, once per repo. #110
 * refused to edit `analyze.ts` for the same reason, and #116 asks for exactly
 * this: cite the Report machinery, do not refit it.
 *
 * ===========================================================================
 * 1. ISOLATION — the primary verdict, and the only one with zero tolerance
 * ===========================================================================
 * #116: "no cross-repo message/event leakage — this is the single most
 * important correctness property here, more than performance."
 *
 * `seed116.ts` and `traffic116.ts` stamp every line with `marker<i>`, unique to
 * the repo that owns it, so the sampler can ask each repo's archive directly
 * how many rows carry SOMEBODY ELSE'S marker. The bar is therefore not a
 * statistic and gets no tolerance at all:
 *
 *     foreignRows == 0 in every repo, in every sample, for the whole run.
 *
 * There is no warm-up exemption. A cold-start `catchUp` reads foreign
 * transcripts — that is the point of the shared HOME — but `sessionsForRepo`
 * discards them before the archiver ever sees them, so no legitimate mechanism
 * puts a foreign row in an archive at ANY time, including minute zero. Granting
 * a warm-up window here would exempt the exact interval most likely to break.
 *
 * `ownRows > 0` is required alongside it. A probe matching nothing at all
 * would report `foreignRows == 0` while proving only that the query was broken,
 * so the negative result is only accepted from an instrument shown to be live.
 *
 * ===========================================================================
 * 2. THE FROZEN REPO — a constant, checked against a constant
 * ===========================================================================
 * Repo 2 receives no traffic (see `traffic116.ts`). Once its cold-start catchUp
 * drains, its archive row count is a CONSTANT while repo 1 is driven at ten
 * rows a second under the same supervisor out of the same shared trees.
 *
 *     max(rows) - min(rows) == 0 over samples at elapsed >= FROZEN_SETTLE_MIN.
 *
 * FROZEN_SETTLE_MIN is 30, the same warm-up `analyze.ts` and `latency.ts`
 * pre-registered, taken from them rather than chosen fresh so this run's
 * settling allowance is the house one and not a new free parameter. It exists
 * only to exclude the cold-start drain, which is real ingest of that repo's OWN
 * seeded corpus and is not leakage.
 *
 * This is the sharpest instrument in the run: the expected value is a constant
 * and the observation either equals it or does not.
 *
 * ===========================================================================
 * 3. ATTRIBUTION — a counting fact, so it gets no tolerance either
 * ===========================================================================
 * The supervisor's own status file is the only surface that says which repo a
 * watcher belongs to, and the sampler attributes RSS by it. Two facts must hold
 * once the fleet is up:
 *
 *     watcherCount == 5 * N   in every settled sample
 *     unattributed == 0       in every sample
 *
 * "Settled" means elapsed >= FROZEN_SETTLE_MIN, and it covers exactly one thing:
 * the fleet is not instantly up at minute zero, and a supervised restart
 * (`WatcherSupervisor.#restartAfterExit`) legitimately shows 5N-1 watchers for
 * the length of one backoff. Restart lines are reported beside this so a dip is
 * never silently absorbed — if `restartLines` is 0 and the count is still short,
 * that is a supervisor failure and the verdict says so.
 *
 * ===========================================================================
 * 4. SCALE — the one bar with a tolerance, and why that tolerance is 1.5
 * ===========================================================================
 * #116: "no process count blowup (watch RSS/pid count scale linearly in N, not
 * worse)."
 *
 * PID COUNT gets no tolerance; it is counted in section 3 and 5N is exact.
 *
 * RSS is judged against #105's measured single-repo five-eye fleet, from
 * `docs/acceptance/soak.txt` section 3: min 98.02, median 204.53, MAX 495.67,
 * mean 319.95 MiB. The max is the right anchor because the claim under test is
 * about a blowup, and a blowup shows in the peak.
 *
 *     bar = N * 495.67 * 1.5 MiB
 *
 * Why 1.5 and not 1.0. Perfect linearity is the WRONG null here, and pretending
 * otherwise would hide the real finding. Under one HOME `listFiles()` returns
 * every repo's transcripts to every watcher, which parses them and discards the
 * foreign ones, so per-watcher work genuinely scales with N and some
 * superlinearity in resident bytes is EXPECTED. 1.5 is "half again as much as
 * perfect linearity": comfortably above the sampling noise in #105's own fleet
 * series, which ranged 98-496 MiB inside one run, and comfortably below 2.0,
 * where per-watcher resident cost would itself be scaling with N and the
 * topology would not hold at N=5 or N=10.
 *
 * Why 3.0x is not the bar even though the RAM guard sits near there: the guard
 * is a machine-safety limit and the bar is a design claim. They answer different
 * questions and the design claim must fail first, which at N=3 it does
 * (2,230 MiB against the guard's 3,072).
 *
 * NOT JUDGED, AND SAID SO: CPU. The N^2 parse term this topology implies is
 * real arithmetic, but there is NO prior measurement of fleet CPU-seconds to
 * judge it against — #105 and #109 did not collect it. Inventing a CPU bar at a
 * desk now is precisely what pre-registration exists to prevent, so
 * `cpuSecondsPerKRow` is computed, printed, and explicitly marked REPORTED, NOT
 * JUDGED. It is the number a follow-up ticket would pre-register against.
 *
 * ===========================================================================
 * 5. THE RAM GUARD — the ticket's own words, made mechanical
 * ===========================================================================
 * #116: "If total bun RSS threatens to cross a few GB as N grows, that itself
 * is a finding — stop and report where it broke down, don't push through."
 *
 * "A few GB" is made a number here so the run cannot argue with it afterwards:
 * 3,072 MiB of whole-machine bun RSS, sampled every 30 s into `fleet.jsonl`.
 * The driver aborts the run on it live; this file judges the record of it. Note
 * the measurement is WHOLE-MACHINE bun, not just the fleet, because that is the
 * quantity the ticket names and the quantity that actually threatens the box.
 *
 * ===========================================================================
 * 6. FTS GROWTH — reported per repo, judged only by #110's imported bars
 * ===========================================================================
 * Rows, archive bytes and bytes-per-row are printed per repo as the record of
 * growth. They are not judged here: #110 already pre-registered what a search
 * latency failure is, per archived row, and section 4's own precondition note
 * in `traffic116.ts` explains why those bars transfer to this traffic text in
 * the conservative direction. Adding a second, newer growth bar beside them
 * would just be a desk-invented number competing with a measured one.
 *
 * OVERALL: PASS only if isolation, frozen, attribution, scale and the RAM guard
 * all pass AND no repo's latency verdict is a REGRESSION or a backstop breach.
 * A STRADDLE or INSUFFICIENT DATA from `latency.ts` is neither a pass nor a
 * fail; it is carried through by name, exactly as #110 requires.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { judge, type Report, type Sample } from "../soak/latency.ts";

/** #105's warm-up, reused rather than re-chosen. See sections 2 and 3. */
export const FROZEN_SETTLE_MIN = 30;
/** docs/acceptance/soak.txt section 3: one repo, five eyes, peak fleet RSS. */
export const SOAK105_FLEET_MAX_MIB = 495.67;
/** See section 4 for why this is 1.5 and not 1.0. */
export const LINEARITY_TOLERANCE = 1.5;
/** #116's "a few GB", made mechanical. See section 5. */
export const RAM_GUARD_MIB = 3072;
export const EYES_PER_REPO = 5;

interface RepoSample extends Sample {
  archiveBytes: number | null;
  foreignMarkers: Record<string, number> | null;
  foreignRows: number | null;
  ownRows: number | null;
  repo: string;
  repoIndex: number;
  restartLines: number | null;
}

interface FleetSample {
  elapsedMinutes: number;
  fleetCpuSeconds?: number;
  fleetRssMiB?: number;
  machineBunRssGiB?: number | null;
  restartLines?: number | null;
  sampleError?: string;
  unattributed?: number;
  watcherCount?: number;
}

function readJsonl<T>(path: string): T[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as T);
}

function round(value: number | null, places = 3): number | null {
  return value === null || !Number.isFinite(value) ? null : Number(value.toFixed(places));
}

export interface IsolationJudgement {
  firstOffendingSample: { at: string | null; elapsedMinutes: number; foreignMarkers: unknown } | null;
  maxForeignRows: number | null;
  minOwnRows: number | null;
  repo: number;
  samplesWithArchive: number;
  verdict: "INSUFFICIENT DATA" | "LEAKED" | "PROBE DEAD" | "PASS";
}

export function judgeIsolation(repo: number, samples: readonly RepoSample[]): IsolationJudgement {
  const withArchive = samples.filter((sample) => sample.foreignRows !== null);
  const base = {
    firstOffendingSample: null,
    maxForeignRows: null,
    minOwnRows: null,
    repo,
    samplesWithArchive: withArchive.length,
  };
  if (withArchive.length === 0) return { ...base, verdict: "INSUFFICIENT DATA" };
  const maxForeignRows = Math.max(...withArchive.map((sample) => sample.foreignRows!));
  const minOwnRows = Math.min(...withArchive.map((sample) => sample.ownRows ?? 0));
  const offender = withArchive.find((sample) => (sample.foreignRows ?? 0) > 0);
  const full = {
    ...base,
    firstOffendingSample:
      offender === undefined
        ? null
        : {
            at: (offender as unknown as { at?: string }).at ?? null,
            elapsedMinutes: offender.elapsedMinutes,
            foreignMarkers: offender.foreignMarkers,
          },
    maxForeignRows,
    minOwnRows,
  };
  if (maxForeignRows > 0) return { ...full, verdict: "LEAKED" };
  // A probe that never matched its OWN marker proves nothing about the others.
  if (minOwnRows <= 0) return { ...full, verdict: "PROBE DEAD" };
  return { ...full, verdict: "PASS" };
}

export interface FrozenJudgement {
  maxRows: number | null;
  minRows: number | null;
  repo: number;
  settledSamples: number;
  verdict: "GREW" | "INSUFFICIENT DATA" | "PASS";
}

export function judgeFrozen(repo: number, samples: readonly RepoSample[]): FrozenJudgement {
  const settled = samples.filter(
    (sample) => sample.elapsedMinutes >= FROZEN_SETTLE_MIN && sample.rows !== null,
  );
  if (settled.length < 2) {
    return { maxRows: null, minRows: null, repo, settledSamples: settled.length, verdict: "INSUFFICIENT DATA" };
  }
  const rows = settled.map((sample) => sample.rows!);
  const maxRows = Math.max(...rows);
  const minRows = Math.min(...rows);
  return {
    maxRows,
    minRows,
    repo,
    settledSamples: settled.length,
    verdict: maxRows - minRows === 0 ? "PASS" : "GREW",
  };
}

export interface AttributionJudgement {
  expectedWatchers: number;
  maxUnattributed: number | null;
  minWatcherCount: number | null;
  restartLines: number | null;
  settledSamples: number;
  verdict: "INCOMPLETE FLEET" | "INSUFFICIENT DATA" | "MISATTRIBUTED" | "PASS";
}

export function judgeAttribution(
  fleet: readonly FleetSample[],
  repoCount: number,
): AttributionJudgement {
  const expectedWatchers = repoCount * EYES_PER_REPO;
  const valid = fleet.filter((sample) => sample.sampleError === undefined);
  const anyUnattributed = valid.filter((sample) => sample.unattributed !== undefined);
  const settled = valid.filter((sample) => sample.elapsedMinutes >= FROZEN_SETTLE_MIN);
  const restartLines = valid.at(-1)?.restartLines ?? null;
  const base = { expectedWatchers, restartLines, settledSamples: settled.length };
  const maxUnattributed =
    anyUnattributed.length === 0
      ? null
      : Math.max(...anyUnattributed.map((sample) => sample.unattributed ?? 0));
  if (maxUnattributed !== null && maxUnattributed > 0) {
    return { ...base, maxUnattributed, minWatcherCount: null, verdict: "MISATTRIBUTED" };
  }
  if (settled.length === 0) {
    return { ...base, maxUnattributed, minWatcherCount: null, verdict: "INSUFFICIENT DATA" };
  }
  const minWatcherCount = Math.min(...settled.map((sample) => sample.watcherCount ?? 0));
  return {
    ...base,
    maxUnattributed,
    minWatcherCount,
    verdict: minWatcherCount === expectedWatchers ? "PASS" : "INCOMPLETE FLEET",
  };
}

export interface ScaleJudgement {
  barMiB: number;
  /** REPORTED, NOT JUDGED — see section 4. */
  cpuSecondsPerKRow: number | null;
  maxFleetRssMiB: number | null;
  maxMachineBunRssMiB: number | null;
  perRepoMaxMiB: number | null;
  ramGuardMiB: number;
  ramGuardVerdict: "BREACHED" | "INSUFFICIENT DATA" | "WITHIN";
  soak105FleetMaxMiB: number;
  verdict: "INSUFFICIENT DATA" | "SUPERLINEAR" | "WITHIN BUDGET";
}

export function judgeScale(
  fleet: readonly FleetSample[],
  repoCount: number,
  totalRows: number | null,
): ScaleJudgement {
  const barMiB = Number((repoCount * SOAK105_FLEET_MAX_MIB * LINEARITY_TOLERANCE).toFixed(2));
  const valid = fleet.filter(
    (sample) => sample.sampleError === undefined && (sample.fleetRssMiB ?? 0) > 0,
  );
  const machine = valid.flatMap((sample) =>
    typeof sample.machineBunRssGiB === "number" ? [sample.machineBunRssGiB * 1024] : [],
  );
  const maxMachineBunRssMiB = machine.length === 0 ? null : Math.max(...machine);
  const ramGuardVerdict =
    maxMachineBunRssMiB === null
      ? "INSUFFICIENT DATA"
      : maxMachineBunRssMiB >= RAM_GUARD_MIB
        ? "BREACHED"
        : "WITHIN";
  if (valid.length === 0) {
    return {
      barMiB,
      cpuSecondsPerKRow: null,
      maxFleetRssMiB: null,
      maxMachineBunRssMiB: round(maxMachineBunRssMiB, 1),
      perRepoMaxMiB: null,
      ramGuardMiB: RAM_GUARD_MIB,
      ramGuardVerdict,
      soak105FleetMaxMiB: SOAK105_FLEET_MAX_MIB,
      verdict: "INSUFFICIENT DATA",
    };
  }
  const maxFleetRssMiB = Math.max(...valid.map((sample) => sample.fleetRssMiB!));
  const cpu = valid.at(-1)?.fleetCpuSeconds ?? null;
  return {
    barMiB,
    cpuSecondsPerKRow:
      cpu === null || totalRows === null || totalRows <= 0
        ? null
        : round((cpu / totalRows) * 1000),
    maxFleetRssMiB: round(maxFleetRssMiB, 2),
    maxMachineBunRssMiB: round(maxMachineBunRssMiB, 1),
    perRepoMaxMiB: round(maxFleetRssMiB / repoCount, 2),
    ramGuardMiB: RAM_GUARD_MIB,
    ramGuardVerdict,
    soak105FleetMaxMiB: SOAK105_FLEET_MAX_MIB,
    verdict: maxFleetRssMiB <= barMiB ? "WITHIN BUDGET" : "SUPERLINEAR",
  };
}

export interface RepoGrowth {
  archiveBytes: number | null;
  bytesPerRow: number | null;
  finalRows: number | null;
  firstSettledRows: number | null;
  repo: number;
  rowsGained: number | null;
}

/** Section 6: reported, never judged. #110's imported bars do the judging. */
export function growthFor(repo: number, samples: readonly RepoSample[]): RepoGrowth {
  const withRows = samples.filter((sample) => sample.rows !== null);
  const settled = withRows.filter((sample) => sample.elapsedMinutes >= FROZEN_SETTLE_MIN);
  const last = withRows.at(-1) ?? null;
  const first = settled.at(0) ?? null;
  return {
    archiveBytes: last?.archiveBytes ?? null,
    bytesPerRow:
      last?.archiveBytes && last.rows ? round(last.archiveBytes / last.rows, 1) : null,
    finalRows: last?.rows ?? null,
    firstSettledRows: first?.rows ?? null,
    repo,
    rowsGained:
      last?.rows !== undefined && last?.rows !== null && first?.rows !== undefined && first?.rows !== null
        ? last.rows - first.rows
        : null,
  };
}

export interface ScaleReport {
  attribution: AttributionJudgement;
  decisionRule: {
    eyesPerRepo: number;
    frozenSettleMinutes: number;
    linearityTolerance: number;
    note: string;
    origin: string;
    ramGuardMiB: number;
    soak105FleetMaxMiB: number;
  };
  frozen: FrozenJudgement[];
  growth: RepoGrowth[];
  isolation: IsolationJudgement[];
  latency: Array<{ repo: number; report: Report }>;
  repoCount: number;
  scale: ScaleJudgement;
  verdict: string;
}

export function judgeRun(scratch: string): ScaleReport {
  const seriesFiles = readdirSync(scratch)
    .filter((name) => /^series-repo-\d+\.jsonl$/.test(name))
    .sort();
  const repoCount = seriesFiles.length;
  const perRepo = seriesFiles.map((name) => readJsonl<RepoSample>(join(scratch, name)));
  const fleet = readJsonl<FleetSample>(join(scratch, "fleet.jsonl"));

  const isolation = perRepo.map((samples, repo) => judgeIsolation(repo, samples));
  // Only repos that `traffic116.ts` leaves untouched are frozen; a driven repo
  // growing is the intended behaviour, not a finding.
  const frozen = perRepo.flatMap((samples, repo) =>
    repo >= 2 ? [judgeFrozen(repo, samples)] : [],
  );
  const attribution = judgeAttribution(fleet, repoCount);
  const totalRows = perRepo.reduce<number | null>((sum, samples) => {
    const rows = samples.filter((sample) => sample.rows !== null).at(-1)?.rows ?? null;
    return sum === null || rows === null ? null : sum + rows;
  }, 0);
  const scale = judgeScale(fleet, repoCount, totalRows);
  const growth = perRepo.map((samples, repo) => growthFor(repo, samples));
  // `latency.ts` unchanged, once per repo. See the docblock.
  const latency = perRepo.map((samples, repo) => ({ repo, report: judge(samples) }));

  const parts = [
    `isolation=${isolation.map((entry) => entry.verdict).join("/")}`,
    `frozen=${frozen.map((entry) => entry.verdict).join("/") || "NONE"}`,
    `attribution=${attribution.verdict}`,
    `scale=${scale.verdict}`,
    `ramGuard=${scale.ramGuardVerdict}`,
    ...latency.map((entry) => `latency[repo${entry.repo}]=${entry.report.verdict}`),
  ];
  const failed =
    isolation.some((entry) => entry.verdict !== "PASS") ||
    frozen.some((entry) => entry.verdict === "GREW") ||
    attribution.verdict !== "PASS" ||
    scale.verdict === "SUPERLINEAR" ||
    scale.ramGuardVerdict === "BREACHED" ||
    latency.some(
      (entry) =>
        entry.report.verdict.includes("REGRESSION") ||
        entry.report.verdict.includes("BREACHED") ||
        entry.report.verdict.includes("NO LONGER FLAT"),
    );

  return {
    attribution,
    decisionRule: {
      eyesPerRepo: EYES_PER_REPO,
      frozenSettleMinutes: FROZEN_SETTLE_MIN,
      linearityTolerance: LINEARITY_TOLERANCE,
      note:
        "Isolation and frozen-corpus flatness have ZERO tolerance and no warm-up exemption. " +
        "Search latency is judged by scripts/soak/latency.ts's registered bars, imported and " +
        "run unchanged once per repo. Fleet CPU is REPORTED, NOT JUDGED: no prior run measured it.",
      origin:
        "scripts/scale/analyze116.ts, committed before the run; RSS anchor from " +
        "docs/acceptance/soak.txt (#105) section 3; latency bars from scripts/soak/latency.ts (#110)",
      ramGuardMiB: RAM_GUARD_MIB,
      soak105FleetMaxMiB: SOAK105_FLEET_MAX_MIB,
    },
    frozen,
    growth,
    isolation,
    latency,
    repoCount,
    scale,
    verdict: `${failed ? "FAIL" : "PASS"} ${parts.join(" ")}`,
  };
}

if (import.meta.main) {
  const scratch = process.argv[2];
  if (!scratch) throw new Error("usage: analyze116.ts <scratch-root>");
  console.log(JSON.stringify(judgeRun(scratch), null, 2));
}
