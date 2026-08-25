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
  // codex-cli 0.149.1 injects its plugin catalogue as a user-role item too.
  // Missing it is not cosmetic: a user message in a REGISTERED session that
  // matches no logged send is a Johan takeover (§5), so the catalogue would
  // land in USER.md and flip `johan_touched` on every Codex session Argus
  // ever watches. Found by running a live Codex sol high session in #36.
  "<recommended_plugins>",
];

/**
 * The tag of a COMPLETE XML-ish envelope, or null when the text is not one.
 *
 * The shape, and only this shape: the FIRST line is an opening tag on its own
 * — lowercase-initial name, no attributes, nothing after it — and the text
 * ENDS with the matching closing tag. That is what an agent CLI writes when it
 * injects context into a rollout as a user-role item; it is not what a person
 * types at a prompt.
 *
 * Deliberately narrow, because a false positive here makes Argus deaf to Johan
 * (§13.4 from the other direction):
 * - `<Button onClick={x} />` — uppercase, attributes, unclosed: not an envelope.
 * - `<bash-input>echo hi</bash-input>` — a REAL candidate (§2.3), and inline,
 *   so the one-line form is excluded on purpose.
 * - `<div>\n  hi\n</div>` IS the shape; the caller decides what to do about it
 *   (see the classifier's leading-preamble window, which is the second gate).
 */
const ENVELOPE_OPEN = /^<([a-z][a-z0-9_-]*)>$/;

export function syntheticEnvelopeTag(text: string): string | null {
  const trimmed = text.trim();
  const breakAt = trimmed.indexOf("\n");
  if (breakAt === -1) return null;
  const open = ENVELOPE_OPEN.exec(trimmed.slice(0, breakAt).trimEnd());
  if (!open) return null;
  const tag = open[1]!;
  return trimmed.endsWith(`</${tag}>`) ? tag : null;
}

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
