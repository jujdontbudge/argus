/**
 * `deployWorker` — the registry-first worker deployment primitive (#55).
 *
 * SPEC §7.3.2, one step of it, on its own: claim → **create a git worktree →
 * fresh session (one ticket, one session, always) → register the deployment →
 * dispatch to the routed agent**. The frontier read and the claim (#56) and
 * the verify/merge/close loop (#57) sit on top of this; neither is here.
 *
 * THE ORDER IS THE FEATURE. SPEC §5 rule 1 — "Hermes records every deployment
 * before the session starts" — exists so a prompt can never land in a
 * transcript before the registry can explain who sent it. Get that backwards
 * and the dispatch prompt classifies as Johan, which is scenario 4's poisoning
 * failure with Argus itself as the poisoner. So:
 *
 *   worktree → registry row (fsync) → spawn
 *
 * and every stage fails CLOSED into the one after it: no worktree means no
 * row, and no row means no process. A phantom row for a session that never
 * started would only teach the classifier to expect a dispatch that can never
 * land (`dispatch-expired`), so the row is written last of the two things that
 * can fail, and never speculatively.
 *
 * `src/deploy/routes.ts` documents the one place the promise is bounded by the
 * CLI rather than by Argus: codex names its own session, so its row follows
 * the CLI's announcement instead of preceding the process.
 */
import { join } from "node:path";

import {
  appendSessionRow,
  registryPaths,
  type SessionRow,
} from "../provenance";
import { createCmuxWorkerSpawn } from "./cmux-spawn.ts";
import { ROUTES, type AgentRoute, type DeployAgent } from "./routes.ts";
import {
  spawnWorker,
  subscriptionEnv,
  type WorkerProcess,
  type WorkerSpawn,
} from "./spawn.ts";
import { openWorkerTab } from "./tab.ts";
import { trustDirectory } from "./trust.ts";
import {
  branchForTicket,
  createWorktree,
  runGit,
  worktreeForTicket,
  type GitRun,
  type WorktreeResult,
} from "./worktree.ts";
import type { CmuxRun } from "../events";
import { snapshotMemory } from "../memory/snapshot";

export interface DeployRequest {
  agent: DeployAgent;
  /** Git ref the worktree branches from. Defaults to the repo's HEAD. */
  base?: string;
  branch?: string;
  /**
   * Where the session works (#62).
   *
   * `"worktree"` (the default, and everything #56 dispatches) creates a fresh
   * git worktree, because "parallel agents in one working tree race the index"
   * (§7.3.3). `"repo"` runs in the repo's own checkout, which is what SPEC
   * §7.2 asks for by name — "creates a cmux workspace in R" — and what a
   * PLANNING session needs: a grill produces a spec and tickets, and on an
   * unmerged worktree branch that output is stranded. A planning session does
   * not touch the index, so it does not need the isolation the rule buys.
   */
  checkout?: "repo" | "worktree";
  /** The full prompt that opens the session — the registry's copy of it. */
  dispatchPrompt: string;
  /**
   * Override the routed executable. Named because PATH is not trustworthy for
   * `claude` on this machine: several wrappers sit ahead of the native install
   * (#41), one of which #36 measured hanging without an assistant turn.
   */
  executable?: string;
  /** Extra argv for the routed CLI (permission modes, skills, sandboxes). */
  extraArgs?: readonly string[];
  model?: string;
  /** The repo the registry belongs to — never the worktree. */
  repo: string;
  /**
   * Optional, because §7.5 exempts planning and grilling sessions from "every
   * implemented thing is a ticket". Required in `"worktree"` mode, where the
   * branch and the worktree path are named after it.
   */
  ticket?: string;
  worktree?: string;
  /** `"auto"` tries cmux and degrades; `"none"` (default) never touches it. */
  workspace?: "auto" | "none";
  /**
   * A cmux workspace the CALLER already resolved (#62, amended by #95). The
   * grill flow needs the handle before the row, because it launches the
   * session by typing into that tab — so it cannot let this primitive open one
   * on its own. Set it and `workspace` is not consulted; the handle is
   * recorded in the row exactly as a self-opened one would be.
   */
  workspaceRef?: string;
  /**
   * The surface (tab) inside `workspaceRef`, when the caller opened it (#95).
   * Recorded so teardown has something to close: a workspace ref alone is not
   * enough, and `close-surface` without a resolved surface closes whatever
   * Johan is looking at.
   */
  surfaceRef?: string;
  /** Fresh cmux short ref used only to type into a newly opened terminal. */
  inputSurfaceRef?: string;
  /**
   * Override the route for this deployment (#62). The routes in
   * `./routes.ts` are the AFK, headless shapes; §7.2's grill is the same
   * agent and the same ordering with an interactive command line, and a route
   * override keeps that one difference in one place instead of forking the
   * primitive.
   */
  route?: AgentRoute;
}

export interface DeployWorkerOptions {
  cmux?: CmuxRun;
  env?: Readonly<Record<string, string | undefined>>;
  git?: GitRun;
  newSessionId?: () => string;
  now?: () => Date;
  spawn?: WorkerSpawn;
}

