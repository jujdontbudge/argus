/**
 * Send↔transcript matcher (ticket #24; research/send-transcript-matching.md).
 *
 * Pure library, zero runtime deps: classifies user-side transcript messages
 * as Hermes- or Johan-authored against the registry send log. Callers create
 * one SendMatcher per session, feed sends.jsonl entries (addSend), Claude
 * queue-operation enqueue records (onEnqueue), and candidate user messages
 * (classify), and periodically sweepExpired with the current time.
 */
export {
  claudeCandidateText,
  codexCandidateText,
  isCodexSubagentThread,
  syntheticEnvelopeTag,
} from "./candidates";
export { deriveKind, derivedForms, type SendKind } from "./derived-forms";
export { hashText, sha256Hex } from "./hash";
export {
  ENQUEUE_BRIDGE_AFTER_MS,
  SendMatcher,
  toEpochMs,
  WINDOW_AFTER_MS,
  WINDOW_BEFORE_MS,
  type AuditEvent,
  type EnqueueEvent,
  type MatchResult,
  type PendingSend,
  type SendInput,
  type Timestamp,
  type UserMessage,
} from "./matcher";
export { normalize } from "./normalize";
