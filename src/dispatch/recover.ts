/**
 * Recovery (ticket #56): what happens when a claimed ticket's session dies.
 *
 * THE WHOLE PROBLEM IS TELLING DEAD FROM SLOW. A ticket session legitimately
 * runs for hours with nothing on stdout; a crashed one looks identical from
 * every angle except one — its process is gone. So:
 *
 *   liveness = the worker pid exists. Nothing else. Never a clock.
 *
 * Any elapsed-time rule would have to pick a number, and both wrong answers
 * are severe: too short abandons live work and re-dispatches a ticket an agent
 * is still holding, too long leaves the cap permanently consumed by corpses.
 * There is therefore no timeout anywhere in this module or in `./slots.ts`.
 *
 * A dead session's SLOT is always released — capacity must describe reality.
 * Its CLAIM is only released when the session left nothing behind, measured as
 * commits on the ticket branch since the sha HEAD was at deploy time:
 *
 *   - no commits, clean worktree
 *                 → the session accomplished nothing, so its worktree and
 *                   branch are removed and the ticket goes back to the
 *                   frontier for a fresh session to pick up. Removing them is
 *                   not tidying: `git worktree add -b argus/ticket-N` fails
 *                   while they exist, so a ticket returned to the frontier
 *                   without this can never actually be re-dispatched;
 *   - no commits, DIRTY worktree
 *                 → uncommitted work is still work. The claim stands and the
 *                   worktree is left exactly as the dead session left it;
 *   - commits     → there is real work on that branch. Re-dispatching over it
 *                   would duplicate the ticket and race the branch, so the
 *                   claim stands and the ticket is reported as awaiting the
 *                   verify/merge/close loop (#57, which owns what happens next);
 *   - cannot tell → treated exactly like "commits", loudly. Fail closed: a
 *                   stuck-but-visible ticket beats two agents on one branch.
 *   - blocked-on-human label → the dead session's slot is freed, but its
 *                   claim stands so recovery cannot re-feed the frontier.
 */
import { stat } from "node:fs/promises";

import { releaseClaim } from "./claim.ts";
import type { DispatchSlots, SlotEntry } from "./slots.ts";
import type { GhRunner } from "../eyes/retro/gh";
import { retireWorkerTab, runGit, type GitRun } from "../deploy";
import type { CmuxRun } from "../events";

export type RecoveryOutcome =
  /** Dead, produced nothing, unassigned: dispatchable again this very pass. */
  | "returned-to-frontier"
  /** Dead but committed: the claim stands, #57's verify loop owns it. */
  | "awaiting-verification"
  /** Dead with uncommitted changes in the worktree: nothing is thrown away. */
  | "uncommitted-work"
  /** Dead, but the ticket is intentionally paused for its repository owner. */
  | "blocked-on-human"
  /** Dead, and whether it produced work could not be read. Claim stands. */
  | "unknown-work"
  /** A slot with no readable ticket; freed so the cap stops lying. */
  | "discarded";

export interface RecoveredSlot {
  ticket: string;
  outcome: RecoveryOutcome;
  detail: string;
}

export interface RecoverRequest {
  cwd: string;
  /** The cmux seam #95's tab teardown runs through. Stubbed in every test. */
  cmux?: CmuxRun;
  git?: GitRun;
  gh: GhRunner;
  login: string;
  repo: string;
  /** `owner/name` — the tracker the claim lives on. */
  tracker: string;
  slots: DispatchSlots;
}

export interface RecoveryReport {
  recovered: RecoveredSlot[];
  degraded: string[];
  /** Slots still held by a LIVE worker after the pass. */
  live: SlotEntry[];
}

