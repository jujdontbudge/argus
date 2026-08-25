/**
 * Session-id rotation (ticket #31 edge case): when Hermes compresses a
 * session's context it redeploys under a NEW session id and records the link
 * in the sessions.jsonl row (`continues: <previous-id>`). A whole compression
 * chain is ONE logical session, so the digest follows the links to the chain
 * root and every rotated id appends to the root's single digest file.
 */
import type { SessionRecord } from "../../provenance";

/**
 * Resolve a session id to its chain root by walking `continues` links.
 * A link to an id the registry never saw still names the root — the chain
 * claim is Hermes' to make. A malformed cycle terminates at the first
 * revisit; it can never spin.
 */
export function chainRootOf(
  sessions: readonly SessionRecord[],
  sessionId: string,
): string {
  const continuesOf = new Map<string, string>();
  for (const record of sessions) {
    if (record.continues !== undefined) {
      continuesOf.set(record.sessionId, record.continues);
    }
  }
  const visited = new Set<string>();
  let current = sessionId;
  for (;;) {
    visited.add(current);
    const previous = continuesOf.get(current);
    if (previous === undefined || visited.has(previous)) return current;
    current = previous;
  }
}
