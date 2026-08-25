/**
 * Provenance classifier (SPEC §5 provenance model): classifies every tailed
 * message against the registry through the send↔transcript matcher. This is
 * the ONE classification mechanism all five eyes consume — no heuristics
 * elsewhere. `ProvenanceRecord` is the seam for tickets #30–#33.
 */
import { derivedForms, hashText } from "../matching";
import type { MessageEvent, TailEvent } from "../tailing";
import type { SessionRecord } from "./registry";

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

/** Loud failure signals (§13 posture): registry problems are visible, never silent. */
export type ProvenanceAuditEvent = {
  type: "duplicate-session-registration";
  sessionId: string;
};

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
  johanTouched: boolean;
}

export class ProvenanceClassifier {
  private readonly sessions = new Map<string, SessionState>();

  private session(sessionId: string): SessionState {
    let state = this.sessions.get(sessionId);
    if (!state) {
      state = { registration: undefined, dispatchHashes: null, johanTouched: false };
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

  handle(event: TailEvent): ClassifyOutput {
    if (event.type !== "message") return { record: null, audits: [] };
    return { record: this.classifyMessage(event), audits: [] };
  }

  private classifyMessage(event: MessageEvent): ProvenanceRecord {
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
      return { ...base, author: "agent", via: "assistant" };
    }
    if (!event.candidate) {
      return { ...base, author: "system", via: "non-candidate" };
    }
    if (!registration) {
      return { ...base, author: "johan", via: "unregistered-session" };
    }
    const hash = hashText(event.text);
    if (state.dispatchHashes?.has(hash)) {
      state.dispatchHashes = null; // consumed: one deployment, one dispatch landing
      return { ...base, author: "hermes", via: "dispatch-prompt" };
    }
    state.johanTouched = true;
    return { ...base, author: "johan", via: "takeover", johanTouched: true };
  }
}
