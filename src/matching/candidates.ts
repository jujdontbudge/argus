/**
 * Candidate filters: which transcript records are user messages eligible for
 * provenance classification at all (research/send-transcript-matching.md
 * §2.1–§2.3). Everything else — tool results, meta records, sidechains,
 * synthetic context, subagent threads — is never classified.
 *
 * Inputs are parsed JSONL lines, typed loosely because transcripts are
 * external data the library does not control.
 */

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | null {
  return typeof value === "object" && value !== null ? (value as Rec) : null;
}

/**
 * Claude Code transcript line (§2.1, §2.3). Returns the message text if the
 * record is a candidate, else null. Candidates are real prompts
 * (`promptSource` "typed"/"queued") plus `<bash-input>` landings, whose
 * promptSource is absent; `<bash-stdout>`/`<bash-stderr>` records never
 * qualify.
 */
export function claudeCandidateText(record: unknown): string | null {
  const rec = asRecord(record);
  if (!rec || rec.type !== "user") return null;
  if (rec.isMeta === true || rec.isSidechain === true) return null;
  const message = asRecord(rec.message);
  if (!message || typeof message.content !== "string") return null;
  const content = message.content;
  const source = rec.promptSource;
  if (source === "typed" || source === "queued") return content;
  if (content.startsWith("<bash-input>")) return content;
  return null;
}

/**
 * Codex rollout line (§2.2): `response_item` with a user-role message payload,
 * excluding the synthetic user-role items Codex injects itself.
 */
const CODEX_SYNTHETIC_PREFIXES = [
  "# AGENTS.md instructions",
  "<user_instructions>",
  "<environment_context>",
  "<ide_context>",
];

export function codexCandidateText(record: unknown): string | null {
  const rec = asRecord(record);
  if (!rec || rec.type !== "response_item") return null;
  const payload = asRecord(rec.payload);
  if (!payload || payload.type !== "message" || payload.role !== "user") return null;
  if (!Array.isArray(payload.content)) return null;
  const parts: string[] = [];
  for (const item of payload.content) {
    const part = asRecord(item);
    if (part?.type === "input_text" && typeof part.text === "string") {
      parts.push(part.text);
    }
  }
  if (parts.length === 0) return null;
  const text = parts.join("\n");
  if (CODEX_SYNTHETIC_PREFIXES.some((p) => text.startsWith(p))) return null;
  return text;
}

/**
 * Codex thread source metadata (§2.2): subagent threads carry byte-identical
 * copies of the parent's user messages — only parent threads are classified;
 * subagent threads inherit the parent's classification.
 */
export function isCodexSubagentThread(source: unknown): boolean {
  const src = asRecord(source);
  return src !== null && asRecord(src.subagent) !== null;
}
