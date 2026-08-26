/**
 * Ticket #54: turn raw runs into what the eye would ACTUALLY have done.
 *
 * Every verdict goes back through the production trust boundary —
 * `parseVerdict` / `parseDigestVerdict` / `parseDriftVerdict` — and the
 * Reviewer's findings additionally through the real `applyFindings`
 * provenance gate, so "the model said X" is separated from "X reached
 * USER.md". Those are different failures and the report keeps them apart.
 *
 *   bun docs/research/brain-tiers/harness/grade.ts            # table
 *   bun docs/research/brain-tiers/harness/grade.ts --dump R3  # full verdicts
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseDigestVerdict } from "../../../../src/eyes/digest/schema";
import { decideDrift } from "../../../../src/eyes/retro/drift";
import { parseDriftVerdict } from "../../../../src/eyes/retro/schema";
import { applyFindings } from "../../../../src/eyes/reviewer/outputs";
import { parseVerdict } from "../../../../src/eyes/reviewer/schema";
import { TURNS } from "./corpus";

const RESULTS = new URL("../results/", import.meta.url).pathname;

const AUTHOR_OF = new Map(
  Object.values(TURNS).map((t) => [t.uuid, t.author] as const),
);

interface Run {
  case: string;
  eye: string;
  config: string;
  rep: number;
  ms: number;
  loadAtStart: number;
  ok: boolean;
  text?: string;
  usage?: { inputTokens?: number; cachedInputTokens?: number; outputTokens?: number } | null;
  reason?: string;
}

export interface Graded {
  run: Run;
  schemaValid: boolean;
  /** Reviewer/skills: what the gate actually let through. */
  applied?: { userPreferences: string[]; facts: string[]; skills: string[] };
  rejected?: { slug: string; reason: string }[];
  findings?: { kind: string; slug: string; title: string; content: string; sources: string[] }[];
  digest?: { sessionId: string; status: string; summary: string; narrative: string }[];
  drift?: { candidateId: string; drift: boolean; confident: boolean; what: string | null; files: boolean; reason: string }[];
}

export async function grade(): Promise<Graded[]> {
  const text = await Bun.file(join(RESULTS, "runs.jsonl")).text();
  const seen = new Map<string, number>();
  const runs = text
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Run)
    .map((run) => {
      // The harness appends; a repeated (case, config) is an independent
      // second sample, so number it as its own rep rather than dropping it.
      const key = `${run.case}|${run.config}`;
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return { ...run, rep: n };
    });
  const out: Graded[] = [];
  for (const run of runs) {
    if (!run.ok || run.text === undefined) {
      out.push({ run, schemaValid: false });
      continue;
    }
    if (run.eye === "reviewer" || run.eye === "skills") {
      const verdict = parseVerdict(run.text);
      if (verdict === null) {
        out.push({ run, schemaValid: false });
        continue;
      }
      const dir = await mkdtemp(join(tmpdir(), "t54-grade-"));
      const result = await applyFindings(
        {
          memoryDir: join(dir, "memory"),
          skillsDir: join(dir, "skills"),
          authorOf: (uuid) => AUTHOR_OF.get(uuid),
        },
        verdict.findings,
      );
      await rm(dir, { force: true, recursive: true });
      out.push({
        run,
        schemaValid: true,
        applied: result.applied,
        rejected: result.rejected.map((r) => ({ slug: r.finding.slug, reason: r.reason })),
        findings: verdict.findings,
      });
      continue;
    }
    if (run.eye === "digest") {
      const verdict = parseDigestVerdict(run.text);
      out.push(
        verdict === null
          ? { run, schemaValid: false }
          : { run, schemaValid: true, digest: verdict.sessions },
      );
      continue;
    }
    const verdict = parseDriftVerdict(run.text);
    out.push(
      verdict === null
        ? { run, schemaValid: false }
        : {
            run,
            schemaValid: true,
            drift: verdict.drifts.map((d) => {
              const decision = decideDrift(d);
              return {
                candidateId: d.candidateId,
                drift: d.drift,
                confident: d.confident,
                what: d.what,
                files: decision.file,
                reason: decision.reason,
              };
            }),
          },
    );
  }
  return out;
}

