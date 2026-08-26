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
 * The CLI's own statement of what produced a user-role record, when it makes
 * one: `origin: { kind: "human" | "task-notification" | "peer" | … }`. Absent
 * on older CLI versions, and absent on headless dispatch prompts as late as
 * 2.1.246 — so absence is normal and must never be read as an accusation.
 */
function claudeOriginKind(rec: Rec): string | null {
  const origin = asRecord(rec.origin);
  return typeof origin?.kind === "string" ? origin.kind : null;
}

/**
 * Claude Code transcript line (§2.1, §2.3). Returns the message text if the
 * record is a candidate, else null.
 *
 * Candidacy asks ONE question — did a prompt land here at all? — and says
 * nothing about who sent it. §5 makes the registry the single source of
 * provenance truth: the dispatch-prompt hash and sends.jsonl are what
 * establish "this was Hermes", and any other prompt in a session Hermes opened
 * is Johan attaching. `promptSource` is evidence about the DOOR a prompt came
 * through, and #50 measured that it cannot stand in for authorship in either
 * direction:
 *
 * - the SAME logical event — Hermes dispatching a worker — is `typed` when the
 *   session was opened in a terminal and `sdk` when it was opened headlessly.
 *   Argus's own dispatcher spawns every worker headlessly, so `sdk` is the
 *   path Argus takes on itself, and an allowlist of {typed, queued} lost the
 *   dispatch provenance of every one of them (#49's live drive found this);
 * - the SAME content — a `<task-notification>` the CLI injects as a user-role
 *   record — is stamped `system` in a terminal session (612 records) and `sdk`
 *   in an SDK-fronted one (34). The same confusion, pointing the other way:
 *   read the door name as authorship and you are deaf in one direction and
 *   poisoned in the other, from the same field.
 *
 * So the door name is not the axis. The rules below are, in order:
 *
 * 1. `origin.kind` present and not "human" → the CLI is telling us it produced
 *    this record. Not a prompt. Unknown kinds default CLOSED, because adding
 *    injection kinds is the thing CLIs actually do — codex-cli 0.149.1's
 *    `<recommended_plugins>` (#36) is the same move under another name.
 * 2. `promptSource: "system"` → the CLI's other marker for its own content.
 * 3. any other present `promptSource` → a prompt landed. Unknown source names
 *    default OPEN, because the cost of a name nobody taught this filter is
 *    SILENT deafness to Johan — the §13.4 breach with no audit trail.
 * 4. absent `promptSource` → unchanged (§2.3): `<bash-input>` landings only.
 *    Absence is the shape slash-command expansions and `<bash-stdout>` take.
 *
 * Measured over 60 project slugs / 234 transcripts / 340,222 lines / 59,816
 * `type: "user"` records on this machine: this admits 292 records the old
 * allowlist dropped — 291 `sdk` (headless dispatches plus every word Johan
 * types in the Claude desktop app, which fronts the SDK) and one
 * `suggestion_accepted` — and drops NOTHING the old allowlist admitted.
 *
 * `queued` is not special-cased any more, but it is worth recording that it is
 * NOT dead: #50's ticket reports it as never seen in 18,000 lines, which was
 * the `*argus*` slugs only. Across all 60 slugs it appears 110 times.
 *
 * #53 adds visibility without changing these rules: the parser carries the
 * kind on MessageEvent, and the first refusal per kind is surfaced by
 * `argus status`. Absence remains absent and never alarms.
 */
export function claudeCandidateText(record: unknown): string | null {
  const rec = asRecord(record);
  if (!rec || rec.type !== "user") return null;
  if (rec.isMeta === true || rec.isSidechain === true) return null;
  const message = asRecord(rec.message);
  if (!message || typeof message.content !== "string") return null;
  const content = message.content;
  const origin = claudeOriginKind(rec);
  if (origin !== null && origin !== "human") return null;
  const source = rec.promptSource;
  if (typeof source === "string") return source === "system" ? null : content;
  return content.startsWith("<bash-input>") ? content : null;
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
 * SINCE #78, a CHAIN of such envelopes counts too, and the first tag is
 * returned. That is not a loosening for its own sake — it is the same finding
 * as #36's, one CLI version later. A live `codex exec` drive of SPEC §13 slot
 * 4 found the plugin catalogue no longer arriving alone: codex-cli now packs
 * `<recommended_plugins>…</recommended_plugins>` and
 * `<environment_context>…</environment_context>` into ONE user-role item. The
 * single-envelope rule opened on the first tag, looked for it at the end,
 * found the other one, and returned null — so the whole injection read as a
 * prompt nobody logged, which is a Johan takeover, which puts a plugin
 * catalogue in USER.md and flips `johan_touched` on every Codex session Argus
 * watches. Exactly the failure the comment above the tag list describes,
 * reached by a shape that list could not see.
 *
 * Still deliberately narrow, because a false positive here makes Argus deaf to
 * Johan (§13.4 from the other direction). EVERY part of the text must be a
 * complete envelope opening with a bare lowercase tag on its own line, with
 * nothing between the parts but whitespace — prose does not decompose that way:
 * - `<Button onClick={x} />` — uppercase, attributes, unclosed: not an envelope.
 * - `<bash-input>echo hi</bash-input>` — a REAL candidate (§2.3), and inline,
 *   so the one-line form is excluded on purpose.
 * - `<div>\n  hi\n</div>` IS the shape; the caller decides what to do about it
 *   (see the classifier's leading-preamble window, which is the second gate).
 */
const ENVELOPE_OPEN = /^<([a-z][a-z0-9_-]*)>$/;

/** The opening tag of the envelope `text` starts with, or null. */
function openingTag(text: string): string | null {
  const breakAt = text.indexOf("\n");
  if (breakAt === -1) return null;
  const open = ENVELOPE_OPEN.exec(text.slice(0, breakAt).trimEnd());
  return open ? open[1]! : null;
}

export function syntheticEnvelopeTag(text: string): string | null {
  const first = openingTag(text.trim());
  return first !== null && consumesEntirely(text.trim()) ? first : null;
}

/**
 * Does the text decompose, with nothing left over, into complete envelopes?
 *
 * A closing tag is only accepted as an envelope's end if what FOLLOWS it also
 * decomposes — which is what keeps a same-named nested tag from ending its
 * parent early, and what keeps trailing prose from being ignored.
 */
function consumesEntirely(text: string): boolean {
  const rest = text.trim();
  if (rest.length === 0) return true;
  const tag = openingTag(rest);
  if (tag === null) return false;
  const close = `</${tag}>`;
  for (
    let at = rest.indexOf(close);
    at !== -1;
    at = rest.indexOf(close, at + close.length)
  ) {
    if (consumesEntirely(rest.slice(at + close.length))) return true;
  }
  return false;
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
