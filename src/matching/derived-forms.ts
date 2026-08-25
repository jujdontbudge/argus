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
 * - bang:   only `<bash-input>cmd</bash-input>` — the `!` never lands.
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
    return [`<bash-input>${normalize(t.slice(1))}</bash-input>`];
  }
  return [t];
}
