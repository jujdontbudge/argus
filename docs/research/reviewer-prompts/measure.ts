/**
 * Tickets #69 / #71: measure the Reviewer's prompt against #54's S-series
 * (and `R4`, the environment-fact case) — before and after the prompt split.
 *
 *   bun docs/research/reviewer-prompts/measure.ts --variant frozen  --rep 3
 *   bun docs/research/reviewer-prompts/measure.ts --variant current --rep 3
 *
 * `frozen`  replays the EXACT prompt bytes #54 captured from the production
 *           Reviewer (`docs/research/brain-tiers/cases/*.json`) — the old,
 *           single conflated ask. This is the red baseline; it is a frozen
 *           artifact of a settled study and is never rewritten here.
 * `current` builds the prompts from the PRODUCTION code as it stands now, by
 *           driving the real `ReviewerEye` over #54's real corpus turns, so
 *           the two variants differ in nothing but the prompt under test.
 *
 * Model/effort are the ADR-0002 defaults and are NOT a variable: #54 settled
 * the tier (luna @ low; max measured worse on exactly this judgment) and
 * SPEC §1 item 8 forbids the metered option regardless.
 *
 * One JSON line per run into results/runs.jsonl (append-only).
 */
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { createCodexBrain } from "../../../src/eyes/brain";
import { DEFAULT_EYES_CONFIG } from "../../../src/eyes/config";
import {
  buildExtractionPrompt,
  buildProcedurePrompt,
} from "../../../src/eyes/reviewer/reviewer";
import {
  EXTRACTION_OUTPUT_SCHEMA,
  PROCEDURE_OUTPUT_SCHEMA,
} from "../../../src/eyes/reviewer/schema";
import { CASES_DIR, record } from "../brain-tiers/harness/cases";
import { TURNS } from "../brain-tiers/harness/corpus";

const RESULTS = new URL("./results/", import.meta.url).pathname;

/** #54's case ids, with the corpus turns build.ts fed each one. */
export const CASE_TURNS: Record<string, (keyof typeof TURNS)[]> = {
  "S1-procedure-present": ["tabsNotWorkspaces", "relayedNeverReuse", "asstTabHygiene"],
  "S2-no-procedure": ["askCmuxTiming", "asstStatusNarrative", "askAnythingNeedsMe"],
  "S3-scattered-procedure": [
    "w38Brief",
    "w38Start",
    "w38Green4",
    "w38AllGreen",
    "w38Spec",
    "w38Final",
  ],
  "S4-one-off-incident": ["asstOrphanedTickets", "asstWatchdogRestart"],
  "R4-dense-multi-fact": [
    "testingPolicy",
    "asstOpusFlagsVerified",
    "asstCmuxVersion",
    "noAnthropicApi",
  ],
};

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

interface Call {
  pass: "conflated" | "extraction" | "procedure";
  prompt: string;
  schema: object;
}

async function callsFor(caseId: string, variant: string): Promise<Call[]> {
  if (variant === "frozen") {
    const frozen = (await Bun.file(join(CASES_DIR, `${caseId}.json`)).json()) as {
      prompt: string;
      schema: object;
    };
    return [{ pass: "conflated", prompt: frozen.prompt, schema: frozen.schema }];
  }
  const records = CASE_TURNS[caseId]!.map((k) => record(TURNS[k]!));
  return [
    {
      pass: "extraction",
      prompt: buildExtractionPrompt(records),
      schema: EXTRACTION_OUTPUT_SCHEMA,
    },
    {
      pass: "procedure",
      prompt: buildProcedurePrompt(records),
      schema: PROCEDURE_OUTPUT_SCHEMA,
    },
  ];
}

async function main(): Promise<void> {
  await mkdir(RESULTS, { recursive: true });
  const variant = arg("variant") ?? "current";
  // What to call this run in the results file — e.g. "split" (#69 only) vs
  // "boundary" (#69 + #71), so the two prompt states stay comparable.
  const label = arg("label") ?? variant;
  const rep = Number(arg("rep") ?? "1");
  const only = arg("only")?.split(",").map((s) => s.trim());
  const ids = Object.keys(CASE_TURNS).filter(
    (id) => only === undefined || only.some((p) => id.startsWith(p)),
  );

  const brain = createCodexBrain({
    model: DEFAULT_EYES_CONFIG.brain.model,
    reasoningEffort: DEFAULT_EYES_CONFIG.brain.reasoningEffort,
  });
  const cwd = process.cwd();
  const out = join(RESULTS, "runs.jsonl");

  const jobs: { id: string; rep: number; call: Call }[] = [];
  for (let r = 1; r <= rep; r += 1) {
    for (const id of ids) {
      for (const call of await callsFor(id, variant)) jobs.push({ id, rep: r, call });
    }
  }
  console.error(`${jobs.length} calls (variant=${variant}, label=${label}, rep=${rep})`);

  let done = 0;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const job = jobs[cursor];
      cursor += 1;
      if (job === undefined) return;
      const started = Date.now();
      const outcome = await brain.evaluate({
        prompt: job.call.prompt,
        schema: job.call.schema,
        cwd,
      });
      const ms = Date.now() - started;
      await appendFile(
        out,
        `${JSON.stringify({
          case: job.id,
          variant,
          label,
          pass: job.call.pass,
          rep: job.rep,
          model: DEFAULT_EYES_CONFIG.brain.model,
          effort: DEFAULT_EYES_CONFIG.brain.reasoningEffort,
          ms,
          ok: outcome.ok,
          ...(outcome.ok
            ? { text: outcome.text, usage: outcome.usage ?? null }
            : { reason: outcome.reason, detail: outcome.detail.slice(0, 800) }),
          at: new Date().toISOString(),
        })}\n`,
      );
      done += 1;
      console.error(
        `[${done}/${jobs.length}] ${job.id} ${job.call.pass} rep${job.rep} ${(ms / 1000).toFixed(1)}s ${outcome.ok ? "ok" : `FAIL ${outcome.reason}`}`,
      );
    }
  };
  await Promise.all(Array.from({ length: 3 }, worker));
}

if (import.meta.main) await main();
