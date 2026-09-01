/**
 * `completeReadyTickets` — SPEC §7.3.4, one pass of it (ticket #57):
 *
 *   "On green (tests pass, review clean): merge the worktree, close the
 *    ticket, update the map. `implement` does not reliably close tickets
 *    itself; the dispatcher owns ticket state."
 *
 * This is the step that makes the batch autonomous. Without it a ticket runs,
 * finishes, and then waits for a human forever — which is what AUDIT.md §4
 * item 3 found, and why §13 scenario 1 could claim "zero human input" while
 * asserting nothing about a ticket ever closing.
 *
 * It composes and does not re-derive:
 *
 *   - completion signals come from #58's consumer (`pollHermesSignals`, the
 *     same sweep `argus signals` runs). There is no second channel;
 *   - "the worker died" is #56's line, not a second opinion. Liveness is the
 *     worker pid and nothing else, it is drawn in `recoverDeadSlots`, and a
 *     dead session reaches this loop only by being HANDED here — never by
 *     this module inspecting a process or, worse, a clock;
 *   - the worktree, the branch and the registry row are #55's, addressed the
 *     way #55 addresses them.
 *
 * THE PASS CAN REFUSE, AND MOST OF THIS FILE IS THAT. Gates run in the ticket's
 * worktree and a red one stops everything; the review can block; an
 * unavailable reviewer blocks; a dirty or wrong-branch checkout blocks; a
 * signal that says `dead` or `blocked` never reaches a gate at all. Every
 * refusal leaves the ticket open, the claim standing, the base branch byte-for-
 * byte where it was, and the work item on the durable queue so the next pass
 * tries again.
 *
 * ORDER, and why it is this one:
 *
 *   signal → queue → gates → review → merge → close → map → retire → release
 *
 * The queue entry is durable BEFORE any gate runs, because a signal is spent
 * when it is read (#58's shared cursor) and a crash between reading it and
 * closing the ticket must not lose the ticket. The map is updated AFTER the
 * close, because the map indexes closed tickets. The slot is released LAST,
 * because capacity that outlives the work is safe and capacity released early
 * is a second agent on the same ticket.
 */
import { stat } from "node:fs/promises";

import {
  branchForTicket,
  retireWorkerTab,
  runGit,
  worktreeForTicket,
  type GitRun,
} from "../deploy";
// The leaf module, not the barrel: `../dispatch` imports this package's queue,
// and two barrels importing each other is a cycle waiting to bite.
import { createDispatchSlots, dispatchSlotsDirectory } from "../dispatch/slots.ts";
import { pollHermesSignals, type CmuxRun, type HermesSignal } from "../events";
import type { Brain } from "../eyes/brain";
import { createCodexBrain } from "../eyes/brain";
import { loadEyesConfig } from "../eyes/config";
import { detectTracker, runGh, type GhRunner, type Tracker } from "../eyes/retro/gh";
import { loadRegistry, registryPaths } from "../provenance";
import {
  resolveRepositoryGates,
  runGates,
  runGateCommand,
  type Gate,
  type GateResult,
  type GateRunner,
} from "./gates.ts";
import { updateWayfinderMap, type MapUpdate } from "./map.ts";
import {
  checkoutRefusal,
  currentBranch,
  mergeTicketBranch,
  readBranchWork,
  retireWorktree,
} from "./merge.ts";
import {
  dequeueVerification,
  enqueueVerification,
  listVerifications,
  recordVerificationFailure,
  recordVerificationMerge,
  type VerifyEntry,
} from "./queue.ts";
import { createBrainReviewer, type Reviewer } from "./review.ts";

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export type CompletionStatus =
  /** Verified, merged into the base, closed, and indexed on the map. */
  | "merged"
  /** A gate refused. Nothing merged, nothing closed, ticket still claimed. */
  | "gate-failed"
  /** Gates could not be selected safely. Nothing ran or merged. */
  | "gate-configuration-error"
  /** The review refused, or could not answer. Same posture as a red gate. */
  | "review-blocked"
  /** The session wants a human (§6 blocked-on-human). Never a merge. */
  | "blocked-on-human"
  /** The session died rather than finished; #56's recovery owns it. */
  | "awaiting-recovery"
  /** The session ended having committed nothing. There is nothing to verify. */
  | "nothing-to-merge"
  /** Something went wrong that is not a verdict on the work. */
  | "failed";

