import { deriveKind, derivedForms, type SendKind } from "./derived-forms";
import { hashText } from "./hash";

/** Epoch milliseconds, or an ISO-8601 string as found in sends.jsonl / transcripts. */
export type Timestamp = number | string;

export function toEpochMs(ts: Timestamp): number {
  if (typeof ts === "number") return ts;
  const ms = Date.parse(ts);
  if (Number.isNaN(ms)) throw new Error(`unparseable timestamp: ${JSON.stringify(ts)}`);
  return ms;
}

/** One sends.jsonl entry, as logged by Hermes before the send (findings §5). */
export interface SendInput {
  ts: Timestamp;
  text: string;
  /** Defaults to deriveKind(text); Hermes' logged kind wins when present. */
  kind?: SendKind;
  /** Opaque correlation id for audit events (e.g. sends.jsonl line number). */
  id?: string;
}

export interface PendingSend {
  readonly id: string | undefined;
  readonly ts: number;
  readonly text: string;
  readonly kind: SendKind;
  /** Normalized transcript forms this send may land as, with their hashes. */
  readonly forms: readonly string[];
  readonly hashes: readonly string[];
}

/** A candidate user-side transcript message (already filtered per §2.1/§2.2). */
export interface UserMessage {
  text: string;
  ts: Timestamp;
}

export type MatchResult =
  | { author: "hermes"; send: PendingSend; matchedForm: string }
  | { author: "johan" };

/** Window bounds (findings §3): −5s scheduler-jitter guard, +3600s covers queued landings. */
export const WINDOW_BEFORE_MS = 5_000;
export const WINDOW_AFTER_MS = 3_600_000;

/**
 * Per-session send↔transcript matcher (research/send-transcript-matching.md §7).
 * Pure state machine: callers feed registry sends and candidate transcript
 * messages; nothing here touches the clock, filesystem, or any session.
 */
export class SendMatcher {
  private pending: PendingSend[] = [];

  addSend(input: SendInput): void {
    const kind = input.kind ?? deriveKind(input.text);
    const forms = derivedForms(input.text, kind);
    this.pending.push({
      id: input.id,
      ts: toEpochMs(input.ts),
      text: input.text,
      kind,
      forms,
      hashes: forms.map(hashText),
    });
  }

  classify(msg: UserMessage): MatchResult {
    const h = hashText(msg.text);
    const t = toEpochMs(msg.ts);
    for (let i = 0; i < this.pending.length; i++) {
      const send = this.pending[i]!;
      if (t < send.ts - WINDOW_BEFORE_MS || t > send.ts + WINDOW_AFTER_MS) continue;
      const formIndex = send.hashes.indexOf(h);
      if (formIndex === -1) continue;
      this.pending.splice(i, 1); // consume: one send, at most one message
      return { author: "hermes", send, matchedForm: send.forms[formIndex]! };
    }
    return { author: "johan" };
  }
}
