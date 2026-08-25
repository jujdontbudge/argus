/**
 * The curator review prompt.
 *
 * LIFTED (research #16 §8(ii)) from `CURATOR_REVIEW_PROMPT`
 * (`agent/curator.py:344-486`): the umbrella-building framing, the "would a
 * human maintainer write this as N separate skills or one skill with N
 * labeled subsections?" bar, the package-integrity rules, the hard rules
 * (never delete, never touch pinned, zero counters are not evidence), the
 * required structured block, and the dry-run banner mechanism
 * (`agent/curator.py:317-341`).
 *
 * RE-SPECCED: tool references are gone — Argus' brain is a read-only judgment
 * (SPEC §5.1), so the prompt asks for decisions and prose, and the eye makes
 * every file move — and a memory section is added, which the native curator
 * has no counterpart for.
 */
import type { UsageState } from "./usage";
import type { MemoryOrphan } from "./scan";

export interface PromptSkill {
  name: string;
  description: string;
  relative: string;
  state: UsageState;
  idleDays: number | null;
  useCount: number;
  viewCount: number;
  patchCount: number;
  supportFiles: string[];
}

export interface PromptFact {
  slug: string;
  title: string;
  idleDays: number | null;
  indexed: boolean;
}

export interface CuratorPromptInput {
  skills: PromptSkill[];
  facts: PromptFact[];
  orphans: MemoryOrphan[];
  dryRun: boolean;
}

export const DRY_RUN_BANNER = [
  "=== DRY RUN ===",
  "This is a REPORT-ONLY pass. Nothing you propose will be applied. Judge",
  "exactly as you would for a real run and say what you WOULD do.",
  "",
].join("\n");

function renderSkill(skill: PromptSkill): string {
  const idle = skill.idleDays === null ? "never used" : `${skill.idleDays} days idle`;
  const support =
    skill.supportFiles.length > 0
      ? `\n    support: ${skill.supportFiles.join(", ")}`
      : "";
  return (
    `- ${skill.name} [${skill.state}] (${skill.relative}) — ${idle}; ` +
    `use ${skill.useCount}, view ${skill.viewCount}, patch ${skill.patchCount}` +
    `${skill.description.length > 0 ? `\n    description: ${skill.description}` : ""}` +
    support
  );
}

function renderFact(fact: PromptFact): string {
  const idle = fact.idleDays === null ? "unknown age" : `${fact.idleDays} days since touched`;
  return `- ${fact.slug} — ${fact.title} (${idle}${fact.indexed ? "" : ", NOT indexed"})`;
}

function section(title: string, lines: string[]): string {
  return [`${title}:`, ...(lines.length > 0 ? lines : ["(none)"])].join("\n");
}

export function buildCuratorPrompt(input: CuratorPromptInput): string {
  const body = [
    "You are the Argus curator. This is an UMBRELLA-BUILDING consolidation",
    "pass over one repo's `.argus/` stores — not a passive audit, and not a",
    "duplicate-finder. The target shape is CLASS-LEVEL skills with rich",
    "SKILL.md bodies plus references/, templates/ and scripts/ subfiles: one",
    "broad umbrella skill with labeled subsections beats five narrow siblings",
    "for discoverability.",
    "",
    "HARD RULES",
    "- NEVER delete anything. Archiving is the maximum destructive action, and",
    "  the eye performs it — you only decide.",
    "- NEVER touch a pinned skill. Pinned skills are not in the list below at",
    "  all; if you name one, the decision is discarded.",
    "- Zero usage counters are evidence of NOTHING, in either direction. Argus",
    "  telemetry starts when the Reviewer first sees a skill.",
    "- Never flatten a skill that has support files without re-homing them into",
    "  the umbrella's references/ or templates/.",
    "- Judge only from what is below. Do not run commands.",
    "",
    "METHOD",
    "1. Cluster the skills by prefix and domain.",
    "2. Per cluster, decide: merge into an existing umbrella, or leave alone.",
    "   The bar is — would a human maintainer write this as N separate skills,",
    "   or as one skill with N labeled subsections?",
    "3. When you fold a sibling into an umbrella, return the merged umbrella",
    "   SKILL.md body in `body` so nothing it knew is lost. The sibling is then",
    "   archived, never deleted.",
    "4. Prune only what is genuinely dead: nothing this project does now needs",
    "   it, and the deterministic tier already marked it stale.",
    "5. For memory: merge duplicate facts into the one that keeps the content,",
    "   and prune facts a later fact superseded. Report on the orphans; the eye",
    "   repairs the index itself.",
    "",
    section("SKILL CANDIDATES", input.skills.map(renderSkill)),
    "",
    section("MEMORY FACTS", input.facts.map(renderFact)),
    "",
    section(
      "MEMORY ORPHANS (index and fact files disagree)",
      input.orphans.map((orphan) => `- ${orphan.slug} — ${orphan.kind}`),
    ),
    "",
    "REQUIRED OUTPUT",
    "JSON matching the output schema: a human `summary`, `consolidations`",
    "([{from, into, reason, body?}]), `prunings` ([{name, reason}]), and",
    "`memory` ({merges, prunings}). Every skill you retire must appear in",
    "exactly one of consolidations or prunings. Propose nothing you cannot",
    "justify in its `reason`; an empty pass is a good pass.",
  ].join("\n");
  return input.dryRun ? `${DRY_RUN_BANNER}${body}` : body;
}
