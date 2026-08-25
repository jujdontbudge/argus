/**
 * The Retro eye's SCOPE-DRIFT signal (SPEC §14, ticket #38): the case both
 * existing signals are blind to.
 *
 * Johan hijacks a REGISTERED ticket session and does something else in it.
 * Git attributes those commits to the ticket (the session is registered, the
 * worktree is the ticket's) and the digest carries a ticket, so neither the
 * git signal nor the transcript signal sees anything anomalous. Catching it
 * needs a judgment neither asks for: **is this diff what the ticket asked
 * for?** — the work against the ticket's STATED scope, not the mere existence
 * of a ticket.
 *
 * So this signal feeds on the other half of attribution: `attributed`, the
 * changes a registered ticket session DOES cover. The ./git.ts scan already
 * maps every worktree to its parent repo (§7.3) and already caps its diffs;
 * both are reused here rather than re-derived.
 *
 * ## The false-positive policy — the load-bearing part
 *
 * The burden of proof is on DRIFT. A legitimate in-scope refactor, a test
 * update, a rename, a dependency of the work, or a fix that unblocked the
 * gates is NOT drift. Only work serving a DIFFERENT goal than the ticket
 * states is. Ambiguity resolves to SILENCE.
 *
 * That asymmetry is not a matter of taste: one false positive costs Johan's
 * trust in every retro issue Argus will ever file, while a missed drift costs
 * exactly one un-filed issue. It is stated to the brain in the prompt AND
 * enforced by the eye in `decideDrift` — the model has to clear two bars
 * (drift AND confident) and articulate the out-of-scope work concretely
 * before a single character reaches the tracker.
 */
import { hashText } from "../../matching";
import type { AttributedChanges } from "./attribution";
import type { GitCommit, WorkingTreeChange } from "./git";
import type { TicketScope } from "./gh";
import type { DriftJudgment } from "./schema";

/** The stated scope, as ./gh.ts reads it back — one definition, one seam. */
export type { TicketScope } from "./gh";

/** One checkout's slice of a candidate's work. */
export interface DriftWork {
  dir: string;
  commits: GitCommit[];
  workingTree: WorkingTreeChange | null;
}

/** One "is this diff what the ticket asked for?" question, ready to ask. */
export interface DriftCandidate {
  /** Content-derived: the same unjudged work always keys the same question. */
  id: string;
  /** The ticket the registry says this work is covered by. */
  ticket: string;
  /** Parent repo owning `.argus/` and the tracker (§7.3 worktree mapping). */
  repoRoot: string;
  /** Sessions observed doing the work, for the retro body. */
  sessionIds: string[];
  work: DriftWork[];
}

/**
 * A ticket body must actually STATE a scope before a diff can be measured
 * against it. An empty body says nothing; a one-liner is a label, not a
 * scope. Judging against either is guessing, and the policy forbids guessing
 * in the direction of drift — so both are silence, not suspicion.
 *
 * The title is deliberately not counted: every ticket has one, so counting it
 * would make every ticket judgeable and turn the gate off.
 */
const MIN_SCOPE_LINES = 2;
const MIN_SCOPE_CHARS = 80;

export function isJudgeableScope(scope: TicketScope): boolean {
  const lines = scope.body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return (
    lines.length >= MIN_SCOPE_LINES &&
    lines.join(" ").length >= MIN_SCOPE_CHARS
  );
}

export interface BuildDriftCandidatesInput {
  /** Changes a registered ticket session covers — attribution's other half. */
  attributed: readonly AttributedChanges[];
  /**
   * The worktree to parent-repo mapping ./git.ts already computed. Within one
   * scan every checkout resolves to the same parent, so a ticket worked in
   * several of its worktrees is ONE question; work spanning parent repos is
   * one question per repo, because the tracker is per repo.
   */
  parentRepoOf: (dir: string) => string;
}

function isEmpty(changes: AttributedChanges): boolean {
  return changes.commits.length === 0 && changes.workingTree === null;
}

/** Short, stable, and collision-resistant enough to key "already judged". */
function candidateId(parts: readonly string[]): string {
  return `drift-${hashText(parts.join("")).slice(0, 16)}`;
}

