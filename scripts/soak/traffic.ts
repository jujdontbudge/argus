/**
 * Keep the seeded transcripts LIVE for the whole soak (#105).
 *
 * A soak against a frozen transcript tree proves only that an idle poll is
 * cheap. The #86 incident happened on a fleet doing real work, so the fleet
 * under test has to keep ingesting: new lines mean new records, new archive
 * rows, new FTS index churn and a WAL that actually has to check point.
 *
 * The rate is deliberately modest (one message per second, round-robined
 * across the seeded sessions). A firehose would prove the eyes can be
 * overwhelmed, which is not the question; the question is whether steady,
 * realistic work leaves a residue behind after hours.
 *
 * Exits on its own when the deadline passes or the owner pid dies, so it can
 * never outlive the run that started it.
 *
 * ---------------------------------------------------------------------------
 * PHASED MODE (#109), OPT-IN AND OTHERWISE INERT
 * ---------------------------------------------------------------------------
 * #105's fatal ambiguity was that this generator's FIXED rate made `rows` a
 * synonym for `elapsed` (Pearson r = 1.000000, #105 section 7 Test 1), so
 * "grows with the corpus" and "grows with uptime" were the same claim. Passing
 * `--phased` as a fourth argument makes the rate follow the pre-registered
 * schedule in ./phases.ts instead, which breaks that collinearity BY
 * CONSTRUCTION rather than by statistics.
 *
 * WITHOUT the flag the behaviour is byte-for-byte what #105 ran: one message
 * per second, forever, round-robined across the seeded sessions. That default
 * is load-bearing and is not to be "cleaned up" — #105's series has to stay
 * reproducible, and #110's per-archived-row bars are only valid against this
 * exact message text.
 *
 * THE MESSAGE TEXT IS IDENTICAL IN BOTH MODES. Only the RATE moves. This is a
 * precondition of `latency.ts`'s registered bars, whose docblock states they
 * are per-ARCHIVED-row and that the archived-to-matched conversion is a
 * property of the seed vocabulary and this string. Changing the rate does not
 * touch that conversion; changing the words would.
 */
import { appendFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import { SAMPLE_INTERVAL_SECONDS, phaseAt } from "./phases.ts";

const [, , codexDirectory, deadlineArgument, ownerArgument, modeArgument, epochArgument] =
  process.argv;
if (!codexDirectory || !deadlineArgument || !ownerArgument) {
  throw new Error(
    "usage: traffic.ts <codex-sessions-dir> <deadline-epoch-ms> <owner-pid> [--phased <run-start-epoch-ms>]",
  );
}
const deadline = Number(deadlineArgument);
const owner = Number(ownerArgument);
const phased = modeArgument === "--phased";
/**
 * The RUN's clock, not this process's. The sampler is handed the same epoch,
 * so "elapsed minute 210" means the same instant to the thing changing the
 * rate and the thing recording it. Without a shared origin the two would drift
 * by however long the driver took between spawning them, and every phase
 * boundary in the series would be labelled slightly wrong.
 */
const startedAt = epochArgument === undefined ? Date.now() : Number(epochArgument);

const files = readdirSync(codexDirectory)
  .filter((name) => name.startsWith("rollout-") && name.endsWith(".jsonl"))
  .sort()
  .map((name) => join(codexDirectory, name));
if (files.length === 0) throw new Error(`no rollouts under ${codexDirectory}`);

function ownerAlive(): boolean {
  try {
    process.kill(owner, 0);
    return true;
  } catch {
    return false;
  }
}

let ordinal = 1_000_000;

/** One message. The text is identical in both modes; see the docblock. */
async function emit(): Promise<void> {
  const file = files[ordinal % files.length]!;
  const role = ordinal % 2 === 1 ? "user" : "assistant";
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    ordinal,
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [
        {
          type: role === "user" ? "input_text" : "output_text",
          text: `soak traffic ${ordinal} argus watcher rollout cursor provenance archiver digest retro honcho reviewer transcript soak ceiling supervisor backlog session ingest sqlite`,
        },
      ],
    },
  });
  await appendFile(file, `${line}\n`);
  ordinal += 1;
}

/**
 * Messages to emit this second under the pre-registered schedule: the phase's
 * rows-per-30s-sample divided across the 30 seconds of that sample, so a
 * 300-rows/sample phase is a steady 10/s rather than a burst of 300 followed
 * by 29 seconds of silence. Steady matters: a burst would make the RSS series
 * a picture of the burst, and the question is about a sustained regime.
 */
function perSecondFor(elapsedMinutes: number): number {
  const phase = phaseAt(elapsedMinutes);
  if (phase === null) return 0;
  return phase.rowsPerSample / SAMPLE_INTERVAL_SECONDS;
}

while (Date.now() < deadline && ownerAlive()) {
  const perSecond = phased
    ? perSecondFor((Date.now() - startedAt) / 60_000)
    : 1;
  for (let index = 0; index < perSecond; index += 1) await emit();
  await Bun.sleep(1_000);
}
