/**
 * Dispatch (ticket #56; SPEC §7.3): the GitHub frontier reader, the claim, the
 * concurrency cap, and recovery when a claimed ticket's session dies.
 *
 * It composes on the #55 deployment primitive rather than duplicating it —
 * `deployWorker` still owns worktree → registry row (fsync) → spawn, and this
 * layer only decides WHICH ticket gets one and HOW MANY may exist at once.
 *
 * The seam left open on purpose is #57's: nothing here verifies, merges or
 * closes anything. Recovery deliberately stops at "this dead session left
 * commits behind" and hands that ticket on rather than deciding its fate.
 */
export {
  buildDispatchPrompt,
  defaultDispatchPrompt,
  dispatchFrontier,
  readDispatchContext,
  readDispatchTicket,
  type DispatchOptions,
  type DispatchComment,
  type DispatchPromptContext,
  type DispatchRelatedTicket,
  type DispatchReport,
  type DispatchedTicket,
  type SkippedTicket,
} from "./dispatch.ts";
export {
  claimingLogin,
  claimTicket,
  releaseClaim,
  type ClaimRequest,
  type ClaimResult,
} from "./claim.ts";
export {
  readFrontier,
  type ExcludedTicket,
  type ExclusionReason,
  type FrontierRequest,
  type FrontierResult,
  type FrontierTicket,
} from "./frontier.ts";
export {
  recoverDeadSlots,
  type RecoveredSlot,
  type RecoveryOutcome,
  type RecoveryReport,
} from "./recover.ts";
export {
  createDispatchSlots,
  dispatchSlotsDirectory,
  processIsAlive,
  type DispatchSlots,
  type HeldSlot,
  type SlotEntry,
  type SlotRecord,
} from "./slots.ts";
