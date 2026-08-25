/**
 * The Reviewer's brain output contract (SPEC §5.1: memory-vs-skills split).
 * `REVIEWER_OUTPUT_SCHEMA` rides `codex exec --output-schema`;
 * `parseVerdict` is the trust boundary on the way back — anything that does
 * not conform is a schema miss (null) and the eye retries. Findings cite the
 * transcript message uuids they derive from; the USER.md provenance gate
 * verifies those citations against the registry, never the model's word.
 */

export type FindingKind = "user-preference" | "project-fact" | "procedure";

export interface Finding {
  kind: FindingKind;
  /** Kebab-case identity; repeat findings converge on the same slug. */
  slug: string;
  title: string;
  content: string;
  /** Transcript message uuids the finding derives from. */
  sources: string[];
}

export interface Verdict {
  findings: Finding[];
}

export const REVIEWER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["findings"],
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["kind", "slug", "title", "content", "sources"],
        properties: {
          kind: {
            type: "string",
            enum: ["user-preference", "project-fact", "procedure"],
          },
          slug: {
            type: "string",
            description: "kebab-case identity, stable across repeats",
          },
          title: { type: "string" },
          content: { type: "string" },
          sources: {
            type: "array",
            items: { type: "string" },
            description: "uuids of the transcript messages this derives from",
          },
        },
      },
    },
  },
} as const;

const KINDS: readonly string[] = ["user-preference", "project-fact", "procedure"];

/** Forgiving identity: models vary casing/punctuation, retries must converge. */
export function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseFinding(raw: unknown): Finding | null {
  if (typeof raw !== "object" || raw === null) return null;
  const finding = raw as Record<string, unknown>;
  if (typeof finding.kind !== "string" || !KINDS.includes(finding.kind)) {
    return null;
  }
  if (
    typeof finding.slug !== "string" ||
    typeof finding.title !== "string" ||
    typeof finding.content !== "string" ||
    !Array.isArray(finding.sources) ||
    !finding.sources.every((source) => typeof source === "string")
  ) {
    return null;
  }
  const slug = normalizeSlug(finding.slug);
  if (slug.length === 0) return null;
  return {
    kind: finding.kind as FindingKind,
    slug,
    title: finding.title,
    content: finding.content,
    sources: finding.sources as string[],
  };
}

/** Null on any deviation from the contract — the schema-miss retry signal. */
export function parseVerdict(text: string): Verdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { findings } = parsed as Record<string, unknown>;
  if (!Array.isArray(findings)) return null;
  const typed: Finding[] = [];
  for (const raw of findings) {
    const finding = parseFinding(raw);
    if (finding === null) return null;
    typed.push(finding);
  }
  return { findings: typed };
}
