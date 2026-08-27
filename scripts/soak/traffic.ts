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
 */
import { appendFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const [, , codexDirectory, deadlineArgument, ownerArgument] = process.argv;
if (!codexDirectory || !deadlineArgument || !ownerArgument) {
  throw new Error("usage: traffic.ts <codex-sessions-dir> <deadline-epoch-ms> <owner-pid>");
}
const deadline = Number(deadlineArgument);
const owner = Number(ownerArgument);

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
while (Date.now() < deadline && ownerAlive()) {
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
  await Bun.sleep(1_000);
}
