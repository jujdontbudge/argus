/**
 * The deterministic Retro brain (SPEC §13: fixture-driven, no LLM in tests).
 *
 * It reads the eye's OWN prompt blocks — the same text a real `codex exec`
 * would see — and answers the contract in ./schema.ts, so every other part of
 * the pipeline (scan → attribute → signal → judge → compose → file) runs for
 * real. Its judgment is crude on purpose: a block that shows code changing is
 * implementation; a block that only shows talk is not.
 */
import type { Brain } from "../brain";

interface ParsedBlock {
  id: string;
  text: string;
}

function blocks(prompt: string): ParsedBlock[] {
  const parsed: ParsedBlock[] = [];
  const pattern = /\[signal=([^ \]]+)[^\]]*\]\n([\s\S]*?)(?=\n\[signal=|\n## |$)/g;
  for (const match of prompt.matchAll(pattern)) {
    parsed.push({ id: match[1]!, text: match[2]! });
  }
  return parsed;
}

/** `- #15 Ship the widget pipeline` under the candidates heading. */
function candidates(prompt: string): string[] {
  const section = prompt.split("## candidate parent tickets")[1] ?? "";
  return [...section.matchAll(/^- #(\d+)/gm)].map((match) => match[1]!);
}

function firstLine(text: string, pattern: RegExp): string | null {
  return text.split("\n").find((line) => pattern.test(line))?.trim() ?? null;
}

export function fixtureRetroBrain(): Brain {
  return {
    async evaluate({ prompt }) {
      const parents = candidates(prompt);
      return {
        ok: true,
        text: JSON.stringify({
          retros: blocks(prompt).map(({ id, text }) => {
            const commit = firstLine(text, /^- [0-9a-f]{7} /);
            const uncommitted = firstLine(text, /^uncommitted:/);
            const planningOnly = /planning|grilling|no code/i.test(text);
            const implementation = !planningOnly && (commit !== null || uncommitted !== null);
            const what =
              commit?.replace(/^- [0-9a-f]{7} /, "").replace(/ \(files:.*$/, "") ??
              uncommitted?.replace(/^uncommitted: /, "uncommitted changes to ") ??
              "work with no ticket";
            return {
              signalId: id,
              implementation,
              what,
              summary: `The retro fixture brain saw ${
                implementation ? "implementation" : "no implementation"
              } in signal ${id}.`,
              parentTicket: implementation ? (parents[0] ?? null) : null,
            };
          }),
        }),
      };
    },
  };
}
