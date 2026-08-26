/**
 * `dispatchFrontier` — SPEC §7.3's AFK ticket dispatch, one pass of it
 * (ticket #56).
 *
 * §7.3 in order, and this function is that order:
 *
 *   1. read the frontier (open, unblocked, unclaimed) from GitHub — `./frontier.ts`
 *   2. per ticket: claim (assign) → worktree → fresh session → registry row →
 *      dispatch to the routed agent — the last four ARE `deployWorker` (#55),
 *      which this module builds on rather than reimplements
 *   3. concurrency cap 3, from `.argus/config.yaml` — `./slots.ts`
 *   4. (#57's) verify/merge/close — not done here. What IS here is the
 *      hand-off: a dead session that left commits is the one thing recovery
 *      can tell apart from a dead session that left nothing, so recovery
 *      enqueues it for #57's loop instead of making #57 re-derive it.
 *
 * WHERE THE CAP IS ENFORCED IS THE POINT. AUDIT.md §4 item 2 recorded the cap
 * as prose because the config file only ever carried the brain's budget; the
 * failure class one step beyond that is a cap that is parsed and then not
 * applied. So the slot is taken BEFORE the deployment is attempted and there
 * is exactly one call to `deployWorker` in the tree, inside the branch where a
 * slot is already held. `dispatchFrontier` is the door production uses (`argus
 * dispatch`) and the door the tests use, so the cap cannot be true for one and
 * false for the other.
 *
 * THE ORDER OF THE FIRST TWO WRITES ALSO MATTERS, for the same reason #55's
 * did. The claim is durable on GitHub before the worktree exists, and the
 * registry row is durable before the process exists:
 *
 *   claim → slot → worktree → registry row (fsync) → spawn
 *
 * and every step fails back into the one before it: a lost claim releases the
 * slot, a failed deployment releases both the slot and the claim, so a ticket
 * is never left assigned to a session that does not exist.
 */
import {
  deployWorker,
  runGit,
  type DeployAgent,
  type GitRun,
  type WorkerSpawn,
} from "../deploy";
import type { CmuxRun } from "../events";
import { loadEyesConfig } from "../eyes/config";
import { enqueueVerification } from "../complete/queue.ts";
import { runGh, trackerRepoName, type GhRunner } from "../eyes/retro/gh";
import { claimingLogin, claimTicket, releaseClaim } from "./claim.ts";
import { readFrontier, type ExcludedTicket, type FrontierTicket } from "./frontier.ts";
import { recoverDeadSlots, type RecoveredSlot } from "./recover.ts";
import { createDispatchSlots, dispatchSlotsDirectory } from "./slots.ts";

export interface DispatchedTicket {
  ticket: string;
  sessionId: string;
  agent: DeployAgent;
  branch: string;
  worktree: string;
  workspace?: string;
  workspaceDegraded?: string;
}

export interface SkippedTicket {
  ticket: string;
  reason: string;
}

export interface DispatchReport {
  /** `owner/name`, or null in tracker-less mode (no remote, no auth). */
  tracker: string | null;
  maxConcurrency: number;
  /** Slots held by a live worker after this pass. */
  inFlight: number;
  dispatched: DispatchedTicket[];
  recovered: RecoveredSlot[];
  skipped: SkippedTicket[];
  /** Tickets the frontier read set aside, with why. */
  excluded: ExcludedTicket[];
  /** Anything that went wrong loudly enough to say out loud (ADR-0001). */
  degraded: string[];
}

export interface DispatchOptions {
  /** The repo whose registry, config and worktrees this pass uses. */
  repo: string;
  /** Route every ticket to this agent (SPEC §7.3.2's "routed agent"). */
  agent?: DeployAgent;
  cmux?: CmuxRun;
  env?: Readonly<Record<string, string | undefined>>;
  gh?: GhRunner;
  git?: GitRun;
  /** Overrides `.argus/config.yaml`; the config is the normal source. */
  maxConcurrency?: number;
  model?: string;
  newSessionId?: () => string;
  now?: () => Date;
  spawn?: WorkerSpawn;
  /** The prompt that opens each session; the registry keeps a copy (§5). */
  dispatchPrompt?: (ticket: FrontierTicket, tracker: string) => string;
  /** cmux workspace policy, passed through to `deployWorker`. */
  workspace?: "auto" | "none";
}

