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
import {
  appendSessionRow,
  registryPaths,
  type SessionRow,
} from "../provenance";
import { ROUTES, type AgentRoute, type DeployAgent } from "./routes.ts";
import {
  spawnWorker,
  subscriptionEnv,
  type WorkerProcess,
  type WorkerSpawn,
} from "./spawn.ts";
import { createCmuxWorkspace } from "./workspace.ts";
import {
  branchForTicket,
  createWorktree,
  runGit,
  worktreeForTicket,
  type GitRun,
} from "./worktree.ts";
import type { CmuxRun } from "../events";

export interface DeployRequest {
  agent: DeployAgent;
  /** Git ref the worktree branches from. Defaults to the repo's HEAD. */
  base?: string;
  branch?: string;
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
  ticket: string;
  worktree?: string;
  /** `"auto"` tries cmux and degrades; `"none"` (default) never touches it. */
  workspace?: "auto" | "none";
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
  process: WorkerProcess;
  sessionId: string;
  ticket: string;
  /** The cmux workspace ref, when one was created AND resolved. */
  workspace?: string;
  /** Why there is no workspace, when one was asked for and did not happen. */
  workspaceDegraded?: string;
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
  const route = ROUTES[request.agent];
  const git = options.git ?? runGit;
  const spawn = options.spawn ?? spawnWorker;
  const branch = request.branch ?? branchForTicket(request.ticket);
  const path = request.worktree ?? worktreeForTicket(request.repo, request.ticket);

  // 1. The worktree. Parallel agents in one working tree race the index
  //    (§7.3.3), and a deployment with nowhere to work is not a deployment.
  const worktree = await createWorktree(
    { branch, path, repo: request.repo, ...(request.base !== undefined && { base: request.base }) },
    git,
  );
  if (worktree.status === "failed") {
    return { reason: worktree.reason, stage: "worktree", status: "failed" };
  }

  // 2. The workspace, if asked for. Optional context (#7): it can only ever
  //    subtract information from the row, never stop the deployment.
  const workspace =
    request.workspace === "auto"
      ? await createCmuxWorkspace({ cwd: worktree.path }, options.cmux)
      : null;
  const workspaceRef =
    workspace?.status === "created" ? workspace.workspace : undefined;

  const env = subscriptionEnv(options.env ?? Bun.env);
  const ts = (options.now?.() ?? new Date()).toISOString();
  const row = (sessionId: string): SessionRow => ({
    agent: route.agent,
    dispatchPrompt: request.dispatchPrompt,
    sessionId,
    ticket: request.ticket,
    ts,
    worktree: worktree.path,
    ...(workspaceRef !== undefined && { workspace: workspaceRef }),
  });
  const { sessionsFile } = registryPaths(request.repo);
  const degraded =
    workspace?.status === "degraded" ? { workspaceDegraded: workspace.reason } : {};

  const deployed = (sessionId: string, process: WorkerProcess): DeployResult => ({
    deployment: {
      agent: route.agent,
      branch: worktree.branch,
      dispatchPrompt: request.dispatchPrompt,
      process,
      sessionId,
      ticket: request.ticket,
      worktree: worktree.path,
      ...(workspaceRef !== undefined && { workspace: workspaceRef }),
      ...degraded,
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
      const process = await spawn(spawnRequest(route, request, worktree.path, env, sessionId));
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
    process = await spawn(spawnRequest(route, request, worktree.path, env));
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

function spawnRequest(
  route: AgentRoute,
  request: DeployRequest,
  cwd: string,
  env: Record<string, string>,
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
    executable: request.executable ?? route.executable,
    ...(route.announce !== undefined && { announce: route.announce }),
  };
}

const registryFailure = (error: unknown): string =>
  `the deployment row could not be made durable, so no session was started: ${message(error)}`;

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