export interface Deployment {
  agent: DeployAgent;
  branch: string;
  dispatchPrompt: string;
  executable: string;
  /** Durable stdout/stderr/exit evidence for this exact launch. */
  logFile: string;
  process: WorkerProcess;
  sessionId: string;
  ticket?: string;
  /** The cmux workspace the worker's tab lives in, when it resolved (#95). */
  workspace?: string;
  /** The worker's own tab inside it. What teardown closes (#95). */
  surface?: string;
  /** Why there is no tab, when one was asked for and did not happen. */
  workspaceDegraded?: string;
  /**
   * Why the working directory could not be pre-trusted (#96). Best effort:
   * the session still starts, and half 2's silent-deployment check is what
   * notices if it lands on the trust dialog anyway.
   */
  trustDegraded?: string;
  worktree: string;
}

export type DeployStage = "worktree" | "registry" | "spawn" | "session-id";

export type DeployResult =
  | { status: "deployed"; deployment: Deployment }
  | { status: "failed"; reason: string; stage: DeployStage };

export async function deployWorker(
  request: DeployRequest,
  options: DeployWorkerOptions = {},
): Promise<DeployResult> {
  const route = request.route ?? ROUTES[request.agent];
  const git = options.git ?? runGit;

  // 1. The checkout. Parallel agents in one working tree race the index
  //    (§7.3.3), and a deployment with nowhere to work is not a deployment —
  //    so a worktree deployment that cannot get one never reaches the row.
  //    A `"repo"` deployment (§7.2's grill) works in the repo itself and asks
  //    git only which branch that is, so the row can still say.
  const worktree = await resolveCheckout(request, git);
  if (worktree.status === "failed") {
    return { reason: worktree.reason, stage: "worktree", status: "failed" };
  }

  // 2. The TAB (#95). Optional context (#7): it can only ever subtract
  //    information from the row, never stop the deployment. What changed in
  //    #95 is WHERE it goes — a surface in the workspace Argus is already
  //    running in, never a workspace of its own. A caller that already holds a
  //    resolved tab (the grill, §7.2) passes it in rather than opening a
  //    second one.
  const tab =
    request.workspaceRef === undefined && request.workspace === "auto"
      ? await openWorkerTab(
          { env: options.env ?? Bun.env, ...(request.ticket !== undefined && { title: `argus #${request.ticket}` }) },
          options.cmux,
        )
      : null;
  const workspaceRef =
    request.workspaceRef ?? (tab?.status === "opened" ? tab.workspace : undefined);
  const surfaceRef =
    request.surfaceRef ?? (tab?.status === "opened" ? tab.surface : undefined);
  const inputSurfaceRef =
    request.inputSurfaceRef ??
    (tab?.status === "opened" ? tab.inputSurface : request.surfaceRef);
  const spawn =
    options.spawn ??
    (workspaceRef !== undefined && surfaceRef !== undefined && inputSurfaceRef !== undefined
      ? createCmuxWorkerSpawn({
          ...(options.cmux !== undefined && { cmux: options.cmux }),
          inputSurface: inputSurfaceRef,
          surface: surfaceRef,
          workspace: workspaceRef,
        })
      : spawnWorker);

  // 2b. THE TRUST DIALOG (#96). Claude Code stops the FIRST session in any
  //     directory it has not seen on "Is this a project you created or one
  //     you trust?", with no transcript and nothing noticing. The config
  //     answers it before the process exists; see ./trust.ts for what was
  //     rejected and for why this does not go through the §5 rule 2 seam.
  //     Best effort: the directory may already be trusted by an ancestor
  //     entry, so a failure subtracts information from the row rather than
  //     stopping the deployment.
  const trust =
    route.agent === "claude"
      ? await trustDirectory(worktree.path, { env: options.env ?? Bun.env })
      : null;
  const trustDegraded =
    trust?.status === "failed" ? { trustDegraded: trust.reason } : {};

  const env = subscriptionEnv(options.env ?? Bun.env);
  const executablePath = env["PATH"];
  const configuredExecutable =
    route.agent === "codex" ? env["ARGUS_CODEX_EXECUTABLE"] : undefined;
  const executable =
    request.executable ??
    configuredExecutable ??
    Bun.which(
      route.executable,
      executablePath === undefined ? undefined : { PATH: executablePath },
    ) ??
    route.executable;
  const ts = (options.now?.() ?? new Date()).toISOString();
  const logFile = join(
    request.repo,
    ".argus",
    "workers",
    `${request.ticket ?? "adhoc"}-${crypto.randomUUID()}.log`,
  );
  const dispatchMemorySnapshot = await snapshotMemory(join(request.repo, ".argus/memory/MEMORY.md"));
  const row = (sessionId: string): SessionRow => ({
    agent: route.agent,
    dispatchPrompt: request.dispatchPrompt,
    executable,
    logFile,
    sessionId,
    ts,
    worktree: worktree.path,
    ...(request.ticket !== undefined && { ticket: request.ticket }),
    ...(workspaceRef !== undefined && { workspace: workspaceRef }),
    ...(surfaceRef !== undefined && { surface: surfaceRef }),
    dispatchMemorySnapshot,
  });
  const { sessionsFile } = registryPaths(request.repo);
  const degraded = tab?.status === "degraded" ? { workspaceDegraded: tab.reason } : {};

  const deployed = (sessionId: string, process: WorkerProcess): DeployResult => ({
    deployment: {
      agent: route.agent,
      branch: worktree.branch,
      dispatchPrompt: request.dispatchPrompt,
      executable,
      logFile,
      process,
      sessionId,
      worktree: worktree.path,
      ...(request.ticket !== undefined && { ticket: request.ticket }),
      ...(workspaceRef !== undefined && { workspace: workspaceRef }),
      ...(surfaceRef !== undefined && { surface: surfaceRef }),
      ...degraded,
      ...trustDegraded,
    },
    status: "deployed",
  });

  if (route.sessionIdMode === "preassigned") {
    const sessionId = (options.newSessionId ?? crypto.randomUUID.bind(crypto))();
    // 3. THE ROW, fsynced, BEFORE anything is started. Everything below this
    //    line can already be explained by the registry.
    try {
      await appendSessionRow(sessionsFile, row(sessionId));
    } catch (error) {
      return { reason: registryFailure(error), stage: "registry", status: "failed" };
    }
    // 4. The session.
    try {
      const process = await spawn(
        spawnRequest(route, request, worktree.path, env, executable, logFile, sessionId),
      );
      return deployed(sessionId, process);
    } catch (error) {
      return { reason: message(error), stage: "spawn", status: "failed" };
    }
  }

  // The announced route (codex). The CLI names the session, so the row cannot
  // precede the process — it precedes everything Argus does with the session,
  // and a session that never names itself is never registered and never left
  // running: an unattributable worker is worse than no worker.
  let process: WorkerProcess;
  try {
    process = await spawn(
      spawnRequest(route, request, worktree.path, env, executable, logFile),
    );
  } catch (error) {
    return { reason: message(error), stage: "spawn", status: "failed" };
  }
  const announced = await process.announcedSessionId();
  if (announced === null) {
    process.kill();
    return {
      reason: `${route.agent} exited without announcing a session id; nothing was registered`,
      stage: "session-id",
      status: "failed",
    };
  }
  try {
    await appendSessionRow(sessionsFile, row(announced));
  } catch (error) {
    process.kill();
    return { reason: registryFailure(error), stage: "registry", status: "failed" };
  }
  return deployed(announced, process);
}

