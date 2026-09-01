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
  type WorkerExit,
  type WorkerSpawn,
} from "../deploy";
import type { CmuxRun } from "../events";
import { loadEyesConfig } from "../eyes/config";
import { resolveGrillModel } from "../grill/config.ts";
import { isGrillMode } from "../grill/skills.ts";
import { enqueueVerification } from "../complete/queue.ts";
import { runGh, trackerRepoName, type GhRunner } from "../eyes/retro/gh";
import { addTicketLabel, claimingLogin, claimTicket, releaseClaim } from "./claim.ts";
import { readFrontier, type ExcludedTicket, type FrontierTicket } from "./frontier.ts";
import { recoverDeadSlots, type RecoveredSlot } from "./recover.ts";
import { routeAgent } from "./routing.ts";
import { createDispatchSlots, dispatchSlotsDirectory } from "./slots.ts";
import { dispatchMemoryPreamble } from "./preamble.ts";
import { dispatchSkillPreamble } from "./skill-match.ts";
import { DEFAULT_MEMORY_CAPS } from "./preamble.ts";
import { DEFAULT_SKILL_CAPS } from "./skill-match.ts";

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
  /**
   * Route EVERY ticket in the pass to this agent, overriding SPEC §2's label
   * table (#88). Left unset — as `argus dispatch` leaves it — each ticket is
   * routed by its own labels; this is the deliberate-caller escape hatch
   * (harness scenarios, a one-off re-run), never the normal path.
   */
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
  /** Bounded window in which an announced-but-dead worker is startup failure. */
  startupGraceMs?: number;
  /** The prompt that opens each session; the registry keeps a copy (§5). */
  dispatchPrompt?: (
    ticket: FrontierTicket,
    tracker: string,
    context?: DispatchPromptContext,
  ) => string;
  /** cmux workspace policy, passed through to `deployWorker`. */
  workspace?: "auto" | "none";
}

export interface DispatchComment {
  author: string;
  timestamp: string;
  body: string;
}

export interface DispatchRelatedTicket {
  number: string;
  title: string;
  state: "open" | "closed";
}

export interface DispatchPromptContext {
  comments: DispatchComment[];
  blockedBy: DispatchRelatedTicket[];
  subIssues: DispatchRelatedTicket[];
}

/** The immutable shell command declared in a ticket's Verification section. */
export function ticketVerificationCommand(body: string): string | null {
  const heading = /^##\s+Verification(?:\s+command[^\n]*)?\s*$/im.exec(body);
  if (heading === null) return null;
  const tail = body.slice(heading.index + heading[0].length);
  const nextHeading = /^##\s/m.exec(tail);
  const section = nextHeading === null ? tail : tail.slice(0, nextHeading.index);
  const fence = section.match(/```(?:sh|bash|shell)?\s*\n([\s\S]*?)```/i);
  const command = fence?.[1]?.trim();
  if (!command || /^<.*>$/.test(command)) return null;
  return command;
}

interface DispatchPromptReadOptions {
  cwd: string;
  gh?: GhRunner;
}

type DispatchPromptConfig = Awaited<ReturnType<typeof loadEyesConfig>>;

/**
 * The dispatch prompt. It names the ticket, quotes the stated scope, and says
 * the two things a worker cannot learn from the repo: that the session belongs
 * to exactly one ticket (§7.3.2), and that closing it is not the worker's job
 * (§7.3.4 — "the dispatcher owns ticket state").
 */
export function defaultDispatchPrompt(
  ticket: FrontierTicket,
  tracker: string,
  context: DispatchPromptContext = { blockedBy: [], comments: [], subIssues: [] },
): string {
  const planningGuidance = ticket.labels.some(isGrillMode)
    ? [
        "",
        "Before planning, load the repository Wayfinder contract from",
        "docs/agents/WAYFINDER.md and follow it. When the decisions identify concrete",
        "work, file executable tickets rather than leaving implementation in prose;",
        "each ticket must carry verification commands fixed at creation time (R5; D4).",
      ]
    : [];

  return [
    `You are an Argus worker on ticket #${ticket.number} of ${tracker}: ${ticket.title}`,
    "",
    "The ticket states:",
    "",
    ticket.body.trim() === "" ? "(no body)" : ticket.body.trim(),
    "",
    renderDispatchContext(context),
    "",
    "You are working in a git worktree created for this ticket alone, on its own",
    "branch. Implement the ticket test-first and commit your work to that branch.",
    "Do not merge, do not push, and do not close the ticket — the dispatcher owns",
    "ticket state. Stay inside the ticket's stated scope; anything else belongs in",
    "its own ticket.",
    "",
    "R2 (mandatory bail-out): the moment Hermes or Codex detects an unfiled consequential choice inside its ticket, it stops, records the question on the ticket, the ticket is relabeled/pinned to Fable, and the event queues to the digest per D9.",
    ...planningGuidance,
  ].join("\n");
}

