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
      // One brain, two questions: the scope-drift prompt is the one carrying
      // candidate blocks (#38).
      if (prompt.includes("[candidate=")) {
        return { ok: true, text: fixtureDriftAnswer(prompt) };
      }
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

/**
 * The drift half of the same fixture brain (#38). The eye hands ONE brain
 * both questions, so the fixture answers both: a prompt carrying
 * `[candidate=…]` blocks is the scope question, anything else is the retro
 * question above.
 *
 * Its rule is crude on purpose — the real judgment is what the live-luna test
 * covers — but it is crude in the direction the POLICY demands. A commit that
 * reads as a refactor, test, rename or fix, or whose subject and files share
 * any substantial word with the ticket's stated scope, is NOT drift. Only
 * work with no overlap at all, doing something the ticket never mentions, is.
 */
interface DriftBlock {
  id: string;
  scope: string;
  work: string;
}

const IN_SCOPE_BY_KIND =
  /\b(refactor|refactoring|test|tests|fixture|rename|renamed|move|moved|typo|lint|format|fix|fixes|fixing|revert|bump|deps?|dependency)\b/i;

function driftBlocks(prompt: string): DriftBlock[] {
  const parsed: DriftBlock[] = [];
  const pattern = /\[candidate=([^ \]]+)[^\]]*\]\n([\s\S]*?)(?=\n\[candidate=|$)/g;
  for (const match of prompt.matchAll(pattern)) {
    const block = match[2]!;
    const [stated = "", rest = ""] = block.split("work done in this ticket's session(s):");
    parsed.push({
      id: match[1]!,
      // The ticket title and its stated scope, without the eye's own labels.
      scope: stated
        .replace(/^ticket: #\d+ /m, "")
        .replace(/^stated scope:$/m, ""),
      // Commit subjects and file paths — the diff is left to the real brain.
      work: (rest.split("\ndiff:")[0] ?? rest)
        .split("\n")
        .flatMap((line) => {
          const commit = line.match(/^- [0-9a-f]{7} (.+)$/);
          if (commit) return [commit[1]!];
          const files = line.match(/^files: (.+)$/);
          return files ? [files[1]!] : [];
        })
        .join("\n"),
    });
  }
  return parsed;
}

/** Words long enough to mean something; file paths split like prose. */
function significantWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4),
  );
}

export function fixtureDriftAnswer(prompt: string): string {
  return JSON.stringify({
    drifts: driftBlocks(prompt).map(({ id, scope, work: subjects }) => {
      const stated = significantWords(scope);
      const done = significantWords(subjects);
      const shared = [...done].filter((word) => stated.has(word));
      const drift = shared.length === 0 && !IN_SCOPE_BY_KIND.test(subjects);
      return {
        candidateId: id,
        drift,
        confident: drift,
        what: drift ? "work the ticket never asked for" : null,
        outOfScopeWork: drift
          ? `The session committed:\n${subjects.trim()}\nNone of it serves the stated scope.`
          : null,
        whyOutOfScope: drift
          ? "Nothing in the diff overlaps with what the ticket states it wanted."
          : null,
      };
    }),
  });
}
