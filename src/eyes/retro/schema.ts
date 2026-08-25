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

/**
 * The SCOPE-DRIFT contract (#38). Per candidate the eye shows it, the brain
 * answers the one question attribution cannot: is this diff what the ticket
 * asked for?
 *
 * Two booleans, not one, because the false-positive policy is asymmetric.
 * `drift` is the judgment; `confident` is the model's own certainty, and the
 * eye files only when BOTH are true (see ./drift.ts `decideDrift`). A hedge
 * is silence — that is the whole point.
 *
 * Every property is listed in `required`, including the three that are
 * meaningless on a not-drift answer: strict structured output rejects an
 * object whose `required` omits a property, and the rejection surfaces as a
 * bare `exit 1` with empty stderr (the lesson #35 paid for). Optionality
 * rides the null union instead.
 */
export interface DriftJudgment {
  /** Echoes the candidate id the eye put in the prompt. */
  candidateId: string;
  /** True ONLY for work serving a different goal than the ticket states. */
  drift: boolean;
  /** The model's own certainty; an unconfident drift is not filed. */
  confident: boolean;
  /** Short phrase naming the out-of-scope work, for the title. */
  what: string | null;
  /** The out-of-scope work, concretely — files, behaviour, what it does. */
  outOfScopeWork: string | null;
  /** Why it serves a different goal than the ticket's stated scope. */
  whyOutOfScope: string | null;
}

export interface DriftVerdict {
  drifts: DriftJudgment[];
}

export const DRIFT_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["drifts"],
  properties: {
    drifts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "candidateId",
          "drift",
          "confident",
          "what",
          "outOfScopeWork",
          "whyOutOfScope",
        ],
        properties: {
          candidateId: {
            type: "string",
            description: "the candidate id from the prompt this judges",
          },
          drift: {
            type: "boolean",
            description:
              "true ONLY when the work serves a goal DIFFERENT from the one the" +
              " ticket states; an in-scope refactor, test update, rename or" +
              " gate fix is false",
          },
          confident: {
            type: "boolean",
            description:
              "false whenever you are unsure; an unsure drift is not reported",
          },
          what: {
            type: ["string", "null"],
            description:
              "short phrase naming the out-of-scope work, or null when not drift",
          },
          outOfScopeWork: {
            type: ["string", "null"],
            description:
              "the out-of-scope work described concretely, or null when not drift",
          },
          whyOutOfScope: {
            type: ["string", "null"],
            description:
              "why it serves a different goal than the stated scope, or null",
          },
        },
      },
    },
  },
} as const;

function nullableString(value: unknown): boolean {
  return value === null || typeof value === "string";
}

function parseDriftJudgment(raw: unknown): DriftJudgment | null {
  if (typeof raw !== "object" || raw === null) return null;
  const judgment = raw as Record<string, unknown>;
  if (
    typeof judgment.candidateId !== "string" ||
    judgment.candidateId.length === 0 ||
    typeof judgment.drift !== "boolean" ||
    typeof judgment.confident !== "boolean" ||
    !nullableString(judgment.what) ||
    !nullableString(judgment.outOfScopeWork) ||
    !nullableString(judgment.whyOutOfScope)
  ) {
    return null;
  }
  return {
    candidateId: judgment.candidateId,
    drift: judgment.drift,
    confident: judgment.confident,
    what: judgment.what as string | null,
    outOfScopeWork: judgment.outOfScopeWork as string | null,
    whyOutOfScope: judgment.whyOutOfScope as string | null,
  };
}

/** Null on any deviation from the contract — the schema-miss signal. */
export function parseDriftVerdict(text: string): DriftVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { drifts } = parsed as Record<string, unknown>;
  if (!Array.isArray(drifts)) return null;
  const typed: DriftJudgment[] = [];
  for (const raw of drifts) {
    const judgment = parseDriftJudgment(raw);
    if (judgment === null) return null;
    typed.push(judgment);
  }
  return { drifts: typed };
}