/**
 * Read the ticket context that is not present in the frontier listing. This
 * deliberately has no local cap: the dispatch contract gives a worker the
 * whole thread and every linked ticket it needs to understand the work.
 */
export async function readDispatchContext(
  ticket: string,
  tracker: string,
  options: DispatchPromptReadOptions,
): Promise<DispatchPromptContext> {
  const gh = options.gh ?? runGh;
  const comments = await readComments(
    gh,
    options.cwd,
    `repos/${tracker}/issues/${ticket}/comments`,
  );
  const [blockedBy, subIssues] = await Promise.all([
    readRelatedTickets(
      gh,
      options.cwd,
      `repos/${tracker}/issues/${ticket}/dependencies/blocked_by`,
    ),
    readRelatedTickets(
      gh,
      options.cwd,
      `repos/${tracker}/issues/${ticket}/sub_issues`,
    ),
  ]);
  return { blockedBy, comments, subIssues };
}

/** Read one ticket for `--print-prompt`, including closed tickets. */
export async function readDispatchTicket(
  ticket: string,
  tracker: string,
  options: DispatchPromptReadOptions,
): Promise<FrontierTicket> {
  const gh = options.gh ?? runGh;
  const result = await gh(
    [
      "issue",
      "view",
      ticket,
      "--repo",
      tracker,
      "--json",
      "number,title,body,labels",
    ],
    options.cwd,
  );
  if (result.exitCode !== 0) {
    throw new Error(`gh issue view failed (exit ${result.exitCode}): ${commandDetail(result)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `gh issue view returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("gh issue view returned a non-object ticket");
  }
  const issue = parsed as Record<string, unknown>;
  const number = issue.number;
  if (typeof number !== "number" && typeof number !== "string") {
    throw new Error("gh issue view returned a ticket without a number");
  }
  return {
    body: typeof issue.body === "string" ? issue.body : "",
    labels: labels(issue.labels),
    number: String(number),
    title: typeof issue.title === "string" ? issue.title : "",
  };
}

/**
 * The one prompt assembler used by both deployment and `--print-prompt`, so
 * the preview cannot drift from what a worker actually receives.
 */
export async function buildDispatchPrompt(
  ticket: FrontierTicket,
  tracker: string,
  options: {
    repo: string;
    gh?: GhRunner;
    agent?: DeployAgent;
    config?: DispatchPromptConfig;
    dispatchPrompt?: DispatchOptions["dispatchPrompt"];
  },
): Promise<string> {
  const context = await readDispatchContext(ticket.number, tracker, {
    cwd: options.repo,
    ...(options.gh !== undefined && { gh: options.gh }),
  });
  const config = options.config ?? await loadEyesConfig(options.repo);
  const prompt = (options.dispatchPrompt ?? defaultDispatchPrompt)(ticket, tracker, context);
  return prompt +
    await dispatchMemoryPreamble(
      options.repo,
      `${ticket.title} ${ticket.body} ${ticket.labels.join(" ")}`,
      {
        maxFacts: config.dispatch.memoryMaxFacts ?? DEFAULT_MEMORY_CAPS.maxFacts,
        maxChars: config.dispatch.memoryMaxChars ?? DEFAULT_MEMORY_CAPS.maxChars,
      },
    ) +
    (options.agent === "codex"
      ? await dispatchSkillPreamble(
          options.repo,
          `${ticket.title} ${ticket.body} ${ticket.labels.join(" ")}`,
          {
            maxSkills: config.dispatch.skillMaxCount ?? DEFAULT_SKILL_CAPS.maxSkills,
            maxChars: config.dispatch.skillMaxChars ?? DEFAULT_SKILL_CAPS.maxChars,
          },
        )
      : "");
}

function renderDispatchContext(context: DispatchPromptContext): string {
  const comments = collapseBotComments(context.comments);
  return [
    "The ticket's GitHub context:",
    "",
    "Comments:",
    ...(comments.length === 0 ? ["(none)"] : comments),
    "",
    "Blocked by:",
    ...renderRelated(context.blockedBy),
    "",
    "Sub-issues:",
    ...renderRelated(context.subIssues),
    "",
    "Authority rule:",
    "Johan's newest statement wins, wherever it lives (comment or body). Only Johan's comments are decisions; bot/worker comments are never authority.",
  ].join("\n");
}

function collapseBotComments(comments: DispatchComment[]): string[] {
  const rendered: Array<{ comment: DispatchComment; count: number }> = [];
  for (const comment of comments) {
    const previous = rendered.at(-1);
    if (
      previous !== undefined &&
      comment.body.startsWith("[argus]") &&
      !isJohan(comment.author) &&
      previous.comment.body === comment.body &&
      previous.comment.body.startsWith("[argus]") &&
      !isJohan(previous.comment.author)
    ) {
      previous.count += 1;
      continue;
    }
    rendered.push({ comment, count: 1 });
  }
  return rendered.map(({ comment, count }) =>
    `- ${comment.author} (${comment.timestamp}): ${comment.body}` +
    (count === 1 ? "" : ` ×${count}`),
  );
}

function isJohan(author: string): boolean {
  return /^(johan|johansardar)$/i.test(author.trim());
}

function renderRelated(related: DispatchRelatedTicket[]): string[] {
  return related.length === 0
    ? ["(none)"]
    : related.map(({ number, title, state }) => `- #${number} — ${title} (${state})`);
}

async function readComments(
  gh: GhRunner,
  cwd: string,
  path: string,
): Promise<DispatchComment[]> {
  const result = await gh(["api", path, "--paginate", "--slurp"], cwd);
  const entries = parsePages(result, `gh api ${path}`);
  return entries.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`gh api ${path} returned an invalid comment at index ${index}`);
    }
    const comment = entry as Record<string, unknown>;
    const user = comment.user;
    const login =
      typeof user === "object" && user !== null
        ? (user as Record<string, unknown>).login
        : undefined;
    const author = typeof login === "string" ? login : "unknown";
    if (typeof comment.body !== "string" || typeof comment.created_at !== "string") {
      throw new Error(`gh api ${path} returned an incomplete comment at index ${index}`);
    }
    return { author, body: comment.body, timestamp: comment.created_at };
  });
}

