/**
 * The per-run report — `.argus/reports/curator/<stamp>/{run.json,REPORT.md}`.
 *
 * LIFTED as a convention (research #16 §8(iv); `agent/curator.py:490-510`):
 * a machine-readable run record beside a human one, per pass. It is the audit
 * trail the retro loop wants — every archive names its reason, every rejected
 * proposal names why it was rejected, and the report is written even when the
 * pass changed nothing, because "the curator looked and did nothing" is
 * information too.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { archiveStamp, type ArchivedSkill } from "./archive";
import type { MemoryOrphan } from "./scan";
import type { Transition } from "./transitions";

export interface ArchivedFact {
  slug: string;
  to: string;
  reason: string;
}

export interface RejectedProposal {
  what: string;
  reason: string;
}

export interface CuratorRunReport {
  started_at: string;
  finished_at: string;
  dry_run: boolean;
  backup: { ok: boolean; sha?: string; reason?: string };
  candidates: { skills: number; facts: number };
  transitions: Transition[];
  llm: {
    ran: boolean;
    summary: string | null;
    consolidations: { from: string; into: string; reason: string }[];
    prunings: { name: string; reason: string }[];
    rejected: RejectedProposal[];
  };
  archived: { skills: ArchivedSkill[]; facts: ArchivedFact[] };
  orphans: MemoryOrphan[];
  errors: string[];
}

export function emptyReport(startedAt: string): CuratorRunReport {
  return {
    started_at: startedAt,
    finished_at: startedAt,
    dry_run: false,
    backup: { ok: false, reason: "not attempted" },
    candidates: { skills: 0, facts: 0 },
    transitions: [],
    llm: { ran: false, summary: null, consolidations: [], prunings: [], rejected: [] },
    archived: { skills: [], facts: [] },
    orphans: [],
    errors: [],
  };
}

export function reportDirectory(repo: string, at: string): string {
  return join(repo, ".argus/reports/curator", archiveStamp(at));
}

function list(title: string, lines: string[]): string[] {
  return [`## ${title}`, "", ...(lines.length > 0 ? lines : ["_none_"]), ""];
}

export function renderReport(report: CuratorRunReport): string {
  const counts = report.transitions.reduce<Record<string, number>>((tally, { kind }) => {
    tally[kind] = (tally[kind] ?? 0) + 1;
    return tally;
  }, {});
  const archived = [
    ...report.archived.skills.map(
      (skill) =>
        `- skill \`${skill.name}\` → \`${skill.to}\` — ${skill.reason}` +
        (skill.absorbedInto ? ` (absorbed into \`${skill.absorbedInto}\`)` : ""),
    ),
    ...report.archived.facts.map(
      (fact) => `- fact \`${fact.slug}\` → \`${fact.to}\` — ${fact.reason}`,
    ),
  ];
  return [
    "# Curator run",
    "",
    ...(report.dry_run ? ["**DRY RUN — nothing below was applied.**", ""] : []),
    `- started: ${report.started_at}`,
    `- finished: ${report.finished_at}`,
    `- candidates: ${report.candidates.skills} skills, ${report.candidates.facts} facts`,
    `- snapshot: ${
      report.backup.ok
        ? `\`${report.backup.sha}\` (rollback point)`
        : `unavailable — ${report.backup.reason ?? "unknown"}`
    }`,
    `- Archived: ${archived.length === 0 ? "none" : `${archived.length}`}`,
    "",
    ...list(
      "Deterministic transitions",
      Object.entries(counts)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([kind, count]) => `- ${kind}: ${count}`),
    ),
    ...list("Archived", archived),
    ...list(
      "Consolidation pass",
      report.llm.ran
        ? [
            `_${report.llm.summary ?? "(no summary)"}_`,
            "",
            ...report.llm.consolidations.map(
              (entry) => `- \`${entry.from}\` → \`${entry.into}\` — ${entry.reason}`,
            ),
            ...report.llm.prunings.map(
              (entry) => `- prune \`${entry.name}\` — ${entry.reason}`,
            ),
          ]
        : ["_skipped: no candidates_"],
    ),
    ...list(
      "Rejected proposals",
      report.llm.rejected.map((entry) => `- ${entry.what} — ${entry.reason}`),
    ),
    ...list(
      "Memory index orphans",
      report.orphans.map((orphan) => `- \`${orphan.slug}\` — ${orphan.kind}`),
    ),
    ...list("Errors", report.errors.map((error) => `- ${error}`)),
  ].join("\n");
}

export interface WrittenReport {
  directory: string;
  runJson: string;
  reportMd: string;
}

export async function writeReport(
  repo: string,
  report: CuratorRunReport,
): Promise<WrittenReport> {
  const directory = reportDirectory(repo, report.started_at);
  await mkdir(directory, { recursive: true });
  const runJson = join(directory, "run.json");
  const reportMd = join(directory, "REPORT.md");
  await Bun.write(runJson, `${JSON.stringify(report, null, 2)}\n`);
  await Bun.write(reportMd, `${renderReport(report)}\n`);
  return { directory, runJson, reportMd };
}
