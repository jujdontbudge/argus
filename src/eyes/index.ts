/**
 * Shared eye plumbing (ticket #30; SPEC §5): the pieces every eye (#31–#33)
 * composes — config knobs, coalesced cadence, the codex brain seam, the
 * machine-wide brain cap, and never-drop backpressure — plus the Reviewer
 * eye under ./reviewer, the Digest eye (#31) under ./digest, the Retro eye
 * (#33) under ./retro and the weekly curator pass (#35) under ./curator,
 * which rides the Reviewer's loop rather than running as a sixth watcher.
 */
export {
  ArchiverEye,
  openArchiver,
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
  type CuratorConfig,
  type EyesConfig,
} from "./config";
export {
  archiveFact,
  archiveSkill,
  ARCHIVE_DIR,
  memoryArchiveDir,
  restoreSkill,
  skillsArchiveDir,
  type ArchivedSkill,
  type ArchiveSkillOptions,
} from "./curator/archive";
export {
  backupGitDir,
  restoreSnapshot,
  snapshotArgusState,
  type SnapshotResult,
} from "./curator/backup";
export {
  maybeRunCurator,
  runCuratorPass,
  type CuratorPassOptions,
  type CuratorPassResult,
  type CuratorTriggerResult,
} from "./curator/curator";
export {
  buildCuratorPrompt,
  DRY_RUN_BANNER,
  type CuratorPromptInput,
} from "./curator/prompt";
export {
  emptyReport,
  renderReport,
  reportDirectory,
  writeReport,
  type CuratorRunReport,
} from "./curator/report";
export {
  EXCLUDED_SKILL_DIRS,
  scanMemory,
  scanSkills,
  type FactCandidate,
  type MemoryOrphan,
  type MemoryScan,
  type SkillCandidate,
} from "./curator/scan";
export {
  curatorHalfScenario,
  curatorSelfLearningScenario,
  registerCuratorScenarios,
} from "./curator/scenarios";
export {
  CURATOR_OUTPUT_SCHEMA,
  parseCuratorVerdict,
  type Consolidation,
  type CuratorVerdict,
  type Pruning,
} from "./curator/schema";
export {
  curatorStatePath,
  readCuratorState,
  recordRun,
  shouldRunNow,
  type CuratorState,
  type GateDecision,
  type GateReason,
} from "./curator/state";
export {
  applyAutomaticTransitions,
  DEFAULT_THRESHOLDS,
  type Transition,
  type TransitionKind,
  type TransitionResult,
  type TransitionThresholds,
} from "./curator/transitions";
export {
  emptyRecord,
  latestActivityAt,
  readUsage,
  recordSkillWrites,
  updateUsage,
  usagePath,
  writeUsage,
  type UsageAuthor,
  type UsageRecord,
  type UsageSidecar,
  type UsageState,
} from "./curator/usage";
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
  openHoncho,
  registerHonchoScenarios,
  type HonchoEyeOptions,
  type OpenHonchoOverrides,
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
  memoryIndexTarget,
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