export interface CompletionOutcome {
  ticket: string;
  status: CompletionStatus;
  detail: string;
  sessionId?: string;
  gates?: GateResult[];
  mergeSha?: string;
  map?: MapUpdate;
}

export interface CompletionReport {
  /** `owner/name`, or null in tracker-less mode (no remote, no auth). */
  tracker: string | null;
  /** The base branch this pass would merge into. */
  base: string;
  /** Work items still awaiting verification when the pass ended. */
  queued: number;
  completed: CompletionOutcome[];
  /** Anything that went wrong loudly enough to say out loud (ADR-0001). */
  degraded: string[];
}

export interface CompleteOptions {
  /** The repo whose registry, worktrees and base branch this pass uses. */
  repo: string;
  /** The branch tickets merge into. Defaults to the repo's checked-out one. */
  base?: string;
  /** The review brain; defaults to the config's `codex exec` tier. */
  brain?: Brain;
  /** The cmux seam #95's teardown closes the worker's tab through. Stubbed in tests. */
  cmux?: CmuxRun;
  /** Explicit caller override; production resolves repository gates when omitted. */
  gates?: readonly Gate[];
  gh?: GhRunner;
  git?: GitRun;
  now?: () => Date;
  /** Overrides the brain-backed reviewer entirely. */
  reviewer?: Reviewer;
  /** Overrides #58's sweep; the default IS `argus signals`' consumer. */
  signals?: () => Promise<HermesSignal[]>;
  runGate?: GateRunner;
}

/** The comment a refusal leaves on the ticket, so the reason is where the work is. */
function refusalComment(ticket: string, headline: string, body: string): string {
  return [
    `[argus] ticket #${ticket} was NOT merged: ${headline}`,
    "",
    body.trim(),
    "",
    "The ticket stays open and stays claimed. The next `argus complete` pass will",
    "verify it again.",
  ].join("\n");
}

/**
 * #104 finding 2: the comment a BLOCK leaves on the ticket.
 *
 * A blocked worker used to write its reason to `.argus/events/*.json` and
 * nowhere else. #82 measured six blocked sessions across three cycles against
 * three tickets showing `comments=0`; #99 re-measured three blocks against
 * three tickets whose only comment was `argus complete`'s merge notice. The
 * tracker is Johan's whole interface to an AFK batch — SPEC §7.3's premise is
 * that he can walk away — so a block that is invisible there is a worker that
 * has silently stopped.
 *
 * This is adjacent to #96 and not the same. #96 covers a deployment that never
 * produced a transcript at all, and measures it from outside by its silence.
 * This one ran, reached a decision point, and had a reason to give; it simply
 * had nowhere to say it. So the fix is not another detector — it is giving the
 * existing reason a destination.
 *
 * WHY A COMMENT AND NOT ONLY A STATUS ROW. The row already exists: this pass
 * returns `status: "blocked-on-human"` and `argus complete` prints it. What a
 * row cannot do is survive the process that printed it. A comment is durable,
 * it is attached to the ticket the block is about, and it is where Johan is
 * already looking. The row stays too — it is what an operator watching a live
 * pass sees — so this is both, each doing the thing the other cannot.
 *
 * HOW THIS AVOIDS A COMMENT PER POLL. The session-keyed dedup in
 * `pollHermesSignals` still prevents one session's signal from being handled
 * twice. The ticket-keyed check below is a second guard for a repeated signal
 * or a replay after the consumer state was lost: it compares the complete
 * `[argus]` comment body before posting, so an unchanged explanation cannot
 * accumulate on the ticket.
 */
