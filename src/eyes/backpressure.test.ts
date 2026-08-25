import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileAlertEmitter, retryForever, type StuckAlert } from "./backpressure";

/** Deterministic time: sleeping advances the clock, nothing waits for real. */
function fakeTime(): {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  slept: number[];
} {
  let current = 0;
  const slept: number[] = [];
  return {
    now: () => current,
    sleep: async (ms: number) => {
      slept.push(ms);
      current += ms;
    },
    slept,
  };
}

describe("never-drop backpressure (infinite retry, backoff, >15min alert)", () => {
  test("retries with exponential backoff until the operation succeeds", async () => {
    const time = fakeTime();
    let attempts = 0;
    const result = await retryForever(
      async () => {
        attempts += 1;
        if (attempts < 4) throw new Error(`boom ${attempts}`);
        return "verdict";
      },
      { now: time.now, sleep: time.sleep, onAlert: () => {} },
    );
    expect(result).toBe("verdict");
    expect(attempts).toBe(4);
    expect(time.slept).toEqual([1_000, 2_000, 4_000]);
  });

  test("backoff delay caps at maxDelayMs and NEVER gives up", async () => {
    const time = fakeTime();
    let attempts = 0;
    await retryForever(
      async () => {
        attempts += 1;
        if (attempts < 12) throw new Error("still down");
        return null;
      },
      { now: time.now, sleep: time.sleep, onAlert: () => {} },
    );
    expect(attempts).toBe(12);
    expect(Math.max(...time.slept)).toBe(60_000);
    expect(time.slept.filter((ms) => ms === 60_000).length).toBeGreaterThan(1);
  });

  test("stuck for >15min → exactly one alert, carrying elapsed and the last error", async () => {
    const time = fakeTime();
    const alerts: StuckAlert[] = [];
    let attempts = 0;
    await retryForever(
      async () => {
        attempts += 1;
        if (attempts < 40) throw new Error("codex outage");
        return "recovered";
      },
      {
        eye: "reviewer",
        now: time.now,
        sleep: time.sleep,
        onAlert: (alert) => {
          alerts.push(alert);
        },
      },
    );
    expect(alerts.length).toBe(1);
    expect(alerts[0]!.type).toBe("eye-stuck");
    expect(alerts[0]!.eye).toBe("reviewer");
    expect(alerts[0]!.stuckForMs).toBeGreaterThan(15 * 60_000);
    expect(alerts[0]!.lastError).toContain("codex outage");
    expect(alerts[0]!.attempts).toBeGreaterThan(1);
  });

  test("no alert when the operation recovers inside the stuck threshold", async () => {
    const time = fakeTime();
    const alerts: StuckAlert[] = [];
    let attempts = 0;
    await retryForever(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("blip");
        return null;
      },
      {
        now: time.now,
        sleep: time.sleep,
        onAlert: (alert) => {
          alerts.push(alert);
        },
      },
    );
    expect(alerts).toEqual([]);
  });

  test("fileAlertEmitter writes the alert as a §6 event file", async () => {
    const eventsDirectory = await mkdtemp(join(tmpdir(), "argus-events-"));
    try {
      const emit = fileAlertEmitter(eventsDirectory);
      await emit({
        type: "eye-stuck",
        eye: "reviewer",
        stuckForMs: 900_001,
        attempts: 17,
        lastError: "codex outage",
        at: "2026-08-25T00:00:00.000Z",
      });
      const files = await readdir(eventsDirectory);
      expect(files.length).toBe(1);
      expect(files[0]).toContain("reviewer-stuck");
      const written = JSON.parse(
        await Bun.file(join(eventsDirectory, files[0]!)).text(),
      );
      expect(written.type).toBe("eye-stuck");
      expect(written.attempts).toBe(17);
    } finally {
      await rm(eventsDirectory, { force: true, recursive: true });
    }
  });
});
