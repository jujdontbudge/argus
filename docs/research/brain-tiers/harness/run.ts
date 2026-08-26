/**
 * Ticket #54: run every candidate config over the SAME fixed cases, through
 * the production brain seam (`createCodexBrain` — the exact `codex exec`
 * argv src/eyes/brain.ts builds, including `-m` and
 * `-c model_reasoning_effort=...`).
 *
 *   bun docs/research/brain-tiers/harness/run.ts [--only R1,T2] [--configs luna:max]
 *                                                [--rep 2] [--concurrency 3]
 *
 * One JSON line per run into ../results/runs.jsonl (append-only, so a
 * killed run resumes by re-running with --only for what is missing).
 */
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { loadavg } from "node:os";

import { createCodexBrain } from "../../../../src/eyes/brain";
import { CASES_DIR, type EvalCase } from "./cases";

const RESULTS = new URL("../results/", import.meta.url).pathname;

export interface Config {
  id: string;
  model: string;
  effort: string;
}

export const CONFIGS: Config[] = [
  { id: "luna-low", model: "gpt-5.6-luna", effort: "low" },
  { id: "luna-medium", model: "gpt-5.6-luna", effort: "medium" },
  { id: "luna-max", model: "gpt-5.6-luna", effort: "max" },
  { id: "sol-low", model: "gpt-5.6-sol", effort: "low" },
  { id: "sol-medium", model: "gpt-5.6-sol", effort: "medium" },
];

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function loadCases(): Promise<EvalCase[]> {
  const files = (await readdir(CASES_DIR)).filter((f) => f.endsWith(".json")).sort();
  const out: EvalCase[] = [];
  for (const f of files) {
    out.push((await Bun.file(join(CASES_DIR, f)).json()) as EvalCase);
  }
  return out;
}

async function main(): Promise<void> {
  await mkdir(RESULTS, { recursive: true });
  const only = arg("only")?.split(",").map((s) => s.trim());
  const configFilter = arg("configs")?.split(",").map((s) => s.trim());
  const rep = Number(arg("rep") ?? "1");
  const concurrency = Number(arg("concurrency") ?? "3");

  const all = await loadCases();
  const cases = only ? all.filter((c) => only.some((p) => c.id.startsWith(p))) : all;
  const configs = configFilter
    ? CONFIGS.filter((c) => configFilter.includes(c.id))
    : CONFIGS;

  const jobs: { c: EvalCase; cfg: Config; rep: number }[] = [];
  for (let r = 1; r <= rep; r += 1) {
    for (const c of cases) for (const cfg of configs) jobs.push({ c, cfg, rep: r });
  }
  console.error(
    `${jobs.length} runs: ${cases.length} cases x ${configs.length} configs x ${rep} rep(s), concurrency ${concurrency}`,
  );

  const out = join(RESULTS, "runs.jsonl");
  let done = 0;
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      const job = jobs[index];
      if (job === undefined) return;
      const brain = createCodexBrain({
        model: job.cfg.model,
        reasoningEffort: job.cfg.effort,
      });
      const load = loadavg()[0] ?? 0;
      const started = Date.now();
      const outcome = await brain.evaluate({
        prompt: job.c.prompt,
        schema: job.c.schema,
        cwd: job.c.cwd,
      });
      const ms = Date.now() - started;
      const row = {
        case: job.c.id,
        eye: job.c.eye,
        config: job.cfg.id,
        model: job.cfg.model,
        effort: job.cfg.effort,
        rep: job.rep,
        ms,
        loadAtStart: Number(load.toFixed(1)),
        ok: outcome.ok,
        ...(outcome.ok
          ? { text: outcome.text, usage: outcome.usage ?? null }
          : { reason: outcome.reason, detail: outcome.detail.slice(0, 800) }),
        at: new Date().toISOString(),
      };
      await appendFile(out, `${JSON.stringify(row)}\n`);
      done += 1;
      console.error(
        `[${done}/${jobs.length}] ${job.c.id} ${job.cfg.id} rep${job.rep} ${(ms / 1000).toFixed(1)}s ${outcome.ok ? "ok" : `FAIL ${outcome.reason}`}`,
      );
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
}

// Guard: this module also exports CONFIGS, and an importer must not launch
// the matrix as a side effect.
if (import.meta.main) await main();
