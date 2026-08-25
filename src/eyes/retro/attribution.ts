/**
 * Attribution (SPEC §5.5): which git changes a REGISTERED TICKET SESSION
 * covers, and which are rogue. The registry is the only authority — no
 * heuristic about who "probably" did the work.
 *
 * Two evidence paths make a change attributable:
 *
 * 1. `session-workspace` — the checkout is a registered session's workspace
 *    and that deployment claimed a ticket (§7.3: one ticket, one worktree,
 *    one session).
 * 2. `registered-ticket-reference` — the commit names a ticket some registered
 *    session claimed, which covers merges and hand-commits made outside the
 *    worktree.
 *
 * A commit naming a ticket NOBODY claimed stays rogue: the tracker cannot be
 * consulted from here, and §5.5 is explicit that a missing retro is the
 * expensive failure. The referenced number rides along as a parent hint.
 */
import type { SessionRecord } from "../../provenance";
import type { GitCommit, GitScan, WorkingTreeChange } from "./git";

export interface AttributionContext {
  /** Deployments read from `.argus/registry/sessions.jsonl`. */
  sessions: SessionRecord[];
  /** sessionId → the cwd it was observed running in (session-meta events). */
  sessionDirs?: ReadonlyMap<string, string>;
}

export type Coverage =
  | { by: "session-workspace"; sessionId: string; ticket: string }
  | { by: "registered-ticket-reference"; sessionId: string; ticket: string };

/** Changes a registered ticket session covers; kept as evidence, not filed. */
export interface AttributedChanges {
  dir: string;
  commits: GitCommit[];
  workingTree: WorkingTreeChange | null;
  coverage: Coverage;
  sessionIds: string[];
}

/** Changes no registered ticket session covers — the git retro signal. */
export interface RogueChanges {
  dir: string;
  commits: GitCommit[];
  workingTree: WorkingTreeChange | null;
  /** Sessions observed working in this checkout (session-meta cwd). */
  sessionIds: string[];
  /** Ticket numbers the rogue work names, in first-seen order (parent hints). */
  referencedTickets: string[];
}

export interface Attribution {
  rogue: RogueChanges[];
  attributed: AttributedChanges[];
}

/** Trailing slashes and `.` segments must never split one checkout in two. */
function normalizePath(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.length === 0 ? "/" : trimmed;
}

/** `#123` anywhere in the commit message; `#7x` is not a ticket reference. */
export function referencedTickets(text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(/#(\d+)(?![\w.-])/g)) {
    const ticket = match[1]!;
    if (!found.includes(ticket)) found.push(ticket);
  }
  return found;
}

export function attributeChanges(
  scan: GitScan,
  context: AttributionContext,
): Attribution {
  const byWorkspace = new Map<string, SessionRecord>();
  const byTicket = new Map<string, SessionRecord>();
  for (const session of context.sessions) {
    if (session.ticket === undefined) continue; // planning sessions claim nothing
    if (session.workspace !== undefined) {
      byWorkspace.set(normalizePath(session.workspace), session);
    }
    if (!byTicket.has(session.ticket)) byTicket.set(session.ticket, session);
  }

  const dirsBySession = context.sessionDirs ?? new Map<string, string>();
  const rogue: RogueChanges[] = [];
  const attributed: AttributedChanges[] = [];

  for (const root of scan.roots) {
    if (root.commits.length === 0 && root.workingTree === null) continue;
    const dir = normalizePath(root.dir);
    const sessionIds = [...dirsBySession.entries()]
      .filter(([, cwd]) => normalizePath(cwd) === dir)
      .map(([sessionId]) => sessionId);

    const owner = byWorkspace.get(dir);
    if (owner?.ticket !== undefined) {
      attributed.push({
        dir: root.dir,
        commits: root.commits,
        workingTree: root.workingTree,
        coverage: {
          by: "session-workspace",
          sessionId: owner.sessionId,
          ticket: owner.ticket,
        },
        sessionIds,
      });
      continue;
    }

    // Per commit: one checkout can hold both covered and rogue work.
    const rogueCommits: GitCommit[] = [];
    const covered = new Map<string, { session: SessionRecord; commits: GitCommit[] }>();
    const hints: string[] = [];
    for (const commit of root.commits) {
      const referenced = referencedTickets(`${commit.subject}\n${commit.body}`);
      const claimed = referenced.find((ticket) => byTicket.has(ticket));
      if (claimed !== undefined) {
        const session = byTicket.get(claimed)!;
        const bucket = covered.get(claimed) ?? { session, commits: [] };
        bucket.commits.push(commit);
        covered.set(claimed, bucket);
        continue;
      }
      rogueCommits.push(commit);
      for (const ticket of referenced) {
        if (!hints.includes(ticket)) hints.push(ticket);
      }
    }

    for (const [ticket, bucket] of covered) {
      attributed.push({
        dir: root.dir,
        commits: bucket.commits,
        workingTree: null,
        coverage: {
          by: "registered-ticket-reference",
          sessionId: bucket.session.sessionId,
          ticket,
        },
        sessionIds,
      });
    }

    if (rogueCommits.length > 0 || root.workingTree !== null) {
      rogue.push({
        dir: root.dir,
        commits: rogueCommits,
        workingTree: root.workingTree,
        sessionIds,
        referencedTickets: hints,
      });
    }
  }

  return { rogue, attributed };
}