function blockedComment(ticket: string, reason: string): string {
  const trimmed = reason.trim();
  return [
    `[argus] ticket #${ticket} is BLOCKED ON A HUMAN: the worker stopped and is`,
    "waiting on you. It did not merge and it did not close the ticket.",
    "",
    "The worker's reason:",
    "",
    trimmed === "" ? "(the session reported blocked-on-human without a reason)" : trimmed,
    "",
    "The ticket stays open and stays claimed. Nothing further happens on it until",
    "you answer — no later `argus complete` pass will retry it on its own.",
  ].join("\n");
}

const BLOCKED_ON_HUMAN_LABEL = "argus:blocked-on-human";

async function ensureBlockedLabel(
  gh: GhRunner,
  cwd: string,
  tracker: string,
  ticket: string,
): Promise<{ ok: boolean; detail: string }> {
  const listed = await gh(
    ["label", "list", "--repo", tracker, "--limit", "100", "--json", "name"],
    cwd,
  );
  if (listed.exitCode !== 0) {
    return {
      detail: `gh label list failed (exit ${listed.exitCode}): ${listed.stderr.trim() || listed.stdout.trim()}`,
      ok: false,
    };
  }
  let labels: unknown;
  try {
    labels = JSON.parse(listed.stdout);
  } catch (error) {
    return {
      detail: `gh label list returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      ok: false,
    };
  }
  if (
    !Array.isArray(labels) ||
    !labels.every(
      (label) =>
        typeof label === "object" &&
        label !== null &&
        typeof (label as Record<string, unknown>).name === "string",
    )
  ) {
    return { detail: "gh label list returned an invalid label list", ok: false };
  }
  if (!labels.some((label) => (label as { name: string }).name === BLOCKED_ON_HUMAN_LABEL)) {
    const created = await gh(
      [
        "label",
        "create",
        BLOCKED_ON_HUMAN_LABEL,
        "--repo",
        tracker,
        "--color",
        "B60205",
        "--description",
        "Ticket is waiting for the repository owner",
      ],
      cwd,
    );
    if (created.exitCode !== 0 && !/already exists/i.test(created.stderr)) {
      return {
        detail: `gh label create failed (exit ${created.exitCode}): ${created.stderr.trim() || created.stdout.trim()}`,
        ok: false,
      };
    }
  }

  const edited = await gh(
    ["issue", "edit", ticket, "--repo", tracker, "--add-label", BLOCKED_ON_HUMAN_LABEL],
    cwd,
  );
  return edited.exitCode === 0
    ? { detail: "", ok: true }
    : {
        detail: `gh issue edit --add-label failed (exit ${edited.exitCode}): ${edited.stderr.trim() || edited.stdout.trim()}`,
        ok: false,
      };
}

interface TicketComment {
  body: string;
  createdAt: string | null;
}

async function latestArgusComment(
  gh: GhRunner,
  cwd: string,
  tracker: string,
  ticket: string,
): Promise<TicketComment | null | { error: string }> {
  const result = await gh(
    [
      "api",
      `repos/${tracker}/issues/${ticket}/comments`,
      "--paginate",
      "--slurp",
    ],
    cwd,
  );
  if (result.exitCode !== 0) {
    return {
      error: `gh api issue comments failed (exit ${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return {
      error: `gh api issue comments returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const pages = Array.isArray(parsed) && parsed.every(Array.isArray) ? parsed.flat() : parsed;
  if (!Array.isArray(pages)) return { error: "gh api issue comments returned a non-array" };
  const comments = pages.flatMap((value): TicketComment[] => {
    if (typeof value !== "object" || value === null) return [];
    const row = value as Record<string, unknown>;
    if (typeof row.body !== "string" || !row.body.startsWith("[argus]")) return [];
    const createdAt =
      typeof row.created_at === "string" && !Number.isNaN(Date.parse(row.created_at))
        ? row.created_at
        : null;
    return [{ body: row.body, createdAt }];
  });
  return comments.sort((a, b) => {
    if (a.createdAt === null || b.createdAt === null) return 0;
    return a.createdAt.localeCompare(b.createdAt);
  }).at(-1) ?? null;
}

async function comment(
  gh: GhRunner,
  cwd: string,
  tracker: string,
  ticket: string,
  text: string,
): Promise<{ ok: boolean; detail: string }> {
  // Best effort by design: a comment that cannot be posted must not change
  // what the pass decided about the work. It IS reported, though — `gh` exits
  // nonzero rather than throwing, so a caller that only guarded against a
  // thrown error would treat a rejected post as a successful one.
  try {
    const result = await gh(
      ["issue", "comment", ticket, "--repo", tracker, "--body", text],
      cwd,
    );
    if (result.exitCode === 0) return { ok: true, detail: "" };
    return {
      ok: false,
      detail: `gh exited ${result.exitCode}: ${result.stderr.trim().slice(0, 500)}`,
    };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

export async function completeReadyTickets(
  options: CompleteOptions,
): Promise<CompletionReport> {
  const repo = options.repo;
  const gh = options.gh ?? runGh;
  const git = options.git ?? runGit;
  const gates = options.gates;
  const gateRunner = options.runGate ?? runGateCommand;
  const config = await loadEyesConfig(repo);
  const brain =
    options.brain ??
    createCodexBrain({
      model: config.brain.model,
      reasoningEffort: config.brain.reasoningEffort,
    });
  const review = options.reviewer ?? createBrainReviewer(brain);
  const base = options.base ?? (await currentBranch(git, repo)) ?? "main";

  const report: CompletionReport = {
    base,
    completed: [],
    degraded: [],
    queued: 0,
    tracker: null,
  };

  const tracker = await detectTracker(repo, gh);
  if (tracker === null) {
    report.degraded.push(
      "no GitHub tracker for this repo (no remote, no auth, or no network); " +
        "no ticket can be closed, so nothing was merged",
    );
    report.queued = (await listVerifications(repo)).length;
    return report;
  }
  report.tracker = tracker.repo;

  // 1. Turn this sweep's terminal signals into durable work items. A signal is
  //    spent when read; from here on the queue is what remembers.
  const signals = await (options.signals ?? (() => pollHermesSignals(repo)))();
  if (signals.length > 0) {
    const registry = await loadRegistry(registryPaths(repo));
    for (const signal of signals) {
      const ticket = ticketFor(registry.sessions, signal.sessionId);
      if (ticket === null) continue; // an ad hoc session: not this loop's business
      if (signal.status === "blocked") {
        // #104 finding 2: say so ON THE TICKET. The signal is already spent —
        // `pollHermesSignals` marked it delivered — so this is the only moment
        // the reason has a destination, and a comment that fails to post is a
        // block that goes back to being invisible. That is worth degrading
        // loudly about (#96's shape: degraded with a readable reason), even
        // though, like every other comment here, it cannot change the verdict.
        const text = blockedComment(ticket, signal.reason);
        const label = await ensureBlockedLabel(gh, repo, tracker.repo, ticket);
        if (!label.ok) {
          report.degraded.push(
            `ticket #${ticket} is blocked on a human but could not be labeled: ${label.detail}`,
          );
        }
        const latest = await latestArgusComment(gh, repo, tracker.repo, ticket);
        let posted: { ok: boolean; detail: string };
        if (latest !== null && "error" in latest) {
          // The comment remains best effort, but a failed read is visible: the
          // caller cannot know whether this ticket already has this exact
          // explanation, so the next successful pass should be investigated.
          report.degraded.push(
            `ticket #${ticket} blocked-comment dedupe could not be read: ${latest.error}`,
          );
          posted = await comment(gh, repo, tracker.repo, ticket, text);
        } else if (latest?.body === text) {
          posted = { detail: "", ok: true };
        } else {
          posted = await comment(gh, repo, tracker.repo, ticket, text);
        }
        if (!posted.ok) {
          report.degraded.push(
            `ticket #${ticket} is blocked on a human and the comment saying so could ` +
              `not be posted (${posted.detail}); the reason survives only in ` +
              `.argus/events for session ${signal.sessionId}`,
          );
        }
        report.completed.push({
          detail:
            "the session reported blocked-on-human; a ticket waiting on Johan is " +
            "not a ticket to merge" +
            posted.ok
              ? latest !== null && !("error" in latest) && latest.body === text
                ? " (an identical ticket comment already exists)"
                : " (the reason was commented on the ticket)"
              : "",
          sessionId: signal.sessionId,
          status: "blocked-on-human",
          ticket,
        });
        continue;
      }
      if (signal.status === "dead") {
        // FINISHED IS NOT DIED. #56 draws this line by the worker pid in
        // `recoverDeadSlots`, and a dead session's fate — its claim, its
        // worktree, whether it left commits at all — is decided there. A
        // `dead` status is the absence of a completion, so it never becomes
        // one here.
        report.completed.push({
          detail:
            "the session died rather than finished; #56's recovery pass decides " +
            "whether it left work behind",
          sessionId: signal.sessionId,
          status: "awaiting-recovery",
          ticket,
        });
        continue;
      }
      await enqueueVerification(repo, {
        sessionId: signal.sessionId,
        source: "signal",
        ticket,
        ...(options.now !== undefined && { now: options.now }),
      });
    }
  }

  // 2. Work the queue: this sweep's signals plus every ticket an earlier pass
  //    refused and every ticket recovery handed over.
  for (const entry of await listVerifications(repo)) {
    const outcome = await verifyOne({
      base,
      entry,
      ...(options.cmux !== undefined && { cmux: options.cmux }),
      gateRunner,
      ...(gates !== undefined && { gates }),
      gh,
      git,
      repo,
      review,
      tracker,
    });
    report.completed.push(outcome.outcome);
    report.degraded.push(...outcome.degraded);
  }

  report.queued = (await listVerifications(repo)).length;
  return report;
}

