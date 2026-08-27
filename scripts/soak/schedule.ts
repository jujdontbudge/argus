/**
 * Print the pre-registered schedule, or one constant from it, for the shell.
 *
 * `run109.sh` must not carry its own copy of the phase design. If the driver
 * hard-coded 960 minutes and `phases.ts` said something else, the run and the
 * analysis would silently disagree about what happened, which is the one
 * failure mode a pre-registration cannot survive. So there is exactly one
 * source and the shell reads it through here.
 *
 * usage:
 *   schedule.ts totalMinutes | sampleIntervalSeconds | phaseSettleMinutes
 *   schedule.ts json <run-start-epoch-seconds>
 */
import {
  PHASES,
  PHASE_SETTLE_MINUTES,
  SAMPLE_INTERVAL_SECONDS,
  TOTAL_MINUTES,
  WARMUP_MINUTES,
  rateName,
} from "./phases.ts";

const what = process.argv[2];

if (what === "json") {
  const startedAtEpoch = Number(process.argv[3] ?? 0);
  console.log(
    JSON.stringify(
      {
        phaseSettleMinutes: PHASE_SETTLE_MINUTES,
        phases: PHASES.map((phase) => ({
          endMinute: phase.endMinute,
          endsAt: new Date((startedAtEpoch + phase.endMinute * 60) * 1000).toISOString(),
          label: phase.label,
          rate: rateName(phase.rowsPerSample),
          rowsPerSample: phase.rowsPerSample,
          startMinute: phase.startMinute,
          startsAt: new Date((startedAtEpoch + phase.startMinute * 60) * 1000).toISOString(),
        })),
        sampleIntervalSeconds: SAMPLE_INTERVAL_SECONDS,
        totalMinutes: TOTAL_MINUTES,
        warmupMinutes: WARMUP_MINUTES,
      },
      null,
      2,
    ),
  );
} else {
  const constants: Record<string, number> = {
    phaseSettleMinutes: PHASE_SETTLE_MINUTES,
    sampleIntervalSeconds: SAMPLE_INTERVAL_SECONDS,
    totalMinutes: TOTAL_MINUTES,
    warmupMinutes: WARMUP_MINUTES,
  };
  const value = what === undefined ? undefined : constants[what];
  if (value === undefined) {
    throw new Error(
      `usage: schedule.ts <${Object.keys(constants).join("|")}|json <epoch-seconds>>`,
    );
  }
  console.log(value);
}
