/**
 * Shared eye plumbing (ticket #30; SPEC §5): the pieces every eye (#31–#33)
 * composes — config knobs, coalesced cadence, the codex brain seam, the
 * machine-wide brain cap, and never-drop backpressure — plus the Reviewer
 * eye under ./reviewer, the Digest eye (#31) under ./digest and the Retro eye
 * (#33) under ./retro.
 */
export {
  ArchiverEye,
  archiveAutonomousBatchScenario,
  archiverWatcherDeathScenario,
  registerArchiverScenarios,
  type ArchiveBatchResult,
  type ArchiverEyeOptions,
} from "./archiver";
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
export { chainRootOf } from "./digest/chain";
export {
  DigestEye,
  openDigest,
  type DigestEyeOptions,
  type OpenDigestOverrides,
  type SessionLifecycleEvent,
} from "./digest/digest";
export {
  HonchoEye,
  honchoSemanticIsolationScenario,
  honchoTakeoverScenario,
  loadHonchoBinding,
  registerHonchoScenarios,
  type HonchoEyeOptions,
} from "./honcho";
export {
  applyDigestUpdate,
  digestFileName,
  listDigests,
  readDigest,
  updateIndex,
  type StoredDigest,
  type DigestFrontmatter,
  type DigestPatch,
  type DigestSeed,
  type IndexEntry,
} from "./digest/outputs";
export {
  DIGEST_OUTPUT_SCHEMA,
  parseDigestVerdict,
  type BrainStatus,
  type DigestStatus,
  type DigestVerdict,
  type SessionDigest,
} from "./digest/schema";
export {
  digestAutonomousBatchScenario,
  digestTakeoverScenario,
  registerDigestScenarios,
  signalPathsScenario,
} from "./digest/scenarios";
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
export {
  attributeChanges,
  referencedTickets,
  type Attribution,
  type AttributedChanges,
  type AttributionContext,
  type Coverage,
  type RogueChanges,
} from "./retro/attribution";
export {
  composeRetro,
  MAX_BODY_BYTES,
  type ComposeRetroInput,
  type RetroComposition,
  type RetroPrompt,
} from "./retro/compose";
export { createFakeGh, type FakeGh, type FakeGhIssue } from "./retro/fake-gh";
export { fixtureRetroBrain } from "./retro/fixture-brain";
export {
  resolvePath,
  scanGit,
  type GitCommit,
  type GitRunner,
  type GitScan,
  type RootScan,
  type WorkingTreeChange,
} from "./retro/git";
export {
  detectTracker,
  type FiledRetro,
  type GhRunner,
  type RetroIssueRequest,
  type Tracker,
  type TrackerIssue,
} from "./retro/gh";
export {
  resolveParent,
  type ParentInput,
  type ParentResolution,
  type ParentRule,
} from "./retro/parent";
export {
  describeAudit,
  openRetro,
  RetroEye,
  type OpenRetroOverrides,
  type RetroAudit,
  type RetroEyeOptions,
  type RetroFiling,
  type SessionObservation,
} from "./retro/retro";
export {
  createFixtureRogueDriver,
  registerRetroScenarios,
  rogueSessionScenario,
  type RogueSessionDriver,
  type RogueSessionHandle,
} from "./retro/scenarios";
export {
  parseRetroVerdict,
  RETRO_OUTPUT_SCHEMA,
  type RetroJudgment,
  type RetroVerdict,
} from "./retro/schema";
export {
  buildSignals,
  type BuildSignalsInput,
  type RetroSignal,
  type RetroSignalSession,
  type SignalSource,
} from "./retro/signal";
