/**
 * #117's traffic, which is also its evidence for "no message loss".
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT scripts/scale/traffic116.ts WITH A KILLER BOLTED ON
 * ---------------------------------------------------------------------------
 * #116's traffic emitted interchangeable rows and judged them by COUNT. A count
 * cannot answer #117's question. "The archive has 4,013 rows" is consistent with
 * every message landing and also with three landing twice and three being lost.
 * #117 asks whether a specific message sent right before, during, or after a
 * SIGKILL still lands, which is #83's full-journey sentinel-delivery shape:
 * identify the message, then look for THAT message.
 *
 * So every emitted row carries `chaos117_r<repo>_s<seq>` — one token, seq
 * monotonic per repo, `_` included in the archiver's FTS tokenchars so it
 * survives tokenization intact. Loss is then set subtraction over integers, not
 * a difference of two counts: `emitted \ archived`. Zero is the only passing
 * value and it names the missing messages when it is not zero.
 *
 * ---------------------------------------------------------------------------
 * ORDER OF THE TWO WRITES, WHICH IS THE WHOLE CORRECTNESS OF THE LEDGER
 * ---------------------------------------------------------------------------
 * The transcript line is appended FIRST and the ledger line SECOND, never the
 * reverse. If this process is killed between them the ledger under-counts a
 * message that did land, which reads as a clean run. Ledger-first would record
 * a message that was never emitted and report it as LOST — a fabricated failure.
 * The asymmetry is deliberate: the ledger may only ever be a subset of what was
 * really written, so `lost` can never be an artefact of the harness dying.
 *
 * The ledger is also the only place kill-relative timing lives. Each line
 * carries `at` (epoch ms), so the analysis can classify every sentinel as
 * before / during / after each kill window without the killer and the traffic
 * generator having to share memory.
 *
 * Exits when the deadline passes or the owner pid dies, exactly as #116's did,
 * so it can never outlive the run that started it.
 */
import { appendFile, appendFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const append = promisify(appendFile);

const [, , scratchRoot, deadlineArgument, ownerArgument, countArgument] = process.argv;
if (!scratchRoot || !deadlineArgument || !ownerArgument) {
  throw new Error(
    "usage: traffic117.ts <scratch-root> <deadline-epoch-ms> <owner-pid> [repo-count]",
  );
}
const deadline = Number(deadlineArgument);
const owner = Number(ownerArgument);
const repoCount = Number(countArgument ?? 2);

/**
 * 30 rows per 30 s sample — #105/#109/#116's arm A, one row per second, per
 * repo. #117 deliberately does NOT reuse arm B's 300: this run's scarce
 * resource is not throughput, it is the ability to say exactly which messages
 * were in flight across a kill, and a 10 rows/s stream makes every kill window
 * ten times harder to read for no gain in what is being tested.
 */
export const ROWS_PER_SECOND = 1;

const codexSessions = join(scratchRoot, "home", ".codex", "sessions", "2026", "08", "28");

/** Repo i's own rollouts, by the session-id block seed116.ts assigns. */
function rolloutsFor(repo: number): string[] {
  const tag = `-0000-${String(1160 + repo).padStart(4, "0")}-`;
  return readdirSync(codexSessions)
    .filter(
      (name) => name.startsWith("rollout-") && name.endsWith(".jsonl") && name.includes(tag),
    )
    .sort()
    .map((name) => join(codexSessions, name));
}

export function sentinel(repo: number, seq: number): string {
  return `chaos117_r${repo}_s${String(seq).padStart(7, "0")}`;
}

interface Driven {
  files: string[];
  ledger: string;
  ordinal: number;
  repo: number;
  seq: number;
}

const driven: Driven[] = [];
for (let repo = 0; repo < repoCount; repo += 1) {
  const files = rolloutsFor(repo);
  if (files.length === 0) {
    throw new Error(`no rollouts for repo ${repo} under ${codexSessions}`);
  }
  driven.push({
    files,
    ledger: join(scratchRoot, `sentinels-repo-${repo}.jsonl`),
    ordinal: 1_000_000,
    repo,
    seq: 0,
  });
}

function ownerAlive(): boolean {
  try {
    process.kill(owner, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * #116's traffic text with the sentinel token prepended. `marker<repo>` is kept
 * so the cross-repo leakage probe #116 registered still works here unchanged,
 * and all 18 seed vocabulary words are kept so the corpus stays the one #105's
 * search bars were measured against.
 */
async function emit(target: Driven): Promise<void> {
  const token = sentinel(target.repo, target.seq);
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
          text: `${token} marker${target.repo} soak traffic ${target.ordinal} argus watcher rollout cursor provenance archiver digest retro honcho reviewer transcript soak ceiling supervisor backlog session ingest sqlite`,
        },
      ],
    },
  });
  // Transcript first, ledger second. See the docblock: this order is what makes
  // a lost-message report impossible to fabricate by killing the harness.
  await append(file, `${line}\n`);
  await append(
    target.ledger,
    `${JSON.stringify({ at: Date.now(), file, repo: target.repo, seq: target.seq, token })}\n`,
  );
  target.ordinal += 1;
  target.seq += 1;
}

console.log(
  JSON.stringify({
    driven: driven.map(({ files, repo }) => ({ files: files.length, repo })),
    rowsPerSecond: ROWS_PER_SECOND,
    startedAt: new Date().toISOString(),
  }),
);

// A final ledger flush is not needed — every ledger line is fsync-free but
// already written by the time the next second's loop begins, and the analysis
// only ever reads a ledger whose process has exited.
const stopping = { value: false };
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    stopping.value = true;
    appendFileSync(
      join(scratchRoot, "traffic-exit.jsonl"),
      `${JSON.stringify({ at: Date.now(), reason: signal, seqByRepo: driven.map((d) => d.seq) })}\n`,
    );
    process.exit(0);
  });
}

while (Date.now() < deadline && ownerAlive() && !stopping.value) {
  for (const target of driven) {
    for (let index = 0; index < ROWS_PER_SECOND; index += 1) await emit(target);
  }
  await Bun.sleep(1_000);
}
appendFileSync(
  join(scratchRoot, "traffic-exit.jsonl"),
  `${JSON.stringify({ at: Date.now(), reason: "deadline", seqByRepo: driven.map((d) => d.seq) })}\n`,
);
