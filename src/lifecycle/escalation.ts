import { mkdir, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { applyDigestUpdate, digestFileName, updateIndex } from "../eyes/digest/outputs.ts";
import { chainRootOf } from "../eyes/digest/chain.ts";
import { appendDurably, loadRegistry, registryPaths } from "../provenance";

export const ESCALATION_CAUSES = {
  nudgeBudgetExhausted: "nudge budget exhausted while stalled-live",
  r2Bailout: "R2 bail-out",
  secondDispatchedDeath: "second death after automatic relaunch",
  grillParkProposal: "grill 72h park proposal",
} as const;

export type EscalationCause = (typeof ESCALATION_CAUSES)[keyof typeof ESCALATION_CAUSES];

interface EscalationBase {
  sessionId: string;
  ticket: string | number;
  /** Optional metadata only; it is never copied into the notification. */
  agent?: string;
}

export type EscalationTrigger =
  | (EscalationBase & {
      kind: "nudge-budget-exhausted";
      liveState: "stalled-live" | "running";
    })
  | (EscalationBase & {
      kind: "r2-bailout";
      consequentialChoiceRecordedOnTicket: boolean;
    })
  | (EscalationBase & {
      kind: "dispatched-ticket-death";
      deathCount: number;
      automaticRelaunchCount: number;
    })
  | (EscalationBase & {
      kind: "grill-park-proposal";
      parkedHours: number;
    });

export interface MacNotificationRequest {
  title: "Argus needs Johan";
  body: string;
}

export type MacNotification = (request: MacNotificationRequest) => Promise<void>;

export interface EscalationOptions {
  now?: () => Date;
  notify?: MacNotification;
}

export interface LifecycleEscalationRecord {
  schemaVersion: 1;
  kind: "needs-johan-escalation";
  sessionId: string;
  ticket: string;
  cause: EscalationCause;
  createdAt: string;
}

export type EscalationResult =
  | { status: "ignored"; reason: "not-trigger" }
  | { status: "duplicate"; cause: EscalationCause; ticket: string }
  | {
      status: "escalated";
      cause: EscalationCause;
      ticket: string;
      notification: MacNotificationRequest;
    }
  | {
      status: "degraded";
      cause: EscalationCause;
      ticket: string;
      notification: MacNotificationRequest;
      reason: string;
    };

const LIFECYCLE_FILE = "lifecycle.jsonl";
const LIFECYCLE_LOCK = "lifecycle.lock";
const MAX_NOTIFICATION_BYTES = 256;

function lifecyclePath(repo: string): string {
  return join(repo, ".argus", "registry", LIFECYCLE_FILE);
}

function lifecycleLockPath(repo: string): string {
  return join(repo, ".argus", "registry", LIFECYCLE_LOCK);
}

function ticketNumber(value: string | number): string | null {
  const ticket = String(value).trim();
  return /^\d+$/.test(ticket) ? ticket : null;
}

function isCause(value: unknown): value is EscalationCause {
  return Object.values(ESCALATION_CAUSES).includes(value as EscalationCause);
}

/** The only four states allowed to route to Johan. Everything else is ignored. */
export function classifyEscalationCause(
  trigger: EscalationTrigger,
): EscalationCause | null {
  if (ticketNumber(trigger.ticket) === null || trigger.sessionId.trim() === "") return null;
  switch (trigger.kind) {
    case "nudge-budget-exhausted":
      return trigger.liveState === "stalled-live"
        ? ESCALATION_CAUSES.nudgeBudgetExhausted
        : null;
    case "r2-bailout":
      return trigger.consequentialChoiceRecordedOnTicket
        ? ESCALATION_CAUSES.r2Bailout
        : null;
    case "dispatched-ticket-death":
      return trigger.deathCount === 2 && trigger.automaticRelaunchCount === 1
        ? ESCALATION_CAUSES.secondDispatchedDeath
        : null;
    case "grill-park-proposal":
      return Number.isFinite(trigger.parkedHours) && trigger.parkedHours >= 72
        ? ESCALATION_CAUSES.grillParkProposal
        : null;
  }
}

function notificationFor(ticket: string, cause: EscalationCause): MacNotificationRequest {
  const request: MacNotificationRequest = {
    title: "Argus needs Johan",
    body: `#${ticket} ${cause}`,
  };
  if (Buffer.byteLength(request.body, "utf8") > MAX_NOTIFICATION_BYTES) {
    throw new Error("needs-Johan notification exceeds its bounded body budget");
  }
  return request;
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** Local macOS delivery only; no network or third-party notification service. */
export const sendMacOSNotification: MacNotification = async (request) => {
  const script =
    `display notification ${appleScriptString(request.body)} ` +
    `with title ${appleScriptString(request.title)}`;
  const child = Bun.spawn(["osascript", "-e", script], {
    stderr: "pipe",
    stdout: "ignore",
  });
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `osascript exited ${exitCode}`);
  }
};

