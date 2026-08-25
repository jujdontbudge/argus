/**
 * The Digest's brain output contract (SPEC §5.4): per coalesced batch the
 * brain emits, for each session it saw, a narrative chunk to append, a
 * one-line INDEX.md summary, and its judged status. `DIGEST_OUTPUT_SCHEMA`
 * rides `codex exec --output-schema`; `parseDigestVerdict` is the trust
 * boundary on the way back — anything non-conforming is a schema miss (null)
 * and the eye retries. The brain may claim `running | blocked | done` only:
 * `dead` is a liveness fact owned by lifecycle signals, never a judgment.
 */

/** The full §6 status set the digest's frontmatter can carry. */
export type DigestStatus = "running" | "blocked" | "done" | "dead";

/** The subset the brain may judge from transcript content. */
export type BrainStatus = "running" | "blocked" | "done";

export interface SessionDigest {
  sessionId: string;
  /** Markdown appended to the session's running digest body. */
  narrative: string;
  /** The one-line INDEX.md summary for this session, current as of the batch. */
  summary: string;
  status: BrainStatus;
}

export interface DigestVerdict {
  sessions: SessionDigest[];
}

export const DIGEST_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["sessions"],
  properties: {
    sessions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["sessionId", "narrative", "summary", "status"],
        properties: {
          sessionId: {
            type: "string",
            description: "the transcript session id the entry digests",
          },
          narrative: {
            type: "string",
            description: "markdown narrative of what happened since last time",
          },
          summary: {
            type: "string",
            description: "one line describing the session's current state",
          },
          status: {
            type: "string",
            enum: ["running", "blocked", "done"],
          },
        },
      },
    },
  },
} as const;

const BRAIN_STATUSES: readonly string[] = ["running", "blocked", "done"];

function parseSessionDigest(raw: unknown): SessionDigest | null {
  if (typeof raw !== "object" || raw === null) return null;
  const digest = raw as Record<string, unknown>;
  if (
    typeof digest.sessionId !== "string" ||
    digest.sessionId.length === 0 ||
    typeof digest.narrative !== "string" ||
    typeof digest.summary !== "string" ||
    typeof digest.status !== "string" ||
    !BRAIN_STATUSES.includes(digest.status)
  ) {
    return null;
  }
  return {
    sessionId: digest.sessionId,
    narrative: digest.narrative,
    summary: digest.summary,
    status: digest.status as BrainStatus,
  };
}

/** Null on any deviation from the contract — the schema-miss retry signal. */
export function parseDigestVerdict(text: string): DigestVerdict | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const { sessions } = parsed as Record<string, unknown>;
  if (!Array.isArray(sessions)) return null;
  const typed: SessionDigest[] = [];
  for (const raw of sessions) {
    const digest = parseSessionDigest(raw);
    if (digest === null) return null;
    typed.push(digest);
  }
  return { sessions: typed };
}
