/**
 * Composing the retro ticket (SPEC §5.5: "body derived from Johan's prompts
 * plus the diff").
 *
 * Everything a retro says is composed HERE, from evidence, never from the
 * brain's prose: the prompts are the ones provenance classified Johan-authored
 * (§5 rule 3) and the diff is what git actually reported. The brain supplies
 * only the title phrase and a summary line.
 *
 * The provenance gate is enforced at this boundary too, not just upstream: a
 * caller that hands over a whole batch cannot leak Hermes' dispatch or the
 * agent's own words into a section headed "Johan's prompts".
 */
import type { Author } from "../../provenance";
import type { ParentResolution } from "./parent";
import type { RetroSignal } from "./signal";

/** A classified transcript turn the retro may quote. */
export interface RetroPrompt {
  sessionId: string;
  ts: string;
  text: string;
  /** Provenance's verdict — only "johan" is quoted as Johan's. */
  author: Author;
}

export interface ComposeRetroInput {
  /** The brain's phrase for the title. */
  what: string;
  /** The brain's short narrative. */
  summary: string;
  signal: RetroSignal;
  prompts: readonly RetroPrompt[];
  parent: ParentResolution;
  repoRoot: string;
}

export interface RetroComposition {
  title: string;
  body: string;
}

/** GitHub's issue title limit. */
const MAX_TITLE = 256;
/** GitHub's issue body limit, with room to spare for the closing sections. */
export const MAX_BODY_BYTES = 60_000;
const TITLE_PREFIX = "Retro: ";

function cap(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function sourceLines(signal: RetroSignal, repoRoot: string): string[] {
  const lines: string[] = [];
  const changes = signal.changes;
  if (signal.sources.includes("git")) {
    const where =
      signal.dir !== null && signal.dir !== repoRoot
        ? `${signal.dir} (worktree of ${repoRoot})`
        : repoRoot;
    const commits = changes?.commits.length ?? 0;
    const uncommitted = changes?.workingTree?.files.length ?? 0;
    lines.push(
      `- **git** — ${commits} commit(s)` +
        (uncommitted > 0 ? ` and ${uncommitted} uncommitted file(s)` : "") +
        ` in \`${where}\` that no registered ticket session covers.`,
    );
  }
  if (signal.sources.includes("transcript")) {
    for (const session of signal.sessions.filter((entry) => entry.digestFile)) {
      lines.push(
        `- **transcript** — the digest of session \`${session.sessionId}\`` +
          ` (${session.agent ?? "unknown agent"}, \`${session.digestFile}\`)` +
          " records work with no ticket claimed.",
      );
    }
  }
  if (!signal.sources.includes("git")) {
    lines.push("- no git changes were attributed to this session at scan time.");
  }
  return lines;
}

function changeSections(signal: RetroSignal): string[] {
  const changes = signal.changes;
  if (changes === null) return [];
  const sections: string[] = [];
  const files = [
    ...new Set([
      ...changes.commits.flatMap((commit) => commit.files),
      ...(changes.workingTree?.files ?? []),
    ]),
  ];
  if (files.length > 0) {
    sections.push(
      ["## Files touched", "", ...files.map((file) => `- \`${file}\``)].join("\n"),
    );
  }
  if (changes.commits.length > 0) {
    sections.push(
      [
        "## Commits",
        "",
        ...changes.commits.map(
          (commit) =>
            `- \`${shortSha(commit.sha)}\` ${commit.subject} — ${commit.authorName}` +
            ` <${commit.authorEmail}>, ${commit.ts}`,
        ),
      ].join("\n"),
    );
  }
  return sections;
}

function diffSection(signal: RetroSignal): string | null {
  const changes = signal.changes;
  if (changes === null) return null;
  const parts: string[] = [];
  for (const commit of changes.commits) {
    parts.push(`### \`${shortSha(commit.sha)}\` ${commit.subject}\n\n\`\`\`diff\n${commit.diff.trimEnd()}\n\`\`\``);
  }
  if (changes.workingTree) {
    parts.push(
      `### Uncommitted working-tree changes\n\n\`\`\`diff\n${changes.workingTree.diff.trimEnd()}\n\`\`\``,
    );
  }
  if (parts.length === 0) return null;
  return ["## Diff", "", ...parts].join("\n\n");
}

/**
 * Trim the DIFF, never the record. Prompts, provenance and the parent rule
 * are what make a retro auditable; the patch is evidence that can be re-read
 * from git, so it is the only section allowed to lose bytes.
 */
function fit(head: string, diff: string | null): string {
  if (diff === null) return head;
  const budget = MAX_BODY_BYTES - head.length - 2;
  if (budget <= 0) return head;
  if (diff.length <= budget) return `${head}\n\n${diff}`;
  const marker = "\n… diff truncated: read it from the commits above …\n```\n";
  const room = Math.max(0, budget - marker.length);
  return `${head}\n\n${diff.slice(0, room)}${marker}`;
}

export function composeRetro(input: ComposeRetroInput): RetroComposition {
  const { signal } = input;
  const johan = input.prompts.filter((prompt) => prompt.author === "johan");
  const sessions = signal.sessions.map((session) => session.sessionId);

  const promptSection =
    johan.length > 0
      ? [
          "## Johan's prompts",
          "",
          "Provenance-verified Johan-authored turns from these sessions:",
          "",
          ...johan.map((prompt) => `${quote(prompt.text)}\n> \n> — \`${prompt.sessionId}\`, ${prompt.ts}`),
        ].join("\n\n")
      : [
          "## Johan's prompts",
          "",
          "_None: no Johan-authored prompts were classified for this work — it was autonomous agent work._",
        ].join("\n");

  const narratives = signal.sessions
    .filter((session) => session.narrative !== undefined)
    .map(
      (session) =>
        `### \`${session.sessionId}\`\n\n${session.narrative!.trimEnd()}`,
    );

  const head = [
    "_Filed automatically by the Argus Retro eye (SPEC §5.5): implementation" +
      " work no claimed ticket covers. Filed closed — the work already" +
      " happened; edit freely._",
    "",
    input.summary.trim(),
    "",
    "## Signal",
    "",
    ...sourceLines(signal, input.repoRoot),
    `- parent: ${input.parent.parent === null ? "none (root-level retro)" : `#${input.parent.parent}`} (rule: \`${input.parent.rule}\`)`,
    `- sessions: ${sessions.length > 0 ? sessions.map((id) => `\`${id}\``).join(", ") : "none observed"}`,
    `- signal id: \`${signal.id}\``,
    "",
    promptSection,
    ...(narratives.length > 0 ? ["", "## What the session's digest says", "", ...narratives] : []),
    ...changeSections(signal).flatMap((section) => ["", section]),
  ].join("\n");

  return {
    title: cap(`${TITLE_PREFIX}${input.what.trim()}`, MAX_TITLE),
    body: fit(head, diffSection(signal)),
  };
}
