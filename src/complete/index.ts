/**
 * Completion (ticket #57; SPEC §7.3.4): verify, merge, close, update the map.
 *
 * The last step of the pipeline, and the one that makes the batch autonomous.
 * It composes on #55's deployment primitive (the worktree and the registry
 * row), #56's dispatcher (the claim, the slot, and the dead/finished line) and
 * #58's consumer (the completion signals) — none of which it reimplements.
 *
 * What it adds is the ability to REFUSE: gates that run in the ticket's own
 * worktree, a review that can block, and a durable queue so a refusal comes
 * back next pass instead of vanishing with the signal that raised it.
 */
export {
  completeReadyTickets,
  type CompleteOptions,
  type CompletionOutcome,
  type CompletionReport,
  type CompletionStatus,
} from "./complete.ts";
export {
  resolveRepositoryGates,
  runGateCommand,
  runGates,
  type Gate,
  type GateResolution,
  type GateReport,
  type GateResult,
  type GateRunner,
} from "./gates.ts";
export {
  MAP_LABEL,
  decisionLine,
  updateWayfinderMap,
  withDecision,
  type MapResult,
  type MapUpdate,
} from "./map.ts";
export {
  checkoutRefusal,
  currentBranch,
  mergeTicketBranch,
  readBranchWork,
  retireWorktree,
  type BranchWork,
  type MergeResult,
} from "./merge.ts";
export {
  dequeueVerification,
  enqueueVerification,
  listVerifications,
  readVerification,
  recordVerificationFailure,
  verifyQueueDirectory,
  type VerificationSource,
  type VerifyEntry,
} from "./queue.ts";
export {
  parseDeclaredVerification,
  readVerificationDeclaration,
  recordVerificationDeclaration,
  type DeclaredVerification,
  type DeclaredVerificationParse,
  type InvalidDeclaredVerification,
  type VerificationDeclaration,
} from "./verification.ts";
export {
  createBrainReviewer,
  reviewPrompt,
  type ReviewInput,
  type ReviewStatus,
  type ReviewVerdict,
  type Reviewer,
} from "./review.ts";
