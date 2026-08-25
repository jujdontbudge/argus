/**
 * Provenance classifier (SPEC §5 provenance model): classifies every tailed
 * message against the registry through the send↔transcript matcher. This is
 * the ONE classification mechanism all five eyes consume — no heuristics
 * elsewhere. `ProvenanceRecord` is the seam for tickets #30–#33.
 */
import { derivedForms, hashText, SendMatcher } from "../matching";
import type { LifecycleEvent, MessageEvent, TailEvent } from "../tailing";
import type { SendRecord, SessionRecord } from "./registry";

export type Author = "johan" | "hermes" | "agent" | "system";

export type Via =
  /** Candidate user message in a session the registry does not know (§5 rule 3a). */
  | "unregistered-session"
  /** The registered deployment's dispatch prompt landing (§5 rule 1). */
  | "dispatch-prompt"
  /** A sends.jsonl-logged Hermes follow-up, matched by the matcher (§5 rule 2). */
  | "registry-send"
  /** An unmatched user message in a registered session: Johan attached (§5 rule 3b). */
  | "takeover"
  /** Assistant-side output: the agent itself. */
  | "assistant"
  /** User-side transcript record that is not a real prompt (tool output, meta). */
  | "non-candidate";

/**
 * Per-message provenance, the seam the eyes (#30–#33) consume. `author` and
 * `via` say who wrote the message and through which §5 rule; the session
 * fields carry the state the Digest's frontmatter needs at that moment.
 */
export interface ProvenanceRecord {
  sessionId: string;
  author: Author;
  via: Via;
  /** True when the session is a registered deployment (sessions.jsonl). */
  registered: boolean;
  startedBy: "johan" | "hermes";
  /** True once Johan has attached and typed into this session (sticky). */
  johanTouched: boolean;
  /** Deployment metadata, when registered. */
  agent?: string;
  ticket?: string;
  /** Message timestamp/text, hoisted from the event for convenience. */
  ts: string;
  text: string;
  /** The full tailed event this record classifies. */
  event: MessageEvent;
}

/** Loud failure signals (§13 posture): provenance oddities are visible, never silent. */
export type ProvenanceAuditEvent =
  | { type: "duplicate-session-registration"; sessionId: string }
  /** Johan attached to a registered session (first takeover message). */
  | { type: "johan-attached"; sessionId: string; ts: string; text: string; uuid?: string }
  /**
   * A hash-miss equal to one line of a pending multi-line send — the signature
   * of a newline-encoding bug in Hermes' adapter. Classification stays Johan.
   */
  | { type: "encoding-bug-suspect"; sessionId: string; sendId?: string; ts: string; text: string }
  /** sends.jsonl names a session sessions.jsonl never registered. */
  | { type: "send-into-unregistered-session"; sessionId: string; sendId?: string };

export interface ClassifyOutput {
  /** Null for events that carry no message (session-meta, lifecycle). */
  record: ProvenanceRecord | null;
  audits: ProvenanceAuditEvent[];
}

interface SessionState {
  registration: SessionRecord | undefined;
  /**
   * Unconsumed dispatch-prompt landing hashes. Deliberately NOT time-windowed:
   * the dispatch prompt must never classify as Johan (scenario 4), whatever
   * the clock skew between the registry row and the transcript.
   */
  dispatchHashes: Set<string> | null;
  /** Registry-logged follow-up sends, matched under the §24 clock windows. */
  matcher: SendMatcher;
  johanTouched: boolean;
  /** The send-into-unregistered-session audit fires once per session. */
  unregisteredSendAudited: boolean;
}

export class ProvenanceClassifier {
  private readonly sessions = new Map<string, SessionState>();

