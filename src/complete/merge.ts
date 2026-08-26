/**
 * The merge (ticket #57; SPEC §7.3.4: "merge the worktree").
 *
 * NEVER MERGE — OR REVIEW — ON A STALE BASE. Everything this module measures
 * is measured from `git merge-base <base> <branch>`, never from the base tip.
 * The failure it prevents has bitten this dispatcher for real: while a ticket
 * session runs, other tickets land on `main`, and a diff taken against the
 * MOVED tip renders their files as this ticket's deletions. A reviewer shown
 * that diff is being asked the wrong question, and its answer — clean or
 * blocked — is worthless either way.
 *
 * The merge is LOCAL AND ONLY LOCAL. Nothing here pushes: SPEC §7.3.4 asks for
 * a merge, and publishing is a separate decision that no autonomous pass gets
 * to make on Johan's behalf.
 *
 * Two refusals guard the checkout, because the repo root is a place a human
 * also works:
 *
 *   - the checkout must be ON the base branch — merging into a detached HEAD
 *     or into whatever Johan happened to check out is a merge into the wrong
 *     history;
 *   - the checkout must be CLEAN — `git merge` would otherwise abort on his
 *     uncommitted work, or worse, succeed and mix it into the merge commit.
 *
 * Both are transient states, so both are reported as failures that leave the
 * ticket queued rather than as verdicts on the work.
 */
import { stat } from "node:fs/promises";

import type { GitRun } from "../deploy";

/** Bounded so a huge branch cannot blow up a review prompt. */
const MAX_DIFF_CHARACTERS = 200_000;

const detail = (result: { stderr: string; stdout: string }): string =>
  (result.stderr.trim() || result.stdout.trim()).slice(0, 300);

/** The current branch of a checkout, or null when HEAD is detached. */
export async function currentBranch(git: GitRun, repo: string): Promise<string | null> {
  const shown = await git(["rev-parse", "--abbrev-ref", "HEAD"], repo);
  if (shown.exitCode !== 0) return null;
  const name = shown.stdout.trim();
  return name === "" || name === "HEAD" ? null : name;
}

export interface BranchWork {
  /** The commit the ticket branched from — the ONLY honest diff origin. */
  mergeBase: string;
  /** Commits the ticket added since it branched. */
  commits: number;
  /** Commits of the ticket's that the base does not already contain. */
  unmerged: number;
  files: string[];
  diff: string;
  /** True when the diff was cut off at the bound. */
  truncated: boolean;
}

/**
 * What the ticket branch actually contains, measured from the merge base.
 *
 * `commits` and `unmerged` answer two different questions and the loop needs
 * both: `commits === 0` means the session produced nothing, while
 * `unmerged === 0` with `commits > 0` means the work is already in the base —
 * a pass that merged and then failed to close. Conflating them would either
 * merge twice or strand a merged ticket open forever.
 */
export async function readBranchWork(request: {
  base: string;
  branch: string;
  git: GitRun;
  repo: string;
}): Promise<BranchWork | { reason: string }> {
  const { base, branch, git, repo } = request;
  const found = await git(["merge-base", base, branch], repo);
  if (found.exitCode !== 0) {
    return { reason: `git merge-base ${base} ${branch} failed: ${detail(found)}` };
  }
  const mergeBase = found.stdout.trim();
  if (!/^[0-9a-f]{7,64}$/.test(mergeBase)) {
    return { reason: `git merge-base printed no commit for ${base}..${branch}` };
  }

  const counted = await git(["rev-list", "--count", `${mergeBase}..${branch}`], repo);
  if (counted.exitCode !== 0) {
    return { reason: `git rev-list ${mergeBase}..${branch} failed: ${detail(counted)}` };
  }
  const commits = Number(counted.stdout.trim());
  if (!Number.isInteger(commits)) {
    return { reason: `git rev-list printed no count for ${mergeBase}..${branch}` };
  }

  const ahead = await git(["rev-list", "--count", `${base}..${branch}`], repo);
  if (ahead.exitCode !== 0) {
    return { reason: `git rev-list ${base}..${branch} failed: ${detail(ahead)}` };
  }
  const unmerged = Number(ahead.stdout.trim());
  if (!Number.isInteger(unmerged)) {
    return { reason: `git rev-list printed no count for ${base}..${branch}` };
  }

  // Both reads start at the merge base, never at `base`.
  const named = await git(["diff", "--name-only", mergeBase, branch], repo);
  if (named.exitCode !== 0) {
    return { reason: `git diff --name-only failed: ${detail(named)}` };
  }
  const shown = await git(["diff", mergeBase, branch], repo);
  if (shown.exitCode !== 0) {
    return { reason: `git diff failed: ${detail(shown)}` };
  }
  const raw = shown.stdout;
  return {
    commits,
    diff: raw.length <= MAX_DIFF_CHARACTERS ? raw : raw.slice(0, MAX_DIFF_CHARACTERS),
    files: named.stdout.split("\n").filter((line) => line.trim() !== ""),
    mergeBase,
    truncated: raw.length > MAX_DIFF_CHARACTERS,
    unmerged,
  };
}