/**
 * The dispatch prompt. It names the ticket, quotes the stated scope, and says
 * the two things a worker cannot learn from the repo: that the session belongs
 * to exactly one ticket (§7.3.2), and that closing it is not the worker's job
 * (§7.3.4 — "the dispatcher owns ticket state").
 */
export function defaultDispatchPrompt(
  ticket: FrontierTicket,
  tracker: string,
): string {
  return [
    `You are an Argus worker on ticket #${ticket.number} of ${tracker}: ${ticket.title}`,
    "",
    "The ticket states:",
    "",
    ticket.body.trim() === "" ? "(no body)" : ticket.body.trim(),
    "",
    "You are working in a git worktree created for this ticket alone, on its own",
    "branch. Implement the ticket test-first and commit your work to that branch.",
    "Do not merge, do not push, and do not close the ticket — the dispatcher owns",
    "ticket state. Stay inside the ticket's stated scope; anything else belongs in",
    "its own ticket.",
  ].join("\n");
}

export async function dispatchFrontier(
  options: DispatchOptions,
): Promise<DispatchReport> {
  const repo = options.repo;
  const gh = options.gh ?? runGh;
  const git = options.git ?? runGit;
  const agent = options.agent ?? "claude";
  const buildPrompt = options.dispatchPrompt ?? defaultDispatchPrompt;
  const config = await loadEyesConfig(repo);
  const maxConcurrency = options.maxConcurrency ?? config.dispatch.maxConcurrency;

  const report: DispatchReport = {
    degraded: [],
    dispatched: [],
    excluded: [],
    inFlight: 0,
    maxConcurrency,
    recovered: [],
    skipped: [],
    tracker: null,
  };

  const slots = createDispatchSlots({
    directory: dispatchSlotsDirectory(repo),
    maxConcurrency,
    ...(options.now !== undefined && { now: options.now }),
  });

  const tracker = await trackerRepoName(repo, gh);
  if (tracker === null) {
    // Tracker-less mode: no frontier exists to read, so nothing is dispatched
    // and — importantly — no slot is touched. Live workers keep their slots.
    report.degraded.push(
      "no GitHub tracker for this repo (no remote, no auth, or no network); " +
        "there is no frontier to dispatch",
    );
    report.inFlight = (await slots.entries()).filter((entry) => entry.alive).length;
    return report;
  }
  report.tracker = tracker;

  const identity = await claimingLogin(gh, repo);
  if ("reason" in identity) {
    // A dispatcher that cannot name itself cannot claim, and a dispatch
    // without a claim is the double-spawn this ticket exists to prevent.
    report.degraded.push(`${identity.reason}; nothing was claimed or dispatched`);
    report.inFlight = (await slots.entries()).filter((entry) => entry.alive).length;
    return report;
  }
  const login = identity.login;

  // Recovery runs FIRST: a dead session's slot is capacity this pass may need,
  // and a dead session's ticket may belong back on the frontier we are about
  // to read. Doing it after the read would defer both by a whole cycle.
  const recovery = await recoverDeadSlots({
    cwd: repo,
    gh,
    git,
    login,
    repo,
    slots,
    tracker,
  });
  report.recovered = recovery.recovered;
  report.degraded.push(...recovery.degraded);

  // The one place dead-with-work is distinguished from dead-with-nothing is
  // recovery, so it is also the place that hand-off happens: a dead session
  // that left commits becomes #57's work item here rather than being
  // re-derived there from a pid this pass has already reaped.
  for (const recovered of recovery.recovered) {
    if (recovered.outcome !== "awaiting-verification") continue;
    await enqueueVerification(repo, {
      source: "recovery",
      ticket: recovered.ticket,
      ...(options.now !== undefined && { now: options.now }),
    });
  }
  let inFlight = recovery.live.length;
  report.inFlight = inFlight;

  if (inFlight >= maxConcurrency) {
    // At capacity: do not spend the frontier read. The cap is the answer.
    return report;
  }

  const frontier = await readFrontier({ cwd: repo, repo: tracker, run: gh });
  report.excluded = frontier.excluded;
  report.degraded.push(...frontier.degraded);

  for (const ticket of frontier.tickets) {
    if (inFlight >= maxConcurrency) break;

    // The slot BEFORE the claim and before anything is created: capacity is
    // the first thing checked, so a full cap cannot even assign a ticket.
    const slot = await slots.tryAcquire(ticket.number);
    if (slot === null) break;

    const claim = await claimTicket({
      cwd: repo,
      login,
      repo: tracker,
      run: gh,
      ticket: ticket.number,
    });
    if (claim.status !== "claimed") {
      await slot.release();
      report.skipped.push({ reason: claim.reason, ticket: ticket.number });
      if (claim.status === "failed") {
        report.degraded.push(`ticket #${ticket.number}: ${claim.reason}`);
      }
      continue;
    }
    await slot.markClaimed();

    // What "did this session produce anything?" will be measured against if it
    // dies. Read before the worktree exists, so it describes the starting point.
    const head = await git(["rev-parse", "HEAD"], repo);
    const baseSha = head.exitCode === 0 ? head.stdout.trim() : undefined;

    const deployment = await deployWorker(
      {
        agent,
        dispatchPrompt: buildPrompt(ticket, tracker),
        repo,
        ticket: ticket.number,
        workspace: options.workspace ?? "auto",
        ...(options.model !== undefined && { model: options.model }),
      },
      {
        git,
        ...(options.cmux !== undefined && { cmux: options.cmux }),
        ...(options.env !== undefined && { env: options.env }),
        ...(options.newSessionId !== undefined && { newSessionId: options.newSessionId }),
        ...(options.now !== undefined && { now: options.now }),
        ...(options.spawn !== undefined && { spawn: options.spawn }),
      },
    );

    if (deployment.status === "failed") {
      // Give everything back, in the reverse order it was taken. A ticket
      // assigned to a session that does not exist is worse than an unclaimed
      // one: nothing will ever pick it up again.
      const released = await releaseClaim({
        cwd: repo,
        login,
        repo: tracker,
        run: gh,
        ticket: ticket.number,
      });
      await slot.release();
      const reason = `${deployment.stage}: ${deployment.reason}`;
      report.skipped.push({ reason, ticket: ticket.number });
      report.degraded.push(
        `ticket #${ticket.number}: deployment failed at ${reason}` +
          (released ? "" : " (and the claim could not be released)"),
      );
      continue;
    }

    const worker = deployment.deployment;
    await slot.fill({
      agent: worker.agent,
      branch: worker.branch,
      sessionId: worker.sessionId,
      worktree: worker.worktree,
      ...(baseSha !== undefined && { baseSha }),
      // The slot now tracks the WORKER, not the dispatcher: this process may
      // exit while the session runs, and the cap must survive that.
      ...(worker.process.pid !== undefined && { pid: worker.process.pid }),
    });
    if (worker.process.pid === undefined) {
      report.degraded.push(
        `ticket #${ticket.number}: the spawned worker reported no pid, so its slot ` +
          "stays owned by this dispatcher and recovery will free it when this " +
          "process exits",
      );
    }
    if (worker.workspaceDegraded !== undefined) {
      report.degraded.push(
        `ticket #${ticket.number}: no cmux workspace (${worker.workspaceDegraded})`,
      );
    }

    inFlight += 1;
    report.inFlight = inFlight;
    report.dispatched.push({
      agent: worker.agent,
      branch: worker.branch,
      sessionId: worker.sessionId,
      ticket: worker.ticket,
      worktree: worker.worktree,
      ...(worker.workspace !== undefined && { workspace: worker.workspace }),
      ...(worker.workspaceDegraded !== undefined && {
        workspaceDegraded: worker.workspaceDegraded,
      }),
    });
  }

  return report;
}
