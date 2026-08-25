/**
 * Machine-wide brain concurrency cap (ADR-0002: at most 2 concurrent
 * `codex exec` across ALL repos and eyes). The counter is a directory of
 * slot files — `slot-0 … slot-(n-1)` — acquired with exclusive creates, so
 * every eye process on the machine shares one budget through the filesystem.
 * A slot names its owning pid; a slot whose owner is dead is stale and gets
 * reclaimed, so a crashed eye can never leak the machine's brain budget.
 */
import { open, readFile, unlink } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

export interface BrainCapOptions {
  /** The machine-shared slots directory (all eyes must agree on it). */
  directory: string;
  /** Slot count; ADR-0002 says 2, `.argus/config.yaml` may override. */
  maxConcurrency: number;
  /** Wait between acquisition attempts when all slots are held. */
  pollMs?: number;
}

/** Releases the held slot; safe to call more than once. */
export type ReleaseSlot = () => Promise<void>;

export interface BrainCap {
  acquire(): Promise<ReleaseSlot>;
}

/** `~/.argus-repos`-style default, overridable via ARGUS_BRAIN_SLOTS_DIR. */
export function defaultBrainSlotsDirectory(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const override = env.ARGUS_BRAIN_SLOTS_DIR;
  if (override) return override;
  const home = env.HOME;
  if (!home) throw new Error("brain cap: HOME is not set");
  return join(home, ".argus-brain-slots");
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EPERM") {
      return true; // exists, owned by someone else
    }
    return false;
  }
}

async function ignoreMissing(action: Promise<void>): Promise<void> {
  try {
    await action;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return;
    }
    throw error;
  }
}

export function createBrainCap(options: BrainCapOptions): BrainCap {
  const pollMs = options.pollMs ?? 250;
  const slots = Array.from(
    { length: options.maxConcurrency },
    (_, index) => join(options.directory, `slot-${index}`),
  );

  const tryClaim = async (slot: string): Promise<ReleaseSlot | null> => {
    try {
      const handle = await open(slot, "wx");
      await handle.writeFile(
        JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
      );
      await handle.close();
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        return null;
      }
      throw error;
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await ignoreMissing(unlink(slot));
    };
  };

  const reclaimStale = async (slot: string): Promise<void> => {
    let raw: string;
    try {
      raw = await readFile(slot, "utf8");
    } catch {
      return; // already gone — someone else released or reclaimed it
    }
    let pid: unknown;
    try {
      pid = (JSON.parse(raw) as { pid?: unknown }).pid;
    } catch {
      pid = undefined;
    }
    // Unreadable slot contents count as stale: only a live owner keeps a slot.
    if (typeof pid === "number" && isAlive(pid)) return;
    await ignoreMissing(unlink(slot));
  };

  return {
    async acquire() {
      await mkdir(options.directory, { recursive: true });
      for (;;) {
        for (const slot of slots) {
          const release = await tryClaim(slot);
          if (release) return release;
        }
        for (const slot of slots) await reclaimStale(slot);
        await Bun.sleep(pollMs);
      }
    },
  };
}