function ticketFor(
  sessions: readonly { sessionId: string; ticket?: string }[],
  sessionId: string,
): string | null {
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    const record = sessions[index]!;
    if (record.sessionId !== sessionId) continue;
    return record.ticket !== undefined && record.ticket !== "" ? record.ticket : null;
  }
  return null;
}

interface VerifyOutcome {
  outcome: CompletionOutcome;
  degraded: string[];
}

async function verifyOne(request: {
  base: string;
  cmux?: CmuxRun;
  entry: VerifyEntry;
  gateRunner: GateRunner;
  gates?: readonly Gate[];
  gh: GhRunner;
  git: GitRun;
  repo: string;
  review: Reviewer;
  tracker: Tracker;
}): Promise<VerifyOutcome> {
  const { base, entry, gh, git, repo, tracker } = request;
  const ticket = entry.ticket;
  const branch = branchForTicket(ticket);
  const worktree = worktreeForTicket(repo, ticket);
  const degraded: string[] = [];
  const common = {
    ticket,
    ...(entry.sessionId !== undefined && { sessionId: entry.sessionId }),
  };

  const refuse = async (
    status: CompletionStatus,
    detail: string,
    extra: Partial<CompletionOutcome> = {},
  ): Promise<VerifyOutcome> => {
    await recordVerificationFailure(repo, ticket, detail);
    degraded.push(`ticket #${ticket}: ${detail}`);
    return { degraded, outcome: { ...common, ...extra, detail, status } };
  };

  const work = await readBranchWork({ base, branch, git, repo });
  if ("reason" in work) {
    return refuse("failed", `the ticket branch could not be read: ${work.reason}`);
  }

  // "Already merged" is a fact the queue remembers, never one git is asked to
  // reconstruct: after a merge, `merge-base base branch` is the branch tip, so
  // a merged ticket and a ticket that committed nothing are the same empty
  // range to git. `unmerged === 0` only corroborates it.
  const alreadyMerged = entry.mergedSha !== undefined && work.unmerged === 0;

  if (!alreadyMerged && work.commits === 0) {
    // The session ended and produced nothing. There is no work to verify and
    // nothing to close a ticket on, so the ticket goes back to being somebody's
    // problem — visibly. Recovery owns re-dispatch, not this loop.
    await dequeueVerification(repo, ticket);
    const detail =
      "the session ended without committing anything to its branch; nothing was " +
      "merged and the ticket was not closed";
    degraded.push(`ticket #${ticket}: ${detail}`);
    return { degraded, outcome: { ...common, detail, status: "nothing-to-merge" } };
  }

  const scope = await tracker.readTicket(ticket);
  if (scope === null) {
    return refuse("failed", "the ticket could not be read from the tracker");
  }

  let mergeSha: string | undefined;
  let mergeDetail: string;
  let successfulGateResults: GateResult[] | undefined;

  if (alreadyMerged) {
    // An earlier pass merged and then failed to close. Re-gating it would be
    // theatre — the merge it would guard has happened — and re-merging it
    // would be a lie in the history. Resume at the close.
    mergeSha = entry.mergedSha;
    mergeDetail = `already merged into ${base} as ${entry.mergedSha!.slice(0, 12)}; this pass closed the ticket`;
  } else {
    // Cheap refusals first: the gates are the expensive part of a pass, and
    // spending minutes on them to then refuse for a reason that was true
    // before they started is how a loop earns a reputation for wasting time.
    if (!(await directoryExists(worktree))) {
      return refuse(
        "failed",
        `the ticket's worktree ${worktree} is gone, so its gates cannot be run`,
      );
    }
    const early = await checkoutRefusal({ base, git, repo });
    if (early !== null) return refuse("failed", early);

    const resolution =
      request.gates === undefined
        ? await resolveRepositoryGates(repo, worktree)
        : request.gates.length > 0
          ? { gates: request.gates, source: "CompleteOptions.gates", status: "resolved" as const }
          : {
              reason: "CompleteOptions.gates cannot be empty",
              status: "error" as const,
            };
    if (resolution.status === "error") {
      await comment(
        gh,
        repo,
        tracker.repo,
        ticket,
        refusalComment(ticket, "completion gates are not configured", resolution.reason),
      );
      return refuse("gate-configuration-error", resolution.reason);
    }

    const gateReport = await runGates(
      worktree,
      resolution.gates,
      request.gateRunner,
    );
    if (!gateReport.passed) {
      const failure = gateReport.failure!;
      await comment(
        gh,
        repo,
        tracker.repo,
        ticket,
        refusalComment(
          ticket,
          `the \`${failure.name}\` gate failed (exit ${failure.exitCode})`,
          ["```", failure.output || "(no output)", "```"].join("\n"),
        ),
      );
      return refuse(
        "gate-failed",
        `the ${failure.name} gate failed (exit ${failure.exitCode}); nothing was merged`,
        { gates: gateReport.results },
      );
    }
    successfulGateResults = gateReport.results;

    const verdict = await request.review({
      body: scope.body,
      diff: work.diff,
      files: work.files,
      ticket,
      title: scope.title,
      truncated: work.truncated,
      worktree,
    });
    if (verdict.status !== "clean") {
      const headline =
        verdict.status === "blocked"
          ? "the review blocked it"
          : "the review could not be completed, which blocks";
      await comment(
        gh,
        repo,
        tracker.repo,
        ticket,
        refusalComment(
          ticket,
          headline,
          [verdict.summary, ...verdict.concerns.map((concern) => `- ${concern}`)].join("\n"),
        ),
      );
      return refuse(
        "review-blocked",
        `${headline}: ${[verdict.summary, ...verdict.concerns].filter(Boolean).join("; ")}`,
        { gates: gateReport.results },
      );
    }

    // `mergeTicketBranch` re-checks the checkout: the gates just took minutes,
    // and Johan may have started editing in that window.
    const merged = await mergeTicketBranch({
      base,
      branch,
      git,
      repo,
      ticket,
      title: scope.title,
    });
    if (merged.status === "failed") {
      return refuse("failed", merged.reason, { gates: gateReport.results });
    }
    mergeSha = merged.sha;
    mergeDetail = `merged into ${base} as ${merged.sha.slice(0, 12)}`;
    // Durable before the close: everything after this is resumable, and
    // nothing after this may conclude the branch was empty.
    await recordVerificationMerge(repo, ticket, merged.sha);
  }

  // The dispatcher owns ticket state (§7.3.4) — never the worker.
  const closed = await gh(
    [
      "issue",
      "close",
      ticket,
      "--repo",
      tracker.repo,
      "--reason",
      "completed",
      "--comment",
      `[argus] ${mergeDetail}. Gates green, review clean.`,
    ],
    repo,
  );
  if (closed.exitCode !== 0) {
    const reason =
      `${mergeDetail}, but the ticket could not be closed ` +
      `(${(closed.stderr.trim() || closed.stdout.trim()).slice(0, 300)}); it stays ` +
      "queued so the next pass closes it";
    return refuse("failed", reason, { ...(mergeSha !== undefined && { mergeSha }) });
  }

  const map = await updateWayfinderMap({
    cwd: repo,
    gh,
    gist: mergeDetail,
    ticket,
    title: scope.title,
    tracker: tracker.repo,
    url: `https://github.com/${tracker.repo}/issues/${ticket}`,
  });
  if (map.status === "failed") {
    degraded.push(
      `ticket #${ticket}: merged and closed, but the wayfinder map could not be ` +
        `updated (${map.reason})`,
    );
  }

  const retired = await retireWorktree({ branch, git, repo, worktree });
  if (retired !== null) {
    degraded.push(`ticket #${ticket}: merged and closed, but ${retired}`);
  }

  // The tab goes with the worktree (#95). They are the two things the
  // deployment brought into existence, and Directive 14 / R6 is as much about
  // "fully closed when done" as it is about "never a new workspace" — #82 left
  // three of these standing on Johan's machine and he closed them by hand.
  // Reported, never swallowed: a teardown that fails quietly leaves exactly
  // the leak this ticket exists to remove, only harder to see.
  if (entry.sessionId !== undefined) {
    const tab = await retireWorkerTab({ repo, sessionId: entry.sessionId }, request.cmux);
    if (tab !== null) degraded.push(`ticket #${ticket}: merged and closed, but ${tab}`);
  }

  // Capacity last: the ticket is finished, so the slot it held is a lie.
  const released = await releaseSlot(repo, ticket);
  if (released !== null) degraded.push(`ticket #${ticket}: ${released}`);

  await dequeueVerification(repo, ticket);
  return {
    degraded,
    outcome: {
      ...common,
      detail: mergeDetail,
      map: map.status === "failed" ? "no-map" : map.status,
      status: "merged",
      ...(mergeSha !== undefined && { mergeSha }),
      ...(successfulGateResults !== undefined && { gates: successfulGateResults }),
    },
  };
}

/** Give back the dispatch slot this ticket held, if it still holds one. */
async function releaseSlot(repo: string, ticket: string): Promise<string | null> {
  try {
    const config = await loadEyesConfig(repo);
    const slots = createDispatchSlots({
      directory: dispatchSlotsDirectory(repo),
      maxConcurrency: config.dispatch.maxConcurrency,
    });
    for (const entry of await slots.entries()) {
      if (entry.corrupt || entry.record.ticket !== ticket) continue;
      await slots.releaseAt(entry.path);
    }
    return null;
  } catch (error) {
    return `the dispatch slot could not be released (${
      error instanceof Error ? error.message : String(error)
    })`;
  }
}
