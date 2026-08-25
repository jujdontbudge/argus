import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrainCap, defaultBrainSlotsDirectory } from "./cap";

async function withSlotsDir(
  body: (directory: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "argus-brain-slots-"));
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

describe("machine-wide brain cap (ADR-0002: 2 concurrent codex exec)", () => {
  test("holds at most maxConcurrency slots; a third acquire waits for a release", async () => {
    await withSlotsDir(async (directory) => {
      const cap = createBrainCap({ directory, maxConcurrency: 2, pollMs: 5 });
      const releaseFirst = await cap.acquire();
      const releaseSecond = await cap.acquire();

      let thirdAcquired = false;
      const third = cap.acquire().then((release) => {
        thirdAcquired = true;
        return release;
      });
      await Bun.sleep(30);
      expect(thirdAcquired).toBe(false);

      await releaseFirst();
      const releaseThird = await third;
      expect(thirdAcquired).toBe(true);
      await releaseSecond();
      await releaseThird();
      expect(await readdir(directory)).toEqual([]);
    });
  });

  test("a released slot is reusable and release is idempotent", async () => {
    await withSlotsDir(async (directory) => {
      const cap = createBrainCap({ directory, maxConcurrency: 1, pollMs: 5 });
      const release = await cap.acquire();
      await release();
      await release();
      const again = await cap.acquire();
      await again();
    });
  });

  test("a slot held by a dead process is stale and gets reclaimed", async () => {
    await withSlotsDir(async (directory) => {
      await writeFile(
        join(directory, "slot-0"),
        JSON.stringify({ pid: await deadPid(), acquiredAt: 0 }),
      );
      const cap = createBrainCap({ directory, maxConcurrency: 1, pollMs: 5 });
      const release = await cap.acquire();
      await release();
    });
  });

  test("a slot held by a live process is respected", async () => {
    await withSlotsDir(async (directory) => {
      await writeFile(
        join(directory, "slot-0"),
        JSON.stringify({ pid: process.pid, acquiredAt: Date.now() }),
      );
      const cap = createBrainCap({ directory, maxConcurrency: 1, pollMs: 5 });
      let acquired = false;
      const pending = cap.acquire().then((release) => {
        acquired = true;
        return release;
      });
      await Bun.sleep(30);
      expect(acquired).toBe(false);
      await rm(join(directory, "slot-0"));
      await (await pending)();
    });
  });

  test("two caps over the same directory share the machine-wide budget", async () => {
    await withSlotsDir(async (directory) => {
      const reviewer = createBrainCap({ directory, maxConcurrency: 2, pollMs: 5 });
      const digest = createBrainCap({ directory, maxConcurrency: 2, pollMs: 5 });
      const releaseReviewer = await reviewer.acquire();
      const releaseDigest = await digest.acquire();
      let overflowAcquired = false;
      const overflow = reviewer.acquire().then((release) => {
        overflowAcquired = true;
        return release;
      });
      await Bun.sleep(30);
      expect(overflowAcquired).toBe(false);
      await releaseDigest();
      await (await overflow)();
      await releaseReviewer();
    });
  });

  test("default slots directory follows the ~/.argus-repos convention with an env override", () => {
    expect(
      defaultBrainSlotsDirectory({ HOME: "/Users/x" }),
    ).toBe("/Users/x/.argus-brain-slots");
    expect(
      defaultBrainSlotsDirectory({
        ARGUS_BRAIN_SLOTS_DIR: "/tmp/slots",
        HOME: "/Users/x",
      }),
    ).toBe("/tmp/slots");
  });
});
