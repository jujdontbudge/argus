import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDispatchSlots } from "./slots.ts";

/**
 * Ticket #56 — SPEC §7.3.3's cap of 3, as the thing that actually holds a
 * deployment down rather than a number someone parsed.
 *
 * A dispatch slot is held for the LIFETIME OF A WORKER SESSION, not the
 * lifetime of a function call, so the dispatcher process is free to exit while
 * three workers keep running. That is why liveness is the worker's pid and why
 * there is deliberately NO time-based expiry anywhere in this module: a slow
 * session and a dead session look identical to a clock, and guessing wrong
 * either abandons live work or double-spawns a ticket.
 */
async function withSlots(
  body: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "argus-dispatch-slots-"));
  try {
    await body(directory);
  } finally {
    await rm(directory, { force: true, recursive: true });
  }
}

async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

describe("dispatch slots (the cap of 3, SPEC §7.3.3)", () => {
  test("holds at most maxConcurrency; the next acquire is REFUSED, never queued", async () => {
    await withSlots(async (directory) => {
      const slots = createDispatchSlots({ directory, maxConcurrency: 3 });

      const first = await slots.tryAcquire("1");
      const second = await slots.tryAcquire("2");
      const third = await slots.tryAcquire("3");
      const fourth = await slots.tryAcquire("4");

      expect(first).not.toBeNull();
      expect(second).not.toBeNull();
      expect(third).not.toBeNull();
      expect(fourth).toBeNull();
      expect((await readdir(directory)).sort()).toEqual([
        "slot-0",
        "slot-1",
        "slot-2",
      ]);
    });
  });

  test("a released slot is reusable and release is idempotent", async () => {
    await withSlots(async (directory) => {
      const slots = createDispatchSlots({ directory, maxConcurrency: 1 });
      const held = (await slots.tryAcquire("1"))!;
      await held.release();
      await held.release();

      expect(await slots.tryAcquire("2")).not.toBeNull();
    });
  });

  test("a slot records the ticket and the worker pid it was filled with", async () => {
    await withSlots(async (directory) => {
      const slots = createDispatchSlots({ directory, maxConcurrency: 1 });
      const held = (await slots.tryAcquire("56"))!;
      await held.fill({
        agent: "claude",
        baseSha: "abc123",
        branch: "argus/ticket-56",
        pid: 4242,
        sessionId: "session-56",
        worktree: "/tmp/wt",
      });

      const entries = await slots.entries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.record).toMatchObject({
        agent: "claude",
        pid: 4242,
        sessionId: "session-56",
        state: "deployed",
        ticket: "56",
      });
    });
  });

  test("a slot whose worker is ALIVE is never reclaimed, however old it is", async () => {
    await withSlots(async (directory) => {
      const slots = createDispatchSlots({
        directory,
        maxConcurrency: 1,
        // A year of "elapsed time" and a live worker: still not dead.
        now: () => new Date("2027-08-26T00:00:00.000Z"),
      });
      const held = (await slots.tryAcquire("56"))!;
      await held.fill({ pid: process.pid, sessionId: "s", worktree: "/tmp/wt" });

      const entries = await slots.entries();
      expect(entries[0]!.alive).toBe(true);
    });
  });

  test("a slot whose worker pid is DEAD reads as not alive", async () => {
    await withSlots(async (directory) => {
      const slots = createDispatchSlots({ directory, maxConcurrency: 1 });
      const held = (await slots.tryAcquire("56"))!;
      await held.fill({ pid: await deadPid(), sessionId: "s", worktree: "/tmp/wt" });

      const entries = await slots.entries();
      expect(entries[0]!.alive).toBe(false);
    });
  });

  test("a RESERVED slot is owned by the dispatcher, so a crashed dispatcher frees it", async () => {
    await withSlots(async (directory) => {
      const slots = createDispatchSlots({
        directory,
        maxConcurrency: 1,
        pid: await deadPid(),
      });
      await slots.tryAcquire("56");

      const entries = await slots.entries();
      expect(entries[0]!.record.state).toBe("reserved");
      expect(entries[0]!.alive).toBe(false);
    });
  });

  test("a dead slot is NOT silently reclaimed by acquiring — recovery owns that", async () => {
    await withSlots(async (directory) => {
      const slots = createDispatchSlots({ directory, maxConcurrency: 1 });
      const held = (await slots.tryAcquire("56"))!;
      await held.fill({ pid: await deadPid(), sessionId: "s", worktree: "/tmp/wt" });

      // The ticket is still assigned on GitHub; freeing the slot without
      // releasing that claim would lose the ticket. So capacity stays taken
      // until the recovery pass has had its say.
      expect(await slots.tryAcquire("57")).toBeNull();
    });
  });

  test("an unreadable slot file is surfaced, not parsed into a false live worker", async () => {
    await withSlots(async (directory) => {
      const slots = createDispatchSlots({ directory, maxConcurrency: 1 });
      await writeFile(join(directory, "slot-0"), "{ not json");

      const entries = await slots.entries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.alive).toBe(false);
      expect(entries[0]!.corrupt).toBe(true);
    });
  });

  test("slots left behind by a HIGHER cap are still seen after the cap is lowered", async () => {
    await withSlots(async (directory) => {
      await createDispatchSlots({ directory, maxConcurrency: 3 }).tryAcquire("1");
      const wide = createDispatchSlots({ directory, maxConcurrency: 3 });
      await wide.tryAcquire("2");
      await wide.tryAcquire("3");

      const narrowed = createDispatchSlots({ directory, maxConcurrency: 1 });
      expect(await narrowed.entries()).toHaveLength(3);
      expect(await narrowed.tryAcquire("4")).toBeNull();
    });
  });
});
