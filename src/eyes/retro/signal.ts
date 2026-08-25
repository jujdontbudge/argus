/**
 * Retro signals (SPEC §5.5): the two detections folded into ONE unit of work
 * per retro ticket.
 *
 * - **git signal** — changes attribution found no registered ticket session
 *   for.
 * - **transcript signal** — a session digest whose frontmatter carries no
 *   ticket. Whether that session actually IMPLEMENTED anything is the brain's
 *   call; this only decides that no ticket covers it.
 *
 * The two merge whenever they describe the same session (named in the rogue
 * checkout, or observed running there), so a rogue session that both wrote
 * code and left a digest files one retro, not two. Ids are content-derived,
 * so the same unreported work always resolves to the same signal — that is
 * what makes "file exactly once" possible across eye restarts.
 */
import { hashText } from "../../matching";
import type { StoredDigest } from "../digest/outputs";
import type { SessionRecord } from "../../provenance";
import type { Attribution, RogueChanges } from "./attribution";

export type SignalSource = "git" | "transcript";

export interface RetroSignalSession {
  sessionId: string;
  agent?: string;
  /** The digest file the transcript evidence came from. */
  digestFile?: string;
  /** The digest narrative — what the session says it did. */
  narrative?: string;
  johanTouched?: boolean;
}

export interface RetroSignal {
  /** Content-derived: identical unreported work always yields this id. */
  id: string;
  sources: SignalSource[];
  /** The checkout the work happened in, when git saw it. */
  dir: string | null;
  changes: RogueChanges | null;
  sessions: RetroSignalSession[];
  /** Ticket numbers the rogue work names (parent rule 2). */
  referencedTickets: string[];
  /** Tickets whose worktree this work sits in (parent rule 1). */
  sessionTickets: string[];
}

export interface BuildSignalsInput {
  attribution: Attribution;
  /** Every session digest under `.argus/sessions/`. */
  digests: readonly StoredDigest[];
  /** sessionId → observed cwd, from session-meta events. */
  sessionDirs?: ReadonlyMap<string, string>;
  /** Registry deployments: a registered ticket also covers its digest. */
  sessions?: readonly SessionRecord[];
}

function normalizePath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.length === 0 ? "/" : trimmed;
}

/** Short, stable, collision-resistant enough to key "already filed". */
function signalId(parts: readonly string[]): string {
  return `retro-${hashText(parts.join("")).slice(0, 16)}`;
}

function fingerprintOf(changes: RogueChanges | null, sessionIds: string[]): string[] {
  if (changes === null) return sessionIds;
  return [
    normalizePath(changes.dir),
    ...changes.commits.map((commit) => commit.sha),
    ...(changes.workingTree
      ? ["working-tree", ...changes.workingTree.files, changes.workingTree.diff]
      : []),
    ...sessionIds,
  ];
}

function sessionOf(digest: StoredDigest): RetroSignalSession {
  return {
    sessionId: digest.sessionId,
    ...(digest.frontmatter.agent !== undefined && { agent: digest.frontmatter.agent }),
    digestFile: digest.fileName,
    narrative: digest.body,
    johanTouched: digest.frontmatter.johanTouched,
  };
}

export function buildSignals(input: BuildSignalsInput): RetroSignal[] {
  const sessionDirs = input.sessionDirs ?? new Map<string, string>();
  const ticketOf = new Map<string, string>();
  for (const session of input.sessions ?? []) {
    if (session.ticket !== undefined) ticketOf.set(session.sessionId, session.ticket);
  }

  // Ticketless digests are transcript candidates; a claimed ticket covers the
  // session whether the claim comes from the digest or from the registry.
  const candidates = new Map<string, StoredDigest>();
  for (const digest of input.digests) {
    if (digest.frontmatter.ticket !== undefined) continue;
    if (ticketOf.has(digest.sessionId)) continue;
    candidates.set(digest.sessionId, digest);
  }

  const signals: RetroSignal[] = [];
  const claimed = new Set<string>();

  for (const changes of input.attribution.rogue) {
    const dir = normalizePath(changes.dir);
    const sessionIds = [
      ...new Set([
        ...changes.sessionIds,
        ...[...sessionDirs.entries()]
          .filter(([, cwd]) => normalizePath(cwd) === dir)
          .map(([sessionId]) => sessionId),
      ]),
    ];
    const sessions: RetroSignalSession[] = [];
    let transcript = false;
    for (const sessionId of sessionIds) {
      const digest = candidates.get(sessionId);
      if (digest) {
        claimed.add(sessionId);
        transcript = true;
        sessions.push(sessionOf(digest));
      } else {
        sessions.push({ sessionId });
      }
    }
    signals.push({
      id: signalId(fingerprintOf(changes, sessionIds)),
      sources: transcript ? ["git", "transcript"] : ["git"],
      dir: changes.dir,
      changes,
      sessions,
      referencedTickets: changes.referencedTickets,
      sessionTickets: changes.sessionTickets,
    });
  }

  for (const [sessionId, digest] of candidates) {
    if (claimed.has(sessionId)) continue;
    signals.push({
      id: signalId([sessionId, hashText(digest.body)]),
      sources: ["transcript"],
      dir: sessionDirs.get(sessionId) ?? null,
      changes: null,
      sessions: [sessionOf(digest)],
      referencedTickets: [],
      sessionTickets: [],
    });
  }

  return signals;
}