/**
 * The checkout a deployment works in, and the one place the two modes differ.
 *
 * `"worktree"` is #55's original and unchanged behaviour. `"repo"` (#62) makes
 * no worktree at all and asks git for the current branch instead, so the row
 * still records WHERE the session works and on what — and so a directory that
 * is not a git repository fails at this stage, before any row exists, exactly
 * as a failed `git worktree add` does.
 */
async function resolveCheckout(
  request: DeployRequest,
  git: GitRun,
): Promise<WorktreeResult> {
  if (request.checkout === "repo") {
    const head = await git(["rev-parse", "--abbrev-ref", "HEAD"], request.repo);
    if (head.exitCode !== 0) {
      return {
        reason:
          head.stderr.trim() ||
          `git rev-parse exited ${head.exitCode} in ${request.repo}`,
        status: "failed",
      };
    }
    return {
      branch: head.stdout.trim() || "HEAD",
      path: request.repo,
      status: "created",
    };
  }
  if (request.ticket === undefined) {
    return {
      reason:
        "a worktree deployment needs a ticket: the branch and the worktree path " +
        'are named after it (pass checkout: "repo" for a ticketless planning session)',
      status: "failed",
    };
  }
  const branch = request.branch ?? branchForTicket(request.ticket);
  const path = request.worktree ?? worktreeForTicket(request.repo, request.ticket);
  return createWorktree(
    {
      branch,
      path,
      repo: request.repo,
      ...(request.base !== undefined && { base: request.base }),
    },
    git,
  );
}

function spawnRequest(
  route: AgentRoute,
  request: DeployRequest,
  cwd: string,
  env: Record<string, string>,
  executable: string,
  logFile: string,
  sessionId?: string,
): Parameters<WorkerSpawn>[0] {
  return {
    agent: route.agent,
    command: route.command({
      dispatchPrompt: request.dispatchPrompt,
      ...(request.extraArgs !== undefined && { extraArgs: request.extraArgs }),
      ...(request.model !== undefined && { model: request.model }),
      ...(sessionId !== undefined && { sessionId }),
    }),
    cwd,
    env,
    executable,
    logFile,
    ...(route.announce !== undefined && { announce: route.announce }),
  };
}

const registryFailure = (error: unknown): string =>
  `the deployment row could not be made durable, so no session was started: ${message(error)}`;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