export async function recoverDeadSlots(
  request: RecoverRequest,
): Promise<RecoveryReport> {
  const git = request.git ?? runGit;
  const recovered: RecoveredSlot[] = [];
  const degraded: string[] = [];
  const live: SlotEntry[] = [];

  for (const entry of await request.slots.entries()) {
    // A live owner is a live deployment, full stop. Slow is not dead.
    if (entry.alive) {
      live.push(entry);
      continue;
    }

    if (entry.corrupt) {
      await request.slots.releaseAt(entry.path);
      degraded.push(
        `dispatch slot ${entry.path} was unreadable and has been discarded; ` +
          "any ticket it held stays assigned and needs a look",
      );
      recovered.push({
        detail: "the slot file could not be parsed",
        outcome: "discarded",
        ticket: "",
      });
      continue;
    }

    const { record } = entry;

    // #95: the dead session's TAB, before anything else is decided.
    //
    // This is the leak #82 actually produced. A worker that dies never reaches
    // #57's green path, so recovery is the only code that will ever look at
    // this deployment again — and Directive 14 / R6 is as much "fully closed
    // when done" as it is "never a new workspace". It runs for EVERY dead
    // slot, whatever the outcome below turns out to be: the tab is a shell
    // around a process that no longer exists, so it is dead whether the
    // session left commits, dirt or nothing at all. Unlike the worktree, a tab
    // holds no work that could be lost by closing it.
    //
    // Reported, never fatal. `retireWorkerTab` resolves the handle against
    // cmux's own inventory first and tolerates a tab that is already gone, so
    // the worst case here is a line in `degraded` — and a leak Johan can see
    // beats a leak he finds by counting workspaces.
    if (record.sessionId !== undefined) {
      const tab = await retireWorkerTab(
        { repo: request.repo, sessionId: record.sessionId },
        request.cmux,
      );
      if (tab !== null) {
        degraded.push(`ticket #${record.ticket}: the dead session left a tab open (${tab})`);
      }
    }

    const give = async (detail: string): Promise<void> => {
      const blocked = record.claimed
        ? await isBlockedOnHuman(request, record.ticket)
        : false;
      if (typeof blocked === "string") {
        await request.slots.releaseAt(entry.path);
        degraded.push(
          `ticket #${record.ticket}: could not determine whether it is blocked on a human ` +
            `(${blocked}); the claim stands rather than re-feed the frontier`,
        );
        recovered.push({ detail: blocked, outcome: "unknown-work", ticket: record.ticket });
        return;
      }
      const cleaned = await discardWorktree(git, request.repo, record);
      if (cleaned !== null) {
        // The ticket cannot be re-dispatched while its branch exists, so a
        // half-removed worktree must not look like a clean recovery.
        await request.slots.releaseAt(entry.path);
        degraded.push(
          `ticket #${record.ticket}: the dead session's worktree could not be ` +
            `cleared (${cleaned}); the claim stands rather than hand a fresh ` +
            "session a branch it cannot create",
        );
        recovered.push({
          detail: cleaned,
          outcome: "unknown-work",
          ticket: record.ticket,
        });
        return;
      }
      const released = record.claimed && !blocked
        ? await releaseClaim({
            cwd: request.cwd,
            login: request.login,
            repo: request.tracker,
            run: request.gh,
            ticket: record.ticket,
          })
        : true;
      if (!released) {
        degraded.push(
          `ticket #${record.ticket}: the dead session's claim could not be released; ` +
            "it will stay off the frontier until gh recovers",
        );
      }
      await request.slots.releaseAt(entry.path);
      recovered.push({
        detail: blocked
          ? `${detail}; the ticket is blocked on a human, so its claim stays in place`
          : detail,
        outcome: blocked ? "blocked-on-human" : "returned-to-frontier",
        ticket: record.ticket,
      });
    };

    // A reserved slot never reached a session: there is no branch to weigh.
    if (record.state === "reserved") {
      await give("the dispatcher died before the session started");
      continue;
    }

    const work = await commitsOnBranch(git, request.repo, record);
    if (typeof work === "string") {
      await request.slots.releaseAt(entry.path);
      degraded.push(
        `ticket #${record.ticket}: session ${record.sessionId ?? "?"} is dead and ` +
          `its branch could not be read (${work}); the claim stands rather than ` +
          "risk a second agent on the same work",
      );
      recovered.push({ detail: work, outcome: "unknown-work", ticket: record.ticket });
      continue;
    }
    const dirty = await uncommittedWork(git, record);
    if (dirty === true || typeof dirty === "string") {
      await request.slots.releaseAt(entry.path);
      const why =
        dirty === true
          ? "the worktree holds uncommitted changes"
          : `the worktree state could not be read (${dirty})`;
      degraded.push(
        `ticket #${record.ticket}: session ${record.sessionId ?? "?"} is dead and ` +
          `${why}; nothing was discarded and the claim stands`,
      );
      recovered.push({
        detail: why,
        outcome: work > 0 ? "awaiting-verification" : "uncommitted-work",
        ticket: record.ticket,
      });
      continue;
    }
    if (work > 0) {
      await request.slots.releaseAt(entry.path);
      recovered.push({
        detail: `${work} commit${work === 1 ? "" : "s"} on ${record.branch ?? "the branch"}`,
        outcome: "awaiting-verification",
        ticket: record.ticket,
      });
      continue;
    }
    await give("the session died without committing anything");
  }

  return { degraded, live, recovered };
}