async function readRelatedTickets(
  gh: GhRunner,
  cwd: string,
  path: string,
): Promise<DispatchRelatedTicket[]> {
  const result = await gh(["api", path, "--paginate", "--slurp"], cwd);
  const entries = parsePages(result, `gh api ${path}`);
  return entries.map((entry, index) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`gh api ${path} returned an invalid related ticket at index ${index}`);
    }
    const related = entry as Record<string, unknown>;
    if (
      (typeof related.number !== "number" && typeof related.number !== "string") ||
      typeof related.title !== "string"
    ) {
      throw new Error(`gh api ${path} returned incomplete related ticket at index ${index}`);
    }
    return {
      number: String(related.number),
      state: /^closed$/i.test(String(related.state)) ? "closed" : "open",
      title: related.title,
    };
  });
}

function parsePages(result: { exitCode: number; stdout: string; stderr: string }, command: string): unknown[] {
  if (result.exitCode !== 0) {
    throw new Error(`${command} failed (exit ${result.exitCode}): ${commandDetail(result)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `${command} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!Array.isArray(parsed)) throw new Error(`${command} returned a non-array response`);
  return parsed.flatMap((page) => (Array.isArray(page) ? page : [page]));
}

function commandDetail(result: { stderr: string; stdout: string }): string {
  return (result.stderr.trim() || result.stdout.trim()).slice(0, 500);
}

function labels(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const name = (entry as Record<string, unknown>).name;
    return typeof name === "string" ? [name] : [];
  });
}

async function exitDuringStartup(
  exited: Promise<WorkerExit>,
  graceMs: number,
): Promise<WorkerExit | null> {
  return Promise.race([
    exited,
    Bun.sleep(Math.max(0, graceMs)).then(() => null),
  ]);
}

