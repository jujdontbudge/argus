import { normalize } from "./normalize";

/**
 * Send kinds per research/send-transcript-matching.md §5. Slash and bang sends
 * land in derived transcript shapes (§2.3), so the matcher must accept those
 * forms in addition to (slash) or instead of (bang) the literal text.
 */
export type SendKind = "prompt" | "slash" | "bang";

export function deriveKind(text: string): SendKind {
  const t = normalize(text);
  if (/^\/\S/.test(t)) return "slash";
  if (/^!\S/.test(t)) return "bang";
  return "prompt";
}

/**
 * All transcript content forms a send may land as, normalized (§7):
 * - prompt: the normalized text.
 * - slash:  the normalized text (agents without slash handling take it
 *           literally) plus the observed Claude Code command XML record;
 *           zero landings are also benign for slash (local commands).
 * - bang:   `<bash-input>cmd</bash-input>` — the form an INTERACTIVE session
 *           records — and, since #78, the literal text as typed.
 *
 * #78's live drive is what added the second bang form, and the correction is
 * worth stating because the line above used to read "the `!` never lands".
 * That was true of the door it was measured through. Driven headlessly —
 * `claude -p --resume` (2.1.246) and `codex exec resume` (the two doors the
 * §13 live slot drive uses) — a bang send lands in the transcript VERBATIM,
 * `!` and all, because bash mode is a TUI feature and there is no TUI. With
 * only the interactive form derived, a real Hermes bang-send through that door
 * matched nothing, and an unmatched candidate is a Johan takeover: the §13.4
 * poisoning breach, reached by a nudge Hermes itself logged.
 *
 * This is #50's lesson again — the same logical event takes a different shape
 * depending on how the session was opened — so both shapes are derived and the
 * matcher accepts either. Widening cannot make Argus deaf to Johan: the only
 * text this newly matches is a bang send whose literal text Hermes had already
 * logged, which is exactly the ambiguity every prompt send has always had.
 */
export function derivedForms(text: string, kind: SendKind = deriveKind(text)): string[] {
  const t = normalize(text);
  if (kind === "slash") {
    const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(t);
    if (match) {
      const name = match[1]!;
      const args = match[2] ?? "";
      return [
        t,
        `<command-message>${name}</command-message>\n<command-name>/${name}</command-name>\n<command-args>${args}</command-args>`,
      ];
    }
    return [t];
  }
  if (kind === "bang") {
    return [`<bash-input>${normalize(t.slice(1))}</bash-input>`, t];
  }
  return [t];
}
