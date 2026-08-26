/**
 * Tickets #69 / #71: grade the runs `measure.ts` recorded.
 *
 *   bun docs/research/reviewer-prompts/grade.ts            # summary table
 *   bun docs/research/reviewer-prompts/grade.ts --dump S3  # every finding
 *
 * The mechanical checks only. Whether `S1`/`S3`'s procedure is the
 * TRANSFERABLE method or a restatement of the episode is a human read — this
 * prints the text so a human can make it, and never scores it silently.
 *
 * Ground truth is #54's, read from `../brain-tiers/cases/<id>.json`; nothing
 * here rewrites it.
 */
import { join } from "node:path";

const RESULTS = new URL("./results/runs.jsonl", import.meta.url).pathname;
const CASES = new URL("../brain-tiers/cases/", import.meta.url).pathname;

interface Finding {
  kind: string;
  slug: string;
  title: string;
  content: string;
  sources: string[];
}

interface Row {
  case: string;
  label?: string;
  variant: string;
  pass: string;
  rep: number;
  ok: boolean;
  text?: string;
  usage?: { outputTokens?: number } | null;
}

function findingsOf(row: Row): Finding[] {
  if (!row.ok || row.text === undefined) return [];
  try {
    return (JSON.parse(row.text) as { findings: Finding[] }).findings;
  } catch {
    return [];
  }
}

/** The environment fact #71 is about: #54's `R4` cmux version floor. */
function isCmuxFact(finding: Finding): boolean {
  return /0\.64\.22/.test(finding.content);
}

const rows = (await Bun.file(RESULTS).text())
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line) as Row);

const dumpAt = process.argv.indexOf("--dump");
const dumpCase = dumpAt === -1 ? undefined : process.argv[dumpAt + 1];

/** One attempt = one (label, case, rep) — both passes of it together. */
const attempts = new Map<string, Row[]>();
for (const row of rows) {
  const key = `${row.label ?? row.variant} ${row.case} ${row.rep}`;
  attempts.set(key, [...(attempts.get(key) ?? []), row]);
}

const truths = new Map<string, { maxProcedures?: number }>();
for (const id of new Set(rows.map((row) => row.case))) {
  const file = (await Bun.file(join(CASES, `${id}.json`)).json()) as {
    groundTruth: { maxProcedures?: number };
  };
  truths.set(id, file.groundTruth);
}

interface Tally {
  attempts: number;
  procedures: number;
  withProcedure: number;
  overGeneralised: number;
  cmuxAsFact: number;
  cmuxAsProcedure: number;
  outputTokens: number;
}

const tallies = new Map<string, Tally>();

for (const [key, group] of [...attempts].sort()) {
  const [label, id, rep] = key.split(" ") as [string, string, string];
  const findings = group.flatMap(findingsOf);
  const procedures = findings.filter((finding) => finding.kind === "procedure");
  const truth = truths.get(id) ?? {};
  const tallyKey = `${label} ${id}`;
  const tally = tallies.get(tallyKey) ?? {
    attempts: 0,
    procedures: 0,
    withProcedure: 0,
    overGeneralised: 0,
    cmuxAsFact: 0,
    cmuxAsProcedure: 0,
    outputTokens: 0,
  };
  tally.attempts += 1;
  tally.procedures += procedures.length;
  if (procedures.length > 0) tally.withProcedure += 1;
  if (truth.maxProcedures === 0 && procedures.length > 0) tally.overGeneralised += 1;
  if (findings.some((f) => f.kind === "project-fact" && isCmuxFact(f))) {
    tally.cmuxAsFact += 1;
  }
  if (procedures.some(isCmuxFact)) tally.cmuxAsProcedure += 1;
  tally.outputTokens += group.reduce(
    (sum, row) => sum + (row.usage?.outputTokens ?? 0),
    0,
  );
  tallies.set(tallyKey, tally);

  if (dumpCase !== undefined && id.startsWith(dumpCase)) {
    console.log(`\n=== ${label} ${id} rep${rep}`);
    for (const row of group) {
      for (const finding of findingsOf(row)) {
        console.log(
          `  (${row.pass}) [${finding.kind}] ${finding.slug}: ${finding.title}`,
        );
        console.log(`      ${finding.content.replace(/\s+/g, " ").slice(0, 220)}`);
      }
    }
  }
}

if (dumpCase === undefined) {
  console.log(
    "label       case                      n  procs  any  over-gen  cmux:fact  cmux:skill  out-tok/attempt",
  );
  for (const [key, tally] of [...tallies].sort()) {
    const [label, id] = key.split(" ") as [string, string];
    const cells = [
      label.padEnd(11),
      id.padEnd(24),
      String(tally.attempts).padStart(2),
      String(tally.procedures).padStart(6),
      String(tally.withProcedure).padStart(4),
      String(tally.overGeneralised).padStart(9),
      String(tally.cmuxAsFact).padStart(10),
      String(tally.cmuxAsProcedure).padStart(11),
      String(Math.round(tally.outputTokens / tally.attempts)).padStart(16),
    ];
    console.log(cells.join(" "));
  }
}