export function buildDriftCandidates(
  input: BuildDriftCandidatesInput,
): DriftCandidate[] {
  const byKey = new Map<string, DriftCandidate>();

  for (const changes of input.attributed) {
    if (isEmpty(changes)) continue;
    const repoRoot = input.parentRepoOf(changes.dir);
    const ticket = changes.coverage.ticket;
    const key = `${repoRoot} ${ticket}`;
    const candidate = byKey.get(key) ?? {
      id: "",
      ticket,
      repoRoot,
      sessionIds: [],
      work: [],
    };
    for (const sessionId of [changes.coverage.sessionId, ...changes.sessionIds]) {
      if (!candidate.sessionIds.includes(sessionId)) {
        candidate.sessionIds.push(sessionId);
      }
    }
    candidate.work.push({
      dir: changes.dir,
      commits: changes.commits,
      workingTree: changes.workingTree,
    });
    byKey.set(key, candidate);
  }

  return [...byKey.values()].map((candidate) => ({
    ...candidate,
    id: candidateId([
      candidate.repoRoot,
      candidate.ticket,
      ...candidate.work.flatMap((work) => [
        work.dir,
        ...work.commits.map((commit) => commit.sha),
        ...(work.workingTree
          ? ["working-tree", ...work.workingTree.files, work.workingTree.diff]
          : []),
      ]),
    ]),
  }));
}

/** One question: this candidate's work, against this ticket's stated scope. */
export interface DriftQuestion {
  candidate: DriftCandidate;
  scope: TicketScope;
}

/**
 * Prompt budgets. The scan already truncates each commit diff at its own cap
 * (./git.ts, 60 kB); these bound the PROMPT, so a candidate carrying a
 * hundred commits degrades to a readable sample instead of an unsendable
 * wall. Every elision is marked, and the prompt tells the model in so many
 * words that an elision is not evidence of drift.
 */
const MAX_PROMPT_DIFF_BYTES = 16_000;
const MAX_PROMPT_COMMITS = 40;
const MAX_PROMPT_FILES = 200;
const MAX_TICKET_BODY_CHARS = 6_000;

const TRUNCATION_NOTE =
  "… truncated: evidence was elided to fit this prompt, which is NOT evidence" +
  " of drift …";

function clip(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n${TRUNCATION_NOTE}\n`;
}

function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

/** What the work actually was: subjects, files, then as much diff as fits. */
function describeWork(candidate: DriftCandidate): string[] {
  const lines: string[] = [];
  const commits = candidate.work.flatMap((work) =>
    work.commits.map((commit) => ({ dir: work.dir, commit })),
  );
  const files = [
    ...new Set(
      candidate.work.flatMap((work) => [
        ...work.commits.flatMap((commit) => commit.files),
        ...(work.workingTree?.files ?? []),
      ]),
    ),
  ];

  lines.push(`checkouts: ${candidate.work.map(({ dir }) => dir).join(", ")}`);
  if (commits.length > 0) {
    lines.push("commits:");
    for (const { commit } of commits.slice(0, MAX_PROMPT_COMMITS)) {
      lines.push(`- ${shortSha(commit.sha)} ${commit.subject}`);
    }
    if (commits.length > MAX_PROMPT_COMMITS) {
      lines.push(`- … ${commits.length - MAX_PROMPT_COMMITS} more commit(s); ${TRUNCATION_NOTE}`);
    }
  }
  if (files.length > 0) {
    lines.push(`files: ${files.slice(0, MAX_PROMPT_FILES).join(", ")}`);
    if (files.length > MAX_PROMPT_FILES) {
      lines.push(`… ${files.length - MAX_PROMPT_FILES} more file(s); ${TRUNCATION_NOTE}`);
    }
  }

  const diff = [
    ...commits.map(({ commit }) => commit.diff),
    ...candidate.work.flatMap((work) =>
      work.workingTree ? [work.workingTree.diff] : [],
    ),
  ]
    .join("\n")
    .trimEnd();
  if (diff.length > 0) {
    lines.push("diff:", clip(diff, MAX_PROMPT_DIFF_BYTES));
  }
  return lines;
}

function describeQuestion({ candidate, scope }: DriftQuestion): string {
  return [
    `[candidate=${candidate.id} ticket=${scope.number} state=${scope.state}]`,
    `ticket: #${scope.number} ${scope.title}`,
    "stated scope:",
    clip(scope.body.trimEnd(), MAX_TICKET_BODY_CHARS),
    "work done in this ticket's session(s):",
    ...describeWork(candidate),
  ].join("\n");
}

