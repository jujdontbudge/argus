/**
 * The review gate (ticket #57; SPEC §7.1's `code-review` at the end of the
 * chain, and §7.3.4's "review clean").
 *
 * It is a GATE, not a note: its only job is to be able to say no. Two
 * consequences, and both are refusals:
 *
 *   - a verdict of `blocked` stops the merge, with the concerns attached;
 *   - a brain that cannot answer — down, non-zero, unparseable, off-schema —
 *     ALSO stops the merge. "The reviewer was unavailable, so we merged"
 *     is the exact shape of a gate that cannot refuse, and it is the shape
 *     AUDIT.md §4 item 3 exists to prevent. An unreviewed merge is not a
 *     cheaper reviewed merge; it is an unreviewed merge.
 *
 * The diff it reads always comes from the MERGE BASE (`./merge.ts`), so the
 * question asked is "what did this ticket do", never "how does this branch
 * differ from a main that has moved underneath it".
 *
 * Same `Brain` seam and the same `codex exec` tier as the Reviewer and Digest
 * eyes (SPEC §5.1), so there is one brain contract in the tree, not two.
 */
import type { Brain } from "../eyes/brain";

export interface ReviewInput {
  ticket: string;
  title: string;
  /** What the ticket ASKED for — the thing the diff is judged against. */
  body: string;
  diff: string;
  files: string[];
  /** Truncated diffs are stated to the reviewer, never hidden from it. */
  truncated?: boolean;
  /** The ticket's worktree: the brain's read-only context. */
  worktree: string;
}

export type ReviewStatus =
  /** Nothing blocking; the merge may proceed. */
  | "clean"
  /** Something blocking; the merge must not. */
  | "blocked"
  /** No usable verdict — which blocks, loudly. */
  | "unavailable";

export interface ReviewVerdict {
  status: ReviewStatus;
  summary: string;
  concerns: string[];
}

export type Reviewer = (input: ReviewInput) => Promise<ReviewVerdict>;

const VERDICT_SCHEMA = {
  additionalProperties: false,
  properties: {
    concerns: {
      description: "Blocking problems, one per entry. Empty when the diff is clean.",
      items: { type: "string" },
      type: "array",
    },
    summary: { type: "string" },
    verdict: { enum: ["clean", "blocked"], type: "string" },
  },
  required: ["verdict", "summary", "concerns"],
  type: "object",
} as const;

export function reviewPrompt(input: ReviewInput): string {
  return [
    "You are the code-review gate at the end of an Argus ticket. Judge ONLY the",
    "diff below, which is this ticket's work measured from the commit it branched",
    "from — files it does not touch are not its business.",
    "",
    `Ticket #${input.ticket}: ${input.title}`,
    "",
    "The ticket asked for:",
    "",
    input.body.trim() === "" ? "(no body)" : input.body.trim(),
    "",
    `Files changed (${input.files.length}): ${input.files.join(", ")}`,
    ...(input.truncated === true
      ? ["", "NOTE: the diff below was truncated. If that prevents a judgement, block."]
      : []),
    "",
    "Diff:",
    "",
    input.diff.trim() === "" ? "(empty diff)" : input.diff,
    "",
    "Answer `blocked` for anything that must not merge: a correctness bug, work",
    "the ticket did not ask for, a test that cannot fail, or a claim the diff does",
    "not support. Answer `clean` otherwise. Style preferences are not blocking.",
  ].join("\n");
}

function parseVerdict(text: string): ReviewVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const row = parsed as Record<string, unknown>;
  if (row.verdict !== "clean" && row.verdict !== "blocked") return null;
  const concerns = Array.isArray(row.concerns)
    ? row.concerns.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    concerns,
    status: row.verdict,
    summary: typeof row.summary === "string" ? row.summary : "",
  };
}

/** The production reviewer: one constrained `codex exec` turn over the diff. */
export function createBrainReviewer(brain: Brain): Reviewer {
  return async (input) => {
    const outcome = await brain.evaluate({
      cwd: input.worktree,
      prompt: reviewPrompt(input),
      schema: VERDICT_SCHEMA,
    });
    if (!outcome.ok) {
      return {
        concerns: [],
        status: "unavailable",
        summary: `the review brain failed (${outcome.reason}): ${outcome.detail.slice(0, 300)}`,
      };
    }
    const verdict = parseVerdict(outcome.text);
    if (verdict === null) {
      return {
        concerns: [],
        status: "unavailable",
        summary: `the review brain returned no usable verdict: ${outcome.text.slice(0, 300)}`,
      };
    }
    // A `blocked` verdict with no stated concern is still a refusal. The gate
    // never upgrades a no to a yes for being badly explained.
    return verdict;
  };
}
