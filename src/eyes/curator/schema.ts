/**
 * The curator brain's output contract.
 *
 * LIFTED (research #16 §8(ii)): the structured block Hermes' curator prompt
 * requires — `consolidations: [{from, into, reason}]` and
 * `prunings: [{name, reason}]`, with every archived skill appearing in
 * exactly ONE of them (`agent/curator.py:344-486`). RE-SPECCED: a `memory`
 * section, because the native curator never opens the memory files, and an
 * optional `body` per consolidation — Argus' brain is a read-only `codex
 * exec` judgment (SPEC §5.1), not Hermes' file-editing fork, so if the model
 * wants a sibling folded into an umbrella it must hand back the merged
 * umbrella prose and the EYE writes it.
 *
 * `parseCuratorVerdict` is the trust boundary: anything off-contract is null,
 * which is a schema miss the eye retries — the same posture as every other
 * eye. Names that simply do not exist are NOT a contract violation; the apply
 * step rejects those loudly into the report.
 */

export interface Consolidation {
  /** The narrow sibling being folded in and archived. */
  from: string;
  /** The umbrella that absorbs it. */
  into: string;
  reason: string;
  /** Optional replacement SKILL.md body for the umbrella. */
  body?: string;
}

export interface Pruning {
  name: string;
  reason: string;
}

export interface MemoryMerge {
  from: string;
  into: string;
  reason: string;
}

export interface MemoryPruning {
  slug: string;
  reason: string;
}

export interface CuratorVerdict {
  summary: string;
  consolidations: Consolidation[];
  prunings: Pruning[];
  memory: { merges: MemoryMerge[]; prunings: MemoryPruning[] };
}

const REASONED = {
  type: "string",
  description: "why, in one sentence",
} as const;

export const CURATOR_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "consolidations", "prunings", "memory"],
  properties: {
    summary: {
      type: "string",
      description: "the human summary of this pass",
    },
    consolidations: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["from", "into", "reason"],
        properties: {
          from: { type: "string", description: "skill folded in and archived" },
          into: { type: "string", description: "umbrella skill that absorbs it" },
          reason: REASONED,
          body: {
            type: "string",
            description: "merged SKILL.md body for the umbrella, if it changes",
          },
        },
      },
    },
    prunings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "reason"],
        properties: { name: { type: "string" }, reason: REASONED },
      },
    },
    memory: {
      type: "object",
      additionalProperties: false,
      required: ["merges", "prunings"],
      properties: {
        merges: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["from", "into", "reason"],
            properties: {
              from: { type: "string", description: "duplicate fact, archived" },
              into: { type: "string", description: "fact that keeps the content" },
              reason: REASONED,
            },
          },
        },
        prunings: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["slug", "reason"],
            properties: { slug: { type: "string" }, reason: REASONED },
          },
        },
      },
    },
  },
} as const;

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalArray(value: unknown): unknown[] | null {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : null;
}

function parsePair(
  raw: unknown,
  left: string,
  right: string,
): { left: string; right: string; reason: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const entry = raw as Record<string, unknown>;
  const from = text(entry[left]);
  const into = text(entry[right]);
  const reason = text(entry.reason);
  if (from === null || into === null || reason === null) return null;
  if (from === into) return null; // folding a thing into itself is not a plan
  return { left: from, right: into, reason };
}

/** Null on any deviation from the contract — the schema-miss retry signal. */
export function parseCuratorVerdict(raw: string): CuratorVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const body = parsed as Record<string, unknown>;
  const summary = text(body.summary);
  if (summary === null) return null;

  const rawConsolidations = optionalArray(body.consolidations);
  const rawPrunings = optionalArray(body.prunings);
  if (rawConsolidations === null || rawPrunings === null) return null;

  const consolidations: Consolidation[] = [];
  for (const entry of rawConsolidations) {
    const pair = parsePair(entry, "from", "into");
    if (pair === null) return null;
    const merged = (entry as Record<string, unknown>).body;
    consolidations.push({
      from: pair.left,
      into: pair.right,
      reason: pair.reason,
      ...(typeof merged === "string" && merged.length > 0 && { body: merged }),
    });
  }

  const prunings: Pruning[] = [];
  for (const entry of rawPrunings) {
    if (typeof entry !== "object" || entry === null) return null;
    const name = text((entry as Record<string, unknown>).name);
    const reason = text((entry as Record<string, unknown>).reason);
    if (name === null || reason === null) return null;
    prunings.push({ name, reason });
  }

  // Every archived skill appears in exactly one list (the native invariant).
  const folded = new Set(consolidations.map(({ from }) => from));
  if (prunings.some(({ name }) => folded.has(name))) return null;

  const memoryRaw =
    typeof body.memory === "object" && body.memory !== null
      ? (body.memory as Record<string, unknown>)
      : {};
  const rawMerges = optionalArray(memoryRaw.merges);
  const rawFactPrunings = optionalArray(memoryRaw.prunings);
  if (rawMerges === null || rawFactPrunings === null) return null;

  const merges: MemoryMerge[] = [];
  for (const entry of rawMerges) {
    const pair = parsePair(entry, "from", "into");
    if (pair === null) return null;
    merges.push({ from: pair.left, into: pair.right, reason: pair.reason });
  }

  const factPrunings: MemoryPruning[] = [];
  for (const entry of rawFactPrunings) {
    if (typeof entry !== "object" || entry === null) return null;
    const slug = text((entry as Record<string, unknown>).slug);
    const reason = text((entry as Record<string, unknown>).reason);
    if (slug === null || reason === null) return null;
    factPrunings.push({ slug, reason });
  }

  const mergedAway = new Set(merges.map(({ from }) => from));
  if (factPrunings.some(({ slug }) => mergedAway.has(slug))) return null;

  return {
    summary,
    consolidations,
    prunings,
    memory: { merges, prunings: factPrunings },
  };
}