  private session(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = {
        registration: undefined,
        dispatchHashes: null,
        matcher: new SendMatcher(),
        johanTouched: false,
        unregisteredSendAudited: false,
      };
      this.sessions.set(sessionId, state);
    }
    return state;
  }

  /** Feed one sessions.jsonl record (§5 rule 1). */
  registerSession(record: SessionRecord): ProvenanceAuditEvent[] {
    const state = this.session(record.sessionId);
    if (state.registration) {
      return [{ type: "duplicate-session-registration", sessionId: record.sessionId }];
    }
    state.registration = record;
    state.dispatchHashes = new Set(derivedForms(record.dispatchPrompt).map(hashText));
    return [];
  }

  /** Feed one sends.jsonl record (§5 rule 2). */
  recordSend(record: SendRecord): ProvenanceAuditEvent[] {
    const state = this.session(record.sessionId);
    const audits: ProvenanceAuditEvent[] = [];
    if (!state.registration && !state.unregisteredSendAudited) {
      state.unregisteredSendAudited = true;
      audits.push({
        type: "send-into-unregistered-session",
        sessionId: record.sessionId,
        ...(record.id !== undefined && { sendId: record.id }),
      });
    }
    state.matcher.addSend({
      ts: record.ts,
      text: record.text,
      ...(record.kind !== undefined && { kind: record.kind }),
      ...(record.id !== undefined && { id: record.id }),
    });
    return audits;
  }

  handle(event: TailEvent): ClassifyOutput {
    if (event.type === "lifecycle") {
      this.handleLifecycle(event);
      return { record: null, audits: [] };
    }
    if (event.type !== "message") return { record: null, audits: [] };
    return this.classifyMessage(event);
  }

  private handleLifecycle(event: LifecycleEvent): void {
    if (
      event.kind !== "queue-enqueue" ||
      event.sessionId === undefined ||
      event.content === undefined ||
      event.ts === undefined
    ) {
      return;
    }
    this.session(event.sessionId).matcher.onEnqueue({
      content: event.content,
      ts: event.ts,
    });
  }

  private classifyMessage(event: MessageEvent): ClassifyOutput {
    const state = this.session(event.sessionId);
    const registration = state.registration;
    const base = {
      sessionId: event.sessionId,
      registered: registration !== undefined,
      startedBy: registration ? ("hermes" as const) : ("johan" as const),
      johanTouched: state.johanTouched,
      ...(registration?.agent !== undefined && { agent: registration.agent }),
      ...(registration?.ticket !== undefined && { ticket: registration.ticket }),
      ts: event.ts,
      text: event.text,
      event,
    };
    if (event.role === "assistant") {
      return { record: { ...base, author: "agent", via: "assistant" }, audits: [] };
    }
    if (!event.candidate) {
      return { record: { ...base, author: "system", via: "non-candidate" }, audits: [] };
    }
    const hash = hashText(event.text);
    if (state.dispatchHashes?.has(hash)) {
      state.dispatchHashes = null; // consumed: one deployment, one dispatch landing
      return {
        record: { ...base, author: "hermes", via: "dispatch-prompt" },
        audits: [],
      };
    }
    // Registry-logged sends are provenance truth even when the session record
    // is missing (audited at recordSend) — a matched landing is never Johan.
    const match = state.matcher.classify({ text: event.text, ts: event.ts });
    if (match.author === "hermes") {
      return { record: { ...base, author: "hermes", via: "registry-send" }, audits: [] };
    }
    const audits: ProvenanceAuditEvent[] = [];
    if (match.encodingBugSuspect) {
      const sendId = match.encodingBugSuspect.id;
      audits.push({
        type: "encoding-bug-suspect",
        sessionId: event.sessionId,
        ...(sendId !== undefined && { sendId }),
        ts: event.ts,
        text: event.text,
      });
    }
    if (!registration) {
      return {
        record: { ...base, author: "johan", via: "unregistered-session" },
        audits,
      };
    }
    if (!state.johanTouched) {
      state.johanTouched = true;
      audits.push({
        type: "johan-attached",
        sessionId: event.sessionId,
        ts: event.ts,
        text: event.text,
        ...(event.uuid !== undefined && { uuid: event.uuid }),
      });
    }
    return {
      record: { ...base, author: "johan", via: "takeover", johanTouched: true },
      audits,
    };
  }
}
