/**
 * The Retro brain's output contract (SPEC §5.5). Per signal the eye shows it,
 * the brain answers one question the registry cannot: did IMPLEMENTATION
 * happen here (as opposed to planning, grilling, notes or churn), and if so
 * what would you call it.
 *
 * `RETRO_OUTPUT_SCHEMA` rides `codex exec --output-schema`;
 * `parseRetroVerdict` is the trust boundary on the way back — anything
 * non-conforming is a schema miss (null) and the eye retries. The brain
 * NEVER decides what gets written: the eye composes the body from
 * provenance-verified prompts and the real diff, and validates the parent
 * against tickets that actually exist.
 */

export interface RetroJudgment {
  /** Echoes the signal id the eye put in the prompt. */
  signalId: string;
  /** True when implementation work happened with no ticket covering it. */
  implementation: boolean;
  /** The `Retro: <what>` title tail. */
  what: string;
  /** A short narrative for the retro body. */
  summary: string;
  /** The nearest plausible parent from the candidates shown, or null. */
  parentTicket: string | null;
}

export interface RetroVerdict {
  retros: RetroJudgment[];
}

export const RETRO_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["retros"],
  properties: {
    retros: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["signalId", "implementation", "what", "summary", "parentTicket"],
        properties: {
          signalId: {
            type: "string",
            description: "the signal id from the prompt this judges",
          },
          implementation: {
            type: "boolean",
            description:
              "true only when code/config was actually implemented or changed",
          },
          what: {
            type: "string",
            description: "short phrase naming what was done, for the retro title",
          },
          summary: {
            type: "string",
            description: "two or three sentences on what happened and why it matters",
          },
          parentTicket: {
            type: ["string", "null"],
            description:
              "issue number of the nearest plausible parent from the candidates, or null",
          },
        },
      },
    },
  },
} as const;

function parseJudgment(raw: unknown): RetroJudgment | null {
  if (typeof raw !== "object" || raw === null) return null;
  const judgment = raw as Record<string, unknown>;
  if (
    typeof judgment.signalId !== "string" ||
    judgment.signalId.length === 0 ||
    typeof judgment.implementation !== "boolean" ||
    typeof judgment.what !== "string" ||
    typeof judgment.summary !== "string" ||
    !(judgment.parentTicket === null || typeof judgment.parentTicket === "string")
  ) {
    return null;
  }
  return {
    signalId: judgment.signalId,
    implementation: judgment.implementation,
    what: judgment.what,
    summary: judgment.summary,
    parentTicket: judgment.parentTicket,
  };
}

/** Null on any deviation from the contract — the schema-miss retry signal. */
export function parseRetroVerdict(text: string): RetroVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { retros } = parsed as Record<string, unknown>;
  if (!Array.isArray(retros)) return null;
  const typed: RetroJudgment[] = [];
  for (const raw of retros) {
    const judgment = parseJudgment(raw);
    if (judgment === null) return null;
    typed.push(judgment);
  }
  return { retros: typed };
}
