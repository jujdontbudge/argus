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