async function isBlockedOnHuman(
  request: RecoverRequest,
  ticket: string,
): Promise<boolean | string> {
  const result = await request.gh(
    ["issue", "view", ticket, "--repo", request.tracker, "--json", "labels"],
    request.cwd,
  );
  if (result.exitCode !== 0) {
    return (result.stderr.trim() || result.stdout.trim() || `gh exited ${result.exitCode}`).slice(
      0,
      300,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return `not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (typeof parsed !== "object" || parsed === null) return "issue view returned a non-object";
  const labels = (parsed as Record<string, unknown>).labels;
  if (!Array.isArray(labels)) return "issue view returned no label array";
  return labels.some(
    (label) =>
      typeof label === "object" &&
      label !== null &&
      (label as Record<string, unknown>).name === "argus:blocked-on-human",
  );
}

/** Commits the dead session added, or a reason the question is unanswerable. */
async function commitsOnBranch(
  git: GitRun,
  repo: string,
  record: { baseSha?: string; branch?: string },
): Promise<number | string> {
  if (record.branch === undefined || record.baseSha === undefined) {
    return "the slot recorded no branch or base sha";
  }
  const counted = await git(
    ["rev-list", "--count", `${record.baseSha}..${record.branch}`],
    repo,
  );
  if (counted.exitCode !== 0) {
    return (counted.stderr.trim() || `git rev-list exited ${counted.exitCode}`).slice(
      0,
      300,
    );
  }
  const count = Number(counted.stdout.trim());
  return Number.isInteger(count) && count >= 0 ? count : "git rev-list printed no count";
}

/**
 * Whether the dead session left uncommitted changes. `false` means provably
 * clean; `true` means dirty; a string means the question could not be answered
 * and the caller must treat the worktree as if it were dirty.
 *
 * A worktree directory that is simply gone counts as clean: there is nothing
 * left to lose.
 */
async function uncommittedWork(
  git: GitRun,
  record: { worktree?: string },
): Promise<boolean | string> {
  if (record.worktree === undefined) return "the slot recorded no worktree";
  if (!(await directoryExists(record.worktree))) return false;
  const status = await git(["status", "--porcelain"], record.worktree);
  if (status.exitCode !== 0) {
    return (status.stderr.trim() || `git status exited ${status.exitCode}`).slice(0, 300);
  }
  return status.stdout.trim() !== "";
}

/**
 * Remove a dead session's worktree and branch so the ticket is dispatchable
 * again. Returns null on success, or the reason it could not be done.
 *
 * Only ever called for a session that is dead, committed nothing, and left a
 * clean worktree — the one state in which there is provably nothing to lose.
 * `--force` is scoped to that: it removes a worktree git considers unclean
 * only because of untracked ignored files, never one with real changes.
 */
async function discardWorktree(
  git: GitRun,
  repo: string,
  record: { branch?: string; worktree?: string },
): Promise<string | null> {
  if (record.worktree === undefined || record.branch === undefined) return null;
  if (await directoryExists(record.worktree)) {
    const removed = await git(["worktree", "remove", "--force", record.worktree], repo);
    if (removed.exitCode !== 0) {
      return (removed.stderr.trim() || `git worktree remove exited ${removed.exitCode}`)
        .slice(0, 300);
    }
  } else {
    await git(["worktree", "prune"], repo);
  }
  const deleted = await git(["branch", "-D", record.branch], repo);
  if (deleted.exitCode !== 0 && !/not found/i.test(deleted.stderr)) {
    return (deleted.stderr.trim() || `git branch -D exited ${deleted.exitCode}`).slice(
      0,
      300,
    );
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
