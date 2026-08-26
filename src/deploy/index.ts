/**
 * Deployment (ticket #55; SPEC §7.3.2): the ONE primitive that puts work on a
 * worktree, records it in the registry first, and dispatches it to a routed
 * agent — plus the registry-first follow-up send that keeps §5 rule 2 true for
 * real worker traffic and not only for mission-control event sends.
 *
 * Seams left open on purpose: the GitHub frontier read, the claim, and the
 * concurrency cap belong to #56; verify/merge/close belongs to #57. Both
 * compose on `deployWorker` + `sendToWorker` without changing them.
 */
export {
  deployWorker,
  type Deployment,
  type DeployRequest,
  type DeployResult,
  type DeployStage,
  type DeployWorkerOptions,
} from "./deploy.ts";
export {
  sendToWorker,
  type WorkerSendOptions,
  type WorkerSendRequest,
  type WorkerSendResult,
} from "./send.ts";
export {
  CLAUDE_ROUTE,
  CODEX_ROUTE,
  ROUTES,
  type AgentRoute,
  type DeployAgent,
  type RouteCommandInput,
  type SessionIdMode,
} from "./routes.ts";
export {
  spawnWorker,
  STRIPPED_ENV,
  subscriptionEnv,
  type WorkerExit,
  type WorkerProcess,
  type WorkerSpawn,
  type WorkerSpawnRequest,
} from "./spawn.ts";
export {
  createCmuxWorkspace,
  type WorkspaceRequest,
  type WorkspaceResult,
} from "./workspace.ts";
export {
  branchForTicket,
  createWorktree,
  runGit,
  worktreeForTicket,
  type GitRun,
  type GitRunResult,
  type WorktreeRequest,
  type WorktreeResult,
} from "./worktree.ts";
