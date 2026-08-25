/**
 * The normalized transcript event stream (SPEC §5: three source formats, one
 * event stream) and the pluggable-source seam that tickets #22/#23 implement.
 *
 * Message/lifecycle parsing is a pure function of transcript bytes. Source
 * metadata may additionally capture tail-time filesystem facts (Codex repo
 * attribution), which must be persisted before disposable worktrees vanish.
 */

import type { ReadResult } from "./line-reader";

/** A user- or assistant-authored message as recorded in a transcript. */
export interface MessageEvent {
  type: "message";
  sessionId: string;
  role: "user" | "assistant";
  /** Message text exactly as recorded (no normalization — matching does that). */
  text: string;
  /** Transcript timestamp, ISO-8601 as recorded. */
  ts: string;
  /** Record uuid when the format provides one. */
  uuid?: string;
  /** Claude Code prompt source ("typed" | "queued") when present. */
  promptSource?: string;
  /**
   * True when this record is eligible for provenance classification per the
   * matching library's candidate rules (research §2.1–§2.3). Non-candidates
   * (bash-stdout, meta records) still flow to passive consumers.
   */
  candidate: boolean;
  /** Absolute path of the transcript file this event came from. */
  file: string;
}

/** Session identity/context, emitted on first sight of a session in a file. */
export interface SessionMetaEvent {
  type: "session-meta";
  sessionId: string;
  /** Source id, e.g. "claude-code". */
  agent: string;
  cwd?: string;
  /** Canonical repository identity resolved from cwd while the path is live. */
  repo?: string;
  /** Parent thread for a Codex subagent/fork, when the rollout provides one. */
  parentSessionId?: string;
  /** Best-effort session-start branch from Codex's git snapshot. */
  gitBranch?: string;
  version?: string;
  ts?: string;
  file: string;
}

/** Non-message happenings a consumer may need (queue bridge, rotation, errors). */
export interface LifecycleEvent {
  type: "lifecycle";
  kind: "queue-enqueue" | "queue-dequeue" | "file-truncated" | "parse-error";
  sessionId?: string;
  ts?: string;
  /** Enqueue content (the matcher's timestamp bridge) or the offending raw line. */
  content?: string;
  file: string;
}

export type TailEvent = MessageEvent | SessionMetaEvent | LifecycleEvent;

/** Per-file stateful parser; transcript state derives from lines fed in order. */
export interface SourceParser {
  /** Parse one raw transcript line into zero or more events. */
  parseLine(line: string): TailEvent[];
}

/** The pluggable source seam (#22 Codex, #23 cmux/Hermes implement this). */
export interface TranscriptSource {
  /** Stable source id, stamped into session-meta events as `agent`. */
  readonly id: string;
  /** Directories to watch for file creation/appends. */
  watchPaths(): string[];
  /** Current transcript files to tail (absolute paths). */
  listFiles(): Promise<string[]>;
  /** Stable logical identity when a rollout can move or change suffix. */
  fileKey?(file: string): string;
  /** Source-specific reader for compressed or otherwise non-plain files. */
  readNewLines?(file: string, offset: number): Promise<ReadResult>;
  /** A fresh parser for one file; the tailer feeds it complete lines in order. */
  createParser(file: string): SourceParser;
}
