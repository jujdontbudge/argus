/**
 * The Reviewer's brain output contract (SPEC §5.1: memory-vs-skills split).
 * The schemas ride `codex exec --output-schema`; `parseVerdict` is the trust
 * boundary on the way back — anything that does not conform is a schema miss
 * (null) and the eye retries. Findings cite the transcript message uuids they
 * derive from; the USER.md provenance gate verifies those citations against
 * the registry, never the model's word.
 *
 * ONE SCHEMA PER PASS (#69). The eye asks twice — extraction, then
 * procedure-writing — and each pass gets a schema that can express only its
 * own kinds. #54 measured the two failures this closes: the conflated ask
 * produced topic-level "procedures" from one-off incidents, and an
 * environment fact (`cmux must be >= 0.64.22`) filed as a skill (#71). A
 * kind the pass did not ask for is now a schema miss, not a write.
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

/** One shape, one enum per pass — the passes differ in nothing else. */
function outputSchema<const K extends readonly FindingKind[]>(kinds: K) {
  return {
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
            kind: { type: "string", enum: kinds },
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
}

/** The fact pass (#69): USER.md and MEMORY.md, and nothing else. */
export const EXTRACTION_OUTPUT_SCHEMA = outputSchema([
  "user-preference",
  "project-fact",
] as const);

/** The skills pass (#69): a procedure or silence — it can write nothing else. */
export const PROCEDURE_OUTPUT_SCHEMA = outputSchema(["procedure"] as const);

/**
 * The union both passes together cover. No production call sends this any
 * more; it stays because the memory-vs-skills contract is one contract, and
 * #54's frozen cases were captured against it.
 */
export const REVIEWER_OUTPUT_SCHEMA = outputSchema([
  "user-preference",
  "project-fact",
  "procedure",
] as const);

const KINDS: readonly FindingKind[] = [
  "user-preference",
  "project-fact",
  "procedure",
];

/** Forgiving identity: models vary casing/punctuation, retries must converge. */
export function normalizeSlug(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function parseFinding(raw: unknown, allowed: readonly string[]): Finding | null {
  if (typeof raw !== "object" || raw === null) return null;
  const finding = raw as Record<string, unknown>;
  if (typeof finding.kind !== "string" || !allowed.includes(finding.kind)) {
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

/**
 * Null on any deviation from the contract — the schema-miss retry signal.
 * `allowed` narrows that contract to one pass's kinds: a procedure returned
 * by the extraction pass is a deviation, not a skill to file (#69, #71).
 */
export function parseVerdict(
  text: string,
  allowed: readonly FindingKind[] = KINDS,
): Verdict | null {
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
    const finding = parseFinding(raw, allowed);
    if (finding === null) return null;
    typed.push(finding);
  }
  return { findings: typed };
}
