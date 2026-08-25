/**
 * Shared eye plumbing (ticket #30; SPEC §5): the pieces every eye (#31–#33)
 * composes — config knobs, coalesced cadence, the codex brain seam, the
 * machine-wide brain cap, and never-drop backpressure — plus the Reviewer
 * eye itself under ./reviewer.
 */
export {
  fileAlertEmitter,
  retryForever,
  type RetryForeverOptions,
  type StuckAlert,
} from "./backpressure";
export {
  createCodexBrain,
  parseCodexOutput,
  type Brain,
  type BrainOutcome,
  type BrainRequest,
  type BrainUsage,
  type CodexBrainOptions,
  type SpawnFn,
  type SpawnRequest,
  type SpawnResult,
} from "./brain";
export {
  createBrainCap,
  defaultBrainSlotsDirectory,
  type BrainCap,
  type BrainCapOptions,
  type ReleaseSlot,
} from "./cap";
export { Coalescer, type CoalesceWindow } from "./coalesce";
export {
  DEFAULT_EYES_CONFIG,
  loadEyesConfig,
  type BrainConfig,
  type CadenceConfig,
  type EyesConfig,
} from "./config";
export {
  applyFindings,
  foldHermesEntries,
  repairMemoryIndex,
  type ApplyContext,
  type ApplyResult,
  type Rejection,
  type RejectionReason,
} from "./reviewer/outputs";
export {
  openReviewer,
  ReviewerEye,
  type OpenReviewerOverrides,
  type ReviewerEyeOptions,
} from "./reviewer/reviewer";
export {
  normalizeSlug,
  parseVerdict,
  REVIEWER_OUTPUT_SCHEMA,
  type Finding,
  type FindingKind,
  type Verdict,
} from "./reviewer/schema";
export {
  autonomousBatchScenario,
  registerReviewerScenarios,
  reviewerTakeoverScenario,
  selfLearningScenario,
} from "./reviewer/scenarios";