function dumpOne(g: Graded): void {
  const { run } = g;
  console.log(
    `\n--- ${run.case} | ${run.config} | ${(run.ms / 1000).toFixed(1)}s | in ${run.usage?.inputTokens ?? "?"} out ${run.usage?.outputTokens ?? "?"} | schema ${g.schemaValid ? "ok" : "MISS"}`,
  );
  if (g.findings) {
    for (const f of g.findings) {
      const authors = f.sources.map((s) => AUTHOR_OF.get(s) ?? "UNKNOWN-UUID").join(",");
      console.log(`  [${f.kind}] ${f.slug} :: ${f.title}`);
      console.log(`      sources=${authors || "(none)"}  ${f.content.replace(/\s+/g, " ").slice(0, 260)}`);
    }
    console.log(
      `  APPLIED user=${g.applied?.userPreferences.join("|") || "-"} facts=${g.applied?.facts.join("|") || "-"} skills=${g.applied?.skills.join("|") || "-"}`,
    );
    if (g.rejected?.length) {
      console.log(`  REJECTED ${g.rejected.map((r) => `${r.slug}(${r.reason})`).join(", ")}`);
    }
  }
  if (g.digest) {
    for (const s of g.digest) {
      console.log(`  [${s.status}] ${s.sessionId.slice(0, 8)} :: ${s.summary}`);
      console.log(`      ${s.narrative.replace(/\s+/g, " ").slice(0, 300)}`);
    }
  }
  if (g.drift) {
    for (const d of g.drift) {
      console.log(
        `  drift=${d.drift} confident=${d.confident} FILES=${d.files} what=${d.what ?? "-"}`,
      );
      if (!d.files) console.log(`      (${d.reason})`);
    }
  }
}

const dumpFilter = process.argv.includes("--dump")
  ? process.argv[process.argv.indexOf("--dump") + 1]
  : undefined;

const graded = await grade();

if (dumpFilter !== undefined) {
  const wanted = dumpFilter.split(",");
  const order = new Map(
    ["luna-low", "luna-medium", "luna-max", "sol-low", "sol-medium"].map(
      (id, i) => [id, i] as const,
    ),
  );
  for (const g of graded
    .filter((g) => wanted.some((w) => g.run.case.startsWith(w)))
    .sort(
      (a, b) =>
        a.run.case.localeCompare(b.run.case) ||
        (order.get(a.run.config) ?? 9) - (order.get(b.run.config) ?? 9) ||
        a.run.rep - b.run.rep,
    )) {
    dumpOne(g);
  }
} else {
  console.log("case                        config       rep    s   in    out  schema  verdict");
  for (const g of graded) {
    const { run } = g;
    let verdict = "";
    if (g.findings) {
      const kinds = g.findings.map((f) => f.kind[0]!.toUpperCase()).join("");
      verdict = `${g.findings.length} finding(s) [${kinds}] applied u:${g.applied?.userPreferences.length ?? 0} f:${g.applied?.facts.length ?? 0} s:${g.applied?.skills.length ?? 0} rej:${g.rejected?.length ?? 0}`;
    } else if (g.digest) {
      verdict = g.digest.map((s) => `${s.sessionId.slice(0, 8)}=${s.status}`).join(" ");
    } else if (g.drift) {
      verdict = g.drift.map((d) => `drift=${d.drift}/conf=${d.confident}/files=${d.files}`).join(" ");
    }
    console.log(
      `${run.case.padEnd(26)} ${run.config.padEnd(12)} ${String(run.rep).padStart(2)} ${(run.ms / 1000).toFixed(0).padStart(4)} ${String(run.usage?.inputTokens ?? "-").padStart(5)} ${String(run.usage?.outputTokens ?? "-").padStart(5)}  ${g.schemaValid ? "ok    " : "MISS  "}  ${verdict}`,
    );
  }
}
