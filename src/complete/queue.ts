/**
 * The durable verification queue (ticket #57).
 *
 * IT EXISTS BECAUSE A COMPLETION SIGNAL IS SPENT WHEN IT IS READ. #58 gave
 * push and poll one durable `(session, status)` cursor precisely so a signal
 * is never delivered twice — which is right for Hermes and fatal for a loop
 * that can REFUSE. A ticket whose gate went red must come back on the next
 * pass, and its signal never will.
 *
 * So a signal is not the work item; it is the thing that CREATES one. The
 * queue file is the work item, it outlives the process that made it, and it is
 * removed only when the ticket is actually closed. That also gives recovery
 * (#56) a place to hand over the other way a ticket becomes verifiable — a
 * dead session that left commits — without either module learning the other's
 * internals.
 *
 * One file per ticket, under `.argus/dispatch/verify/`, beside the slots that
 * the same dispatch owns. Enqueueing twice is not an error and never resets an
 * entry's history: attempts and the last failure are what make a stuck ticket
 * visible instead of silently retried forever.
 */
import { mkdir, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";

export type VerificationSource =
  /** A terminal completion signal from #58's consumer. */
  | "signal"
  /** #56's recovery pass: the session died, but it left commits behind. */
  | "recovery";

export interface VerifyEntry {
  ticket: string;
  source: VerificationSource;
  queuedAt: string;
  sessionId?: string;
  /** Passes that ran gates on this ticket and did not close it. */
  attempts: number;
  /**
   * The merge commit, once this ticket's branch is in the base.
   *
   * It is written BEFORE the close is attempted, and it is the only honest
   * answer to "has this already been merged?". Git cannot tell: once a branch
   * is merged, `git merge-base base branch` IS the branch tip, so a merged
   * ticket and a ticket that committed nothing are the same zero-commit
   * range. Inferring one from the other would either merge twice or throw a
   * merged ticket away as empty.
   */
  mergedSha?: string;
  /** Why the last pass did not close it — the loud half of a stuck ticket. */
  lastFailure?: string;
}

export function verifyQueueDirectory(repo: string): string {
  return join(repo, ".argus", "dispatch", "verify");
}

function slug(ticket: string): string {
  const cleaned = ticket.replace(/^#/, "").replace(/[^A-Za-z0-9._-]+/g, "-");
  return cleaned === "" ? "unnamed" : cleaned;
}

function entryPath(repo: string, ticket: string): string {
  return join(verifyQueueDirectory(repo), `ticket-${slug(ticket)}.json`);
}

async function write(repo: string, entry: VerifyEntry): Promise<void> {
  const path = entryPath(repo, entry.ticket);
  await mkdir(verifyQueueDirectory(repo), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await Bun.write(temporary, `${JSON.stringify(entry, null, 2)}\n`);
  await rename(temporary, path);
}

function parse(raw: unknown): VerifyEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const row = raw as Record<string, unknown>;
  if (typeof row.ticket !== "string" || row.ticket === "") return null;
  return {
    attempts: typeof row.attempts === "number" && row.attempts >= 0 ? row.attempts : 0,
    queuedAt: typeof row.queuedAt === "string" ? row.queuedAt : "",
    source: row.source === "recovery" ? "recovery" : "signal",
    ticket: row.ticket,
    ...(typeof row.sessionId === "string" && { sessionId: row.sessionId }),
    ...(typeof row.mergedSha === "string" && { mergedSha: row.mergedSha }),
    ...(typeof row.lastFailure === "string" && { lastFailure: row.lastFailure }),
  };
}

export async function readVerification(
  repo: string,
  ticket: string,
): Promise<VerifyEntry | null> {
  try {
    return parse(await Bun.file(entryPath(repo, ticket)).json());
  } catch {
    return null;
  }
}

/**
 * Put a ticket on the queue, or leave the existing entry exactly as it is. A
 * second signal for a ticket already awaiting verification is the same work
 * item, not a fresh one, and resetting `attempts` would hide a ticket that has
 * failed its gates ten passes running.
 */
export async function enqueueVerification(
  repo: string,
  request: {
    ticket: string;
    source: VerificationSource;
    sessionId?: string;
    now?: () => Date;
  },
): Promise<VerifyEntry> {
  const existing = await readVerification(repo, request.ticket);
  if (existing !== null) return existing;
  const entry: VerifyEntry = {
    attempts: 0,
    queuedAt: (request.now?.() ?? new Date()).toISOString(),
    source: request.source,
    ticket: request.ticket,
    ...(request.sessionId !== undefined && { sessionId: request.sessionId }),
  };
  await write(repo, entry);
  return entry;
}

/** Everything awaiting verification, in ticket order so passes are stable. */
export async function listVerifications(repo: string): Promise<VerifyEntry[]> {
  let names: string[];
  try {
    names = await readdir(verifyQueueDirectory(repo));
  } catch {
    return [];
  }
  const entries: VerifyEntry[] = [];
  for (const name of names.sort()) {
    if (!name.startsWith("ticket-") || !name.endsWith(".json")) continue;
    let raw: unknown;
    try {
      raw = await Bun.file(join(verifyQueueDirectory(repo), name)).json();
    } catch {
      continue; // removed between the listing and the read, or half-written
    }
    const entry = parse(raw);
    if (entry !== null) entries.push(entry);
  }
  return entries.sort((left, right) => {
    const byNumber = Number(left.ticket) - Number(right.ticket);
    return Number.isNaN(byNumber) ? left.ticket.localeCompare(right.ticket) : byNumber;
  });
}

/**
 * The branch is in the base. Recorded before the close is attempted, so a
 * pass that merges and then loses `gh` resumes at the close instead of
 * re-merging or writing the work off as empty.
 */
export async function recordVerificationMerge(
  repo: string,
  ticket: string,
  mergedSha: string,
): Promise<void> {
  const existing = await readVerification(repo, ticket);
  if (existing === null) return;
  await write(repo, { ...existing, mergedSha });
}

/** A pass ran and did not close it: count the attempt and keep the reason. */
export async function recordVerificationFailure(
  repo: string,
  ticket: string,
  reason: string,
): Promise<void> {
  const existing = await readVerification(repo, ticket);
  if (existing === null) return;
  await write(repo, {
    ...existing,
    attempts: existing.attempts + 1,
    lastFailure: reason.slice(0, 1_000),
  });
}

/** The ticket is closed. Only then does the work item stop existing. */
export async function dequeueVerification(repo: string, ticket: string): Promise<void> {
  try {
    await unlink(entryPath(repo, ticket));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}
