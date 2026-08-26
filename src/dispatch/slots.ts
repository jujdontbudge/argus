/**
 * Dispatch slots — SPEC §7.3.3's concurrency cap, as an object that a
 * deployment cannot be started without holding (ticket #56).
 *
 * The cap is a directory of slot files, `slot-0 … slot-(n-1)`, created with
 * exclusive `wx` opens. That shape is borrowed deliberately from
 * `src/eyes/cap.ts` — the machine-wide brain cap — because the two solve the
 * same coordination problem across processes and a second, subtly different
 * mechanism is exactly the drift AUDIT.md keeps finding. Three things differ,
 * and all three follow from what a dispatch slot is:
 *
 * 1. **It refuses instead of queuing.** The brain cap blocks until a slot is
 *    free because a queued `codex exec` still runs a minute later. A dispatch
 *    pass that blocked would hold a process open for the hours a ticket takes;
 *    the honest answer is "at capacity, nothing dispatched", and the next pass
 *    picks up.
 * 2. **The slot outlives the process that took it.** It is held for the
 *    lifetime of a WORKER SESSION, so the pid written into it is the worker's
 *    once one exists — not the dispatcher's. A dispatcher may exit with three
 *    workers running and the cap still reads 3.
 * 3. **It never reclaims itself.** The brain cap treats a dead owner's slot as
 *    free and takes it. Here, a slot's ticket is also ASSIGNED on GitHub, and
 *    silently reusing the slot would strand that assignment forever. So a dead
 *    slot keeps holding capacity until the recovery pass (`./recover.ts`) has
 *    released the claim too. Capacity that only recovery can free is the
 *    property that makes a stuck dispatcher visible instead of silent.
 *
 * There is NO time-based expiry in this module, and there must never be one. A
 * slow session and a dead session are indistinguishable to a clock; liveness
 * is the worker pid and nothing else.
 */
import { mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { DeployAgent } from "../deploy";

export type SlotState =
  /** Capacity taken, no worker yet: the dispatcher itself owns this slot. */
  | "reserved"
  /** A worker session exists; the recorded pid is the worker's. */
  | "deployed";

export interface SlotRecord {
  state: SlotState;
  ticket: string;
  /** Whoever owns the slot right now — the dispatcher, then the worker. */
  pid: number;
  acquiredAt: string;
  /** True once the ticket is assigned on GitHub, so recovery can release it. */
  claimed?: boolean;
  agent?: DeployAgent;
  sessionId?: string;
  worktree?: string;
  branch?: string;
  /** HEAD at deploy time — what "did this worker produce anything?" measures. */
  baseSha?: string;
}

export interface SlotEntry {
  path: string;
  record: SlotRecord;
  /** The owning process, right now. NEVER inferred from elapsed time. */
  alive: boolean;
  /** The file could not be parsed; treat as dead and surface it. */
  corrupt: boolean;
}

/** What a caller may write into a slot once the deployment exists. */
export type SlotFill = Partial<Omit<SlotRecord, "acquiredAt" | "state" | "ticket">>;

export interface HeldSlot {
  path: string;
  ticket: string;
  /** Record the claim, so recovery knows to unassign if this slot dies. */
  markClaimed(): Promise<void>;
  /** Hand the slot over to the worker: state `deployed`, pid the worker's. */
  fill(update: SlotFill): Promise<void>;
  release(): Promise<void>;
}

export interface DispatchSlotsOptions {
  directory: string;
  maxConcurrency: number;
  /** The dispatcher's own pid: the owner of a `reserved` slot. */
  pid?: number;
  now?: () => Date;
  isAlive?: (pid: number) => boolean;
}

export interface DispatchSlots {
  readonly maxConcurrency: number;
  readonly directory: string;
  /** A slot, or null when the cap is full. Never waits. */
  tryAcquire(ticket: string): Promise<HeldSlot | null>;
  /** Every slot file that exists — including ones a lowered cap orphaned. */
  entries(): Promise<SlotEntry[]>;
  releaseAt(path: string): Promise<void>;
}

/** The per-repo slots directory; siblings of the registry under `.argus/`. */
export function dispatchSlotsDirectory(repo: string): string {
  return join(repo, ".argus", "dispatch", "slots");
}

/** Liveness, the only liveness: does the owning process still exist? */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists and belongs to somebody else — still alive.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function ignoreMissing(action: Promise<void>): Promise<void> {
  try {
    await action;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
}

export function createDispatchSlots(
  options: DispatchSlotsOptions,
): DispatchSlots {
  const isAlive = options.isAlive ?? processIsAlive;
  const now = options.now ?? (() => new Date());
  const ownerPid = options.pid ?? process.pid;
  const slotPaths = Array.from({ length: options.maxConcurrency }, (_, index) =>
    join(options.directory, `slot-${index}`),
  );

  const write = async (path: string, record: SlotRecord): Promise<void> => {
    await Bun.write(path, `${JSON.stringify(record)}\n`);
  };

  const held = (path: string, record: SlotRecord): HeldSlot => {
    let current = record;
    let released = false;
    return {
      async fill(update) {
        current = { ...current, ...update, state: "deployed" };
        await write(path, current);
      },
      async markClaimed() {
        current = { ...current, claimed: true };
        await write(path, current);
      },
      path,
      async release() {
        if (released) return;
        released = true;
        await ignoreMissing(unlink(path));
      },
      ticket: current.ticket,
    };
  };

  return {
    directory: options.directory,

    async entries() {
      let names: string[];
      try {
        names = await readdir(options.directory);
      } catch {
        return [];
      }
      const found: SlotEntry[] = [];
      for (const name of names.filter((entry) => entry.startsWith("slot-")).sort()) {
        const path = join(options.directory, name);
        let raw: string;
        try {
          raw = await readFile(path, "utf8");
        } catch {
          continue; // released between the listing and the read
        }
        const record = parse(raw);
        if (record === null) {
          found.push({
            alive: false,
            corrupt: true,
            path,
            record: {
              acquiredAt: new Date(0).toISOString(),
              pid: -1,
              state: "reserved",
              ticket: "",
            },
          });
          continue;
        }
        found.push({ alive: isAlive(record.pid), corrupt: false, path, record });
      }
      return found;
    },

    maxConcurrency: options.maxConcurrency,

    async releaseAt(path) {
      await ignoreMissing(unlink(path));
    },

    async tryAcquire(ticket) {
      await mkdir(options.directory, { recursive: true });
      const record: SlotRecord = {
        acquiredAt: now().toISOString(),
        pid: ownerPid,
        state: "reserved",
        ticket,
      };
      for (const path of slotPaths) {
        try {
          const handle = await open(path, "wx");
          try {
            await handle.writeFile(`${JSON.stringify(record)}\n`);
          } finally {
            await handle.close();
          }
        } catch (error) {
          if (error instanceof Error && "code" in error && error.code === "EEXIST") {
            continue;
          }
          throw error;
        }
        return held(path, record);
      }
      return null;
    },
  };
}

function parse(raw: string): SlotRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const row = parsed as Record<string, unknown>;
  if (typeof row.pid !== "number" || typeof row.ticket !== "string") return null;
  const state = row.state === "deployed" ? "deployed" : "reserved";
  return {
    acquiredAt: typeof row.acquiredAt === "string" ? row.acquiredAt : "",
    pid: row.pid,
    state,
    ticket: row.ticket,
    ...(typeof row.claimed === "boolean" && { claimed: row.claimed }),
    ...((row.agent === "claude" || row.agent === "codex") && { agent: row.agent }),
    ...(typeof row.sessionId === "string" && { sessionId: row.sessionId }),
    ...(typeof row.worktree === "string" && { worktree: row.worktree }),
    ...(typeof row.branch === "string" && { branch: row.branch }),
    ...(typeof row.baseSha === "string" && { baseSha: row.baseSha }),
  };
}