/**
 * The prompt STATES the policy the eye then enforces. Both halves matter: a
 * model told only "find drift" finds drift everywhere, and a gate with no
 * stated policy makes the model guess at the bar it has to clear.
 */
export function buildDriftPrompt(questions: readonly DriftQuestion[]): string {
  return [
    "You are the Argus Retro eye, judging SCOPE DRIFT inside a ticket.",
    "Each block below is work done in a session registered to a ticket,",
    "together with what that ticket actually asked for. For each block answer",
    "ONE question: is this diff what the ticket asked for?",
    "Do not run any commands; judge only from the blocks.",
    "",
    "## The policy — read it before you answer",
    "",
    "The burden of proof is on DRIFT. Report drift ONLY for work that serves a",
    "DIFFERENT goal than the ticket states. All of the following are IN scope",
    "and are NOT drift, even when the ticket never mentions them:",
    "",
    "- refactors of the code the ticket touches, however large;",
    "- test additions, test updates and fixtures for the ticket's work;",
    "- renames, moves, formatting and type-level cleanup along the way;",
    "- anything the stated work depends on, including changes to other files;",
    "- fixing something that was blocking the build, the tests or the gates.",
    "",
    "If a diff is a plausible way to accomplish the stated scope, it is NOT",
    "drift. If you are unsure, it is NOT drift: set drift false, or leave",
    "confident false. Ambiguity resolves to silence.",
    "",
    "This asymmetry is deliberate. One false positive costs Johan's trust in",
    "every retro issue Argus will ever file; one missed drift costs a single",
    "un-filed issue. When the two are balanced, choose silence.",
    "",
    "Evidence may have been truncated to fit this prompt. Truncation is NOT",
    "evidence of drift — judge only what you can actually see.",
    "",
    "Emit JSON matching the output schema, one entry per candidate id:",
    "- drift: true only for work serving a different goal than the ticket states.",
    "- confident: false whenever you are unsure; an unsure drift is not reported.",
    "- what: a short phrase naming the out-of-scope work, or null.",
    "- outOfScopeWork: what was done that the ticket did not ask for,",
    "  concretely — files and behaviour — or null.",
    "- whyOutOfScope: why it serves a different goal, or null.",
    "",
    ...questions.map((question) => `${describeQuestion(question)}\n`),
  ].join("\n");
}

/** Why a judgment did or did not reach the tracker; audited either way. */
export interface DriftDecision {
  file: boolean;
  reason: string;
}

function blank(text: string | null): boolean {
  return text === null || text.trim().length === 0;
}

/**
 * The policy, ENFORCED. Stating it in the prompt is necessary and not
 * sufficient: a model that hedges, or that calls something drift without
 * being able to say what the out-of-scope work was, must not be able to
 * file. Both bars — drift AND confident — plus an articulated `what`,
 * `outOfScopeWork` and `whyOutOfScope`, or the eye stays silent.
 */
export function decideDrift(judgment: DriftJudgment): DriftDecision {
  if (!judgment.drift) {
    return { file: false, reason: "the brain judged this work not drift" };
  }
  if (!judgment.confident) {
    return {
      file: false,
      reason: "the brain reported drift but was not confident; ambiguity is silence",
    };
  }
  if (blank(judgment.what) || blank(judgment.outOfScopeWork)) {
    return {
      file: false,
      reason:
        "the brain reported drift without naming the out-of-scope work; a drift" +
        " that cannot be described concretely is not filed",
    };
  }
  if (blank(judgment.whyOutOfScope)) {
    return {
      file: false,
      reason:
        "the brain reported drift without saying why it serves a different goal",
    };
  }
  return { file: true, reason: "confident, articulated drift" };
}
