/**
 * #116's concurrent multi-repo traffic. ONE process, N repos, N rates.
 *
 * ---------------------------------------------------------------------------
 * THE RATE ASSIGNMENT, AND WHY THE THIRD REPO GETS NOTHING
 * ---------------------------------------------------------------------------
 * #116 asks for concurrent traffic into at least two repos "at rates similar to
 * #109's A/B (30/300 rows per sample)". #109 ran those as sequential PHASES of
 * one fleet because its question was within-subject: does RSS track rows or
 * minutes. #116's question is different — it is about repos telling each other
 * apart — so the rates are assigned across repos and held there:
 *
 *   repo 0   A =  30 rows/sample   1 row/s.  #105 and #109's arm A exactly.
 *   repo 1   B = 300 rows/sample  10 rows/s. #109's arm B exactly.
 *   repo 2+  Z =   0 rows/sample   FROZEN after seeding.
 *
 * Concurrent rather than sequential is the right shape here, and it does not
 * reintroduce the confound #109's `phases.ts` forbade. That prohibition was
 * against concurrent FLEETS, on two grounds: R5's blast radius, and three
 * fleets sharing one load average confounding the arms against each other. This
 * is ONE fleet under one supervisor (R5 holds), and the load confound does not
 * bite because #110's bars are per-ARCHIVED-ROW — an x-axis of rows, not
 * minutes — so a shared load excursion moves both repos' latencies together
 * without moving either repo's cost-per-row.
 *
 * THE FROZEN REPO IS THE SHARPEST INSTRUMENT IN THE RUN, and is the reason N=3
 * rather than N=2. Repo 2 receives no traffic at all, so its archive row count
 * must be FLAT from the moment its cold-start catchUp drains. Repo 1 is being
 * driven at ten rows a second three directories away, under the same supervisor,
 * out of the same shared `~/.claude` and `~/.codex` trees. Any row that appears
 * in repo 2's archive after warm-up came from somewhere else. That is a
 * leakage test with no statistics in it — the expected value is a constant, and
 * the observation either equals it or does not.
 *
 * A 10x rate ratio between two CONCURRENT repos does the same job from the other
 * direction: if the filter leaked, repo 0's corpus would grow at something like
 * repo 1's rate rather than its own, and the two are an order of magnitude apart.
 *
 * ---------------------------------------------------------------------------
 * THE MESSAGE TEXT, AND ONE HONEST DEVIATION FROM #110's PRECONDITION
 * ---------------------------------------------------------------------------
 * `scripts/soak/latency.ts` states a precondition its bars depend on: they are
 * per-archived-row, the archived-to-matched conversion is a property of the seed
 * vocabulary and the traffic text, and the bars "are valid only for a #109 that
 * re-runs seed.ts and traffic.ts unchanged".
 *
 * This file does not re-run it unchanged. It adds exactly one token, `marker<i>`,
 * to the front of #105's traffic string. It has to: without a per-repo token
 * there is no direct leakage query, and leakage is the property #116 exists to
 * check. The rest of the string — all 18 seed vocabulary words plus "traffic" —
 * is byte-identical, so all three registered query strings still match every
 * traffic row exactly as they did in #105.
 *
 * The effect is quantified rather than waved at: 20 tokens becomes 21, about 5%
 * more index per row, for the SAME matched-row count. Cost tracks matched rows,
 * so a row here costs about 5% more to index and the same to match. That makes
 * the inherited bars slightly HARDER to pass, never easier, which is the only
 * direction in which borrowing a bar is defensible. A #116 repo that comes in
 * under #110's bar is under it with margin to spare.
 *
 * Exits on its own when the deadline passes or the owner pid dies, so it can
 * never outlive the run that started it.
 */
import { appendFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const [, , scratchRoot, deadlineArgument, ownerArgument, countArgument] = process.argv;
if (!scratchRoot || !deadlineArgument || !ownerArgument) {
  throw new Error(
    "usage: traffic116.ts <scratch-root> <deadline-epoch-ms> <owner-pid> [repo-count]",
  );
}
const deadline = Number(deadlineArgument);
const owner = Number(ownerArgument);
const repoCount = Number(countArgument ?? 3);

/** #109's `phases.ts` rate names and values, per repo instead of per phase. */
export const ROWS_PER_SAMPLE: readonly number[] = [30, 300];
export const SAMPLE_INTERVAL_SECONDS = 30;

function rowsPerSampleFor(repo: number): number {
  return ROWS_PER_SAMPLE[repo] ?? 0;
}

const codexSessions = join(scratchRoot, "home", ".codex", "sessions", "2026", "08", "28");

/** Repo i's own rollouts, identified by the session-id block seed116.ts assigns. */
function rolloutsFor(repo: number): string[] {
  const tag = `-0000-${String(1160 + repo).padStart(4, "0")}-`;
  return readdirSync(codexSessions)
    .filter((name) => name.startsWith("rollout-") && name.endsWith(".jsonl") && name.includes(tag))
    .sort()
    .map((name) => join(codexSessions, name));
}

interface Driven {
  files: string[];
  ordinal: number;
  perSecond: number;
  repo: number;
}

const driven: Driven[] = [];
for (let repo = 0; repo < repoCount; repo += 1) {
  const rows = rowsPerSampleFor(repo);
  if (rows === 0) continue;
  const files = rolloutsFor(repo);
  if (files.length === 0) throw new Error(`no rollouts for repo ${repo} under ${codexSessions}`);
  driven.push({ files, ordinal: 1_000_000, perSecond: rows / SAMPLE_INTERVAL_SECONDS, repo });
}
if (driven.length < 2) {
  throw new Error("#116 requires concurrent traffic into at least two repos");
}

function ownerAlive(): boolean {
  try {
    process.kill(owner, 0);
    return true;
  } catch {
    return false;
  }
}

/** One message. #105's text with `marker<i>` prepended; see the docblock. */
async function emit(target: Driven): Promise<void> {
  const file = target.files[target.ordinal % target.files.length]!;
  const role = target.ordinal % 2 === 1 ? "user" : "assistant";
  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    ordinal: target.ordinal,
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [
        {
          type: role === "user" ? "input_text" : "output_text",
          text: `marker${target.repo} soak traffic ${target.ordinal} argus watcher rollout cursor provenance archiver digest retro honcho reviewer transcript soak ceiling supervisor backlog session ingest sqlite`,
        },
      ],
    },
  });
  await appendFile(file, `${line}\n`);
  target.ordinal += 1;
}

console.log(
  JSON.stringify({
    driven: driven.map(({ files, perSecond, repo }) => ({
      files: files.length,
      perSecond,
      repo,
      rowsPerSample: rowsPerSampleFor(repo),
    })),
    frozen: Array.from({ length: repoCount }, (_, repo) => repo).filter(
      (repo) => rowsPerSampleFor(repo) === 0,
    ),
  }),
);

// Rates are steady per second, not bursty per sample, for the reason #109's
// traffic.ts gives: a burst would make the series a picture of the burst.
while (Date.now() < deadline && ownerAlive()) {
  for (const target of driven) {
    for (let index = 0; index < target.perSecond; index += 1) await emit(target);
  }
  await Bun.sleep(1_000);
}