function recordKey(sessionId: string, cause: EscalationCause): string {
  return `${sessionId}\u0000${cause}`;
}

function parseLifecycleRecord(value: unknown): LifecycleEscalationRecord | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.schemaVersion !== 1 ||
    row.kind !== "needs-johan-escalation" ||
    typeof row.sessionId !== "string" ||
    row.sessionId === "" ||
    typeof row.ticket !== "string" ||
    !/^\d+$/.test(row.ticket) ||
    !isCause(row.cause) ||
    typeof row.createdAt !== "string" ||
    Number.isNaN(Date.parse(row.createdAt))
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    kind: "needs-johan-escalation",
    sessionId: row.sessionId,
    ticket: row.ticket,
    cause: row.cause,
    createdAt: row.createdAt,
  };
}

async function readLifecycleRecords(repo: string): Promise<LifecycleEscalationRecord[]> {
  const file = Bun.file(lifecyclePath(repo));
  if (!(await file.exists())) return [];
  const records: LifecycleEscalationRecord[] = [];
  for (const line of (await file.text()).split("\n")) {
    if (line.trim() === "") continue;
    try {
      const record = parseLifecycleRecord(JSON.parse(line));
      if (record !== null) records.push(record);
    } catch {
      // A torn or malformed append cannot authorize a duplicate notification.
    }
  }
  return records;
}

async function withLifecycleLock<T>(repo: string, body: () => Promise<T>): Promise<T> {
  const lock = lifecycleLockPath(repo);
  await mkdir(join(repo, ".argus", "registry"), { recursive: true });
  for (;;) {
    try {
      await mkdir(lock);
      break;
    } catch {
      try {
        const held = await stat(lock);
        if (Date.now() - held.mtimeMs > 10_000) await rmdir(lock).catch(() => {});
      } catch {
        // The lock holder released between attempts.
      }
      await Bun.sleep(5);
    }
  }
  try {
    return await body();
  } finally {
    await rmdir(lock).catch(() => {});
  }
}

async function logicalSessionId(repo: string, sessionId: string): Promise<string> {
  const registry = await loadRegistry(registryPaths(repo));
  return chainRootOf(registry.sessions, sessionId);
}

/** Route one classified lifecycle trigger to the digest marker and local push. */
export async function escalateNeedsJohan(
  repo: string,
  trigger: EscalationTrigger,
  options: EscalationOptions = {},
): Promise<EscalationResult> {
  const cause = classifyEscalationCause(trigger);
  const ticket = ticketNumber(trigger.ticket);
  if (cause === null || ticket === null) return { status: "ignored", reason: "not-trigger" };
  const notification = notificationFor(ticket, cause);

  return withLifecycleLock(repo, async () => {
    // Digest chain rotation gives one logical session several physical ids.
    // Resolve that identity before deduping so a restart under a new id cannot
    // produce a second escalation for the same cause.
    const root = await logicalSessionId(repo, trigger.sessionId);
    const existing = await readLifecycleRecords(repo);
    if (existing.some((record) => recordKey(record.sessionId, record.cause) === recordKey(root, cause))) {
      return { status: "duplicate", cause, ticket };
    }

    // Reserve the (session, cause) before either channel is attempted. A
    // restart therefore cannot re-notify after a partial channel failure.
    const record: LifecycleEscalationRecord = {
      schemaVersion: 1,
      kind: "needs-johan-escalation",
      sessionId: root,
      ticket,
      cause,
      createdAt: (options.now?.() ?? new Date()).toISOString(),
    };
    await appendDurably(lifecyclePath(repo), record);

    const fileName = digestFileName(ticket, root);
    const seed = { agent: trigger.agent ?? "argus", ticket, startedBy: "hermes" as const };
    const marker = `[needs-johan] ticket #${ticket}: ${cause}`;
    const frontmatter = await applyDigestUpdate(
      join(repo, ".argus", "sessions"),
      fileName,
      seed,
      {
        narrative: {
          ts: record.createdAt,
          text: marker,
        },
      },
    );
    await updateIndex(join(repo, ".argus", "sessions"), {
      file: fileName,
      agent: frontmatter.agent,
      ...(frontmatter.ticket !== undefined && { ticket: frontmatter.ticket }),
      status: frontmatter.status,
      startedBy: frontmatter.startedBy,
      johanTouched: frontmatter.johanTouched,
      summary: marker,
    });

    try {
      await (options.notify ?? sendMacOSNotification)(notification);
      return { status: "escalated", cause, ticket, notification };
    } catch (error) {
      return {
        status: "degraded",
        cause,
        ticket,
        notification,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  });
}