/** Why this checkout must not be merged into right now, or null. */
export async function checkoutRefusal(request: {
  base: string;
  git: GitRun;
  repo: string;
}): Promise<string | null> {
  const { base, git, repo } = request;
  const branch = await currentBranch(git, repo);
  if (branch === null) {
    return `the checkout has a detached HEAD, not ${base}; nothing was merged`;
  }
  if (branch !== base) {
    return `the checkout is on ${branch}, not ${base}; nothing was merged`;
  }
  // TRACKED changes only. An untracked file is Johan's scratch note or a
  // gitignored artifact, and `git merge` neither touches nor trips over it;
  // refusing on one would make the loop hostage to anything lying around the
  // checkout. A tracked modification is the real hazard — merge would either
  // abort on it or fold it into the merge commit.
  const status = await git(["status", "--porcelain", "--untracked-files=no"], repo);
  if (status.exitCode !== 0) {
    return `git status could not be read (${detail(status)}); nothing was merged`;
  }
  if (status.stdout.trim() !== "") {
    return (
      "the checkout has uncommitted changes to tracked files; nothing was merged"
    );
  }
  return null;
}

export type MergeResult =
  | { status: "merged"; sha: string }
  | { status: "failed"; reason: string };

/**
 * Merge the ticket branch into the base, with a merge commit.
 *
 * `--no-ff` on purpose: a fast-forward would erase the fact that this range of
 * commits was one ticket, and the ticket boundary is the unit the Retro eye,
 * the map and every later audit read history in.
 */
export async function mergeTicketBranch(request: {
  base: string;
  branch: string;
  git: GitRun;
  repo: string;
  ticket: string;
  title?: string;
}): Promise<MergeResult> {
  const { base, branch, git, repo, ticket } = request;
  const refusal = await checkoutRefusal({ base, git, repo });
  if (refusal !== null) return { reason: refusal, status: "failed" };

  const subject =
    request.title === undefined || request.title.trim() === ""
      ? `merge: ticket #${ticket}`
      : `merge: ${request.title.trim()} (#${ticket})`;
  const merged = await git(
    ["merge", "--no-ff", "--no-edit", "-m", subject, branch],
    repo,
  );
  if (merged.exitCode !== 0) {
    // Leave nothing half-merged behind: a conflicted index in the repo root
    // would break every later pass and every human who opens the checkout.
    const aborted = await git(["merge", "--abort"], repo);
    return {
      reason:
        `git merge ${branch} failed: ${detail(merged)}` +
        (aborted.exitCode === 0 ? "" : " (and `git merge --abort` also failed)"),
      status: "failed",
    };
  }
  const head = await git(["rev-parse", "HEAD"], repo);
  if (head.exitCode !== 0) {
    return { reason: `merged, but HEAD could not be read: ${detail(head)}`, status: "failed" };
  }
  return { sha: head.stdout.trim(), status: "merged" };
}

/**
 * Retire a merged ticket's worktree and branch. Returns null on success, or
 * the reason it could not be done.
 *
 * Deliberately unlike recovery's disposal (`src/dispatch/recover.ts`), which
 * removes a worktree that produced NOTHING and therefore uses `--force` and
 * `branch -D`. Here the work exists and is already in the base, so the safe
 * forms are the correct ones: a plain `worktree remove` refuses if the dead
 * session left anything uncommitted, and `branch -d` refuses if the branch is
 * somehow not merged after all. Both refusals are degradations, never merges
 * undone — the merge already happened and is not in question.
 */
export async function retireWorktree(request: {
  branch: string;
  git: GitRun;
  repo: string;
  worktree: string;
}): Promise<string | null> {
  const { branch, git, repo, worktree } = request;
  if (await directoryExists(worktree)) {
    const removed = await git(["worktree", "remove", worktree], repo);
    if (removed.exitCode !== 0) {
      return `the worktree could not be removed (${detail(removed)})`;
    }
  } else {
    await git(["worktree", "prune"], repo);
  }
  const deleted = await git(["branch", "-d", branch], repo);
  if (deleted.exitCode !== 0 && !/not found/i.test(deleted.stderr)) {
    return `the branch could not be deleted (${detail(deleted)})`;
  }
  return null;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}