export async function dispatchFrontier(
  options: DispatchOptions,
): Promise<DispatchReport> {
  const repo = options.repo;
  const gh = options.gh ?? runGh;
  const git = options.git ?? runGit;
  const forcedAgent = options.agent;
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
    ...(options.cmux !== undefined && { cmux: options.cmux }),
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

    if (
      config.dispatch.requireTicketVerification &&
      ticketVerificationCommand(ticket.body) === null
    ) {
      const reason = "ticket has no declared fenced Verification command";
      report.skipped.push({ reason, ticket: ticket.number });
      report.degraded.push(`ticket #${ticket.number}: ${reason}; routes to Johan`);
      continue;
    }

    // SPEC §2's routing table, BEFORE the slot and before the claim: a ticket
    // whose labels name no deployable agent must not spend capacity or leave
    // an assignment behind, and a refusal here costs one deferred dispatch
    // that a one-word label fix puts back on the next pass.
    let agent = forcedAgent;
    if (agent === undefined) {
      const routing = routeAgent(ticket.labels);
      if (routing.status === "refused") {
        report.skipped.push({ reason: routing.reason, ticket: ticket.number });
        report.degraded.push(`ticket #${ticket.number}: ${routing.reason}`);
        continue;
      }
      agent = routing.agent;
    }
    const planningRoute = agent === "claude" && ticket.labels.some(isGrillMode);
    const model = planningRoute
      ? await resolveGrillModel(repo, options.model)
      : options.model;

    // The slot BEFORE the claim and before anything is created: capacity is
    // the first thing checked, so a full cap cannot even assign a ticket.
    const slot = await slots.tryAcquire(ticket.number);
    if (slot === null) break;

    let prompt: string;
    try {
      prompt = await buildDispatchPrompt(ticket, tracker, {
        agent,
        config,
        dispatchPrompt: buildPrompt,
        gh,
        repo,
      });
    } catch (error) {
      await slot.release();
      const reason = error instanceof Error ? error.message : String(error);
      report.skipped.push({ reason, ticket: ticket.number });
      report.degraded.push(`ticket #${ticket.number}: ${reason}`);
      continue;
    }

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

    // R3: an explicit Opus fallback is allowed only for planning work that
    // needs to move now, and its owning ticket must carry the durable marker.
    // Mark and read it back before launch so a worker can never start with an
    // unrecorded degradation.
    if (planningRoute && model === "claude-opus-5") {
      const marked = await addTicketLabel({
        cwd: repo,
        label: "degraded-model",
        repo: tracker,
        run: gh,
        ticket: ticket.number,
      });
      if (marked.status === "failed") {
        const released = await releaseClaim({
          cwd: repo,
          login,
          repo: tracker,
          run: gh,
          ticket: ticket.number,
        });
        await slot.release();
        report.skipped.push({
          reason: marked.reason,
          ticket: ticket.number,
        });
        report.degraded.push(
          `ticket #${ticket.number}: ${marked.reason}` +
            (released ? "" : " (and the claim could not be released)"),
        );
        continue;
      }
    }

    // What "did this session produce anything?" will be measured against if it
    // dies. Read before the worktree exists, so it describes the starting point.
    const head = await git(["rev-parse", "HEAD"], repo);
    const baseSha = head.exitCode === 0 ? head.stdout.trim() : undefined;

    const deployment = await deployWorker(
      {
        agent,
        dispatchPrompt: prompt,
        repo,
        ticket: ticket.number,
        workspace: options.workspace ?? "auto",
        ...(model !== undefined && { model }),
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
    const startupExit = await exitDuringStartup(
      worker.process.exited,
      options.startupGraceMs ?? 250,
    );
    await slot.fill({
      agent: worker.agent,
      branch: worker.branch,
      sessionId: worker.sessionId,
      worktree: worker.worktree,
      ...(baseSha !== undefined && { baseSha }),
      // The slot now tracks the WORKER, not the dispatcher: this process may
      // exit while the session runs, and the cap must survive that.
      ...(startupExit !== null
        ? { pid: worker.process.pid ?? Number.MAX_SAFE_INTEGER }
        : worker.process.pid !== undefined
          ? { pid: worker.process.pid }
          : {}),
    });
    if (startupExit !== null) {
      const immediateRecovery = await recoverDeadSlots({
        cwd: repo,
        gh,
        git,
        ...(options.cmux !== undefined && { cmux: options.cmux }),
        login,
        repo,
        slots,
        tracker,
      });
      report.recovered.push(...immediateRecovery.recovered);
      report.degraded.push(...immediateRecovery.degraded);
      for (const recovered of immediateRecovery.recovered) {
        if (recovered.outcome !== "awaiting-verification") continue;
        await enqueueVerification(repo, {
          source: "recovery",
          ticket: recovered.ticket,
          ...(options.now !== undefined && { now: options.now }),
        });
      }
      const diagnostic = (startupExit.stderr.trim() || startupExit.stdout.trim()).slice(0, 300);
      const reason =
        `worker exited ${startupExit.exitCode} during startup` +
        (diagnostic === "" ? "" : `: ${diagnostic}`);
      report.skipped.push({ reason, ticket: ticket.number });
      report.degraded.push(`ticket #${ticket.number}: ${reason}`);
      continue;
    }
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
      // Always present on this path: #56 dispatches a frontier TICKET, and
      // `deployWorker` only makes it optional for §7.2's ticketless planning
      // sessions, which never come through here.
      ticket: worker.ticket ?? String(ticket.number),
      worktree: worker.worktree,
      ...(worker.workspace !== undefined && { workspace: worker.workspace }),
      ...(worker.workspaceDegraded !== undefined && {
        workspaceDegraded: worker.workspaceDegraded,
      }),
    });
  }

  return report;
}
