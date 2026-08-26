/**
 * Shared transcript-tailing library (ticket #21; SPEC §5): one normalized
 * event stream — message, session-meta, lifecycle — from pluggable sources.
 *
 * Zero runtime deps. Consumers (the five eyes) create a Tailer over a
 * TranscriptSource, persist cursors() after each processed batch, and hand
 * them back after a restart for lossless backfill. Tickets #22/#23 implement
 * further TranscriptSource instances against the seam in ./events.
 */
export {
  claudeProjectDir,
  createClaudeCodeSource,
  createClaudeCodeProjectsSource,
  type ClaudeCodeProjectsSourceOptions,
  type ClaudeCodeSourceOptions,
} from "./claude-code";
export {
  codexAutonomousBatchScenario,
  codexRogueSessionScenario,
  registerCodexScenarios,
} from "./codex-scenarios";
export { createCodexSource, type CodexSourceOptions } from "./codex";
export {
  hermesAutonomousBatchScenario,
  hermesPoisoningScenario,
  registerHermesScenarios,
} from "./hermes-scenarios";
export { createHermesSource, type HermesSourceOptions } from "./hermes";
export type {
  LifecycleEvent,
  MessageEvent,
  SessionMetaEvent,
  SourceParser,
  TailEvent,
  TranscriptSource,
} from "./events";
export { readNewLines, type ReadResult } from "./line-reader";
export {
  Tailer,
  type CursorMap,
  type TailerOptions,
  type WatchOptions,
} from "./tailer";
