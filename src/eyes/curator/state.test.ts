import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  curatorStatePath,
  readCuratorState,
  recordRun,
  shouldRunNow,
} from "./state";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-08-24T12:00:00.000Z");
const WEEK = 168 * HOUR;

async function withRepo(body: (repo: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), "argus-curator-state-"));
  try {
    await body(repo);
  } finally {
    await rm(repo, { force: true, recursive: true });
  }
}

const gate = (repo: string, now: number, overrides: { enabled?: boolean } = {}) =>
  shouldRunNow(repo, { now, intervalHours: 168, enabled: true, ...overrides });

describe("the 7-day gate (lifted: agent/curator.py:198-252)", () => {
  test("a fresh repo seeds last_run_at and defers one full interval", async () => {
    await withRepo(async (repo) => {
      const decision = await gate(repo, NOW);
      expect(decision.run).toBe(false);
      expect(decision.reason).toBe("seeded-deferred");

      const state = await readCuratorState(repo);
      expect(state.last_run_at).toBe(new Date(NOW).toISOString());
      expect(state.run_count).toBe(0);
    });
  });

  test("inside the interval it is not due, and the seeded stamp does not move", async () => {
    await withRepo(async (repo) => {
      await gate(repo, NOW);
      const decision = await gate(repo, NOW + 6 * 24 * HOUR);
      expect(decision.run).toBe(false);
      expect(decision.reason).toBe("not-due");
      expect((await readCuratorState(repo)).last_run_at).toBe(
        new Date(NOW).toISOString(),
      );
    });
  });

  test("a full interval later it is due", async () => {
    await withRepo(async (repo) => {
      await gate(repo, NOW);
      expect((await gate(repo, NOW + WEEK)).run).toBe(true);
      expect((await gate(repo, NOW + WEEK)).reason).toBe("due");
    });
  });

  test("paused never runs, however overdue", async () => {
    await withRepo(async (repo) => {
      await gate(repo, NOW);
      await recordRun(repo, { at: new Date(NOW).toISOString(), summary: "x" });
      await Bun.write(
        curatorStatePath(repo),
        JSON.stringify({ ...(await readCuratorState(repo)), paused: true }),
      );
      const decision = await gate(repo, NOW + 400 * 24 * HOUR);
      expect(decision.run).toBe(false);
      expect(decision.reason).toBe("paused");
    });
  });

  test("disabled never runs and never even seeds state", async () => {
    await withRepo(async (repo) => {
      const decision = await gate(repo, NOW, { enabled: false });
      expect(decision.run).toBe(false);
      expect(decision.reason).toBe("disabled");
      expect(await Bun.file(curatorStatePath(repo)).exists()).toBe(false);
    });
  });

  test("a torn state file is treated as a fresh repo, never an exception", async () => {
    await withRepo(async (repo) => {
      await mkdir(join(repo, ".argus"), { recursive: true });
      await Bun.write(curatorStatePath(repo), "{half-written");
      const decision = await gate(repo, NOW);
      expect(decision.reason).toBe("seeded-deferred");
      expect((await readCuratorState(repo)).last_run_at).toBe(
        new Date(NOW).toISOString(),
      );
    });
  });

  test("recordRun is the only thing that bumps the clock and the run count", async () => {
    await withRepo(async (repo) => {
      await gate(repo, NOW);
      const at = new Date(NOW + WEEK).toISOString();
      const state = await recordRun(repo, {
        at,
        summary: "2 archived, 1 consolidated",
        reportPath: ".argus/reports/curator/20260831T120000Z",
      });

      expect(state.last_run_at).toBe(at);
      expect(state.run_count).toBe(1);
      expect(state.last_run_summary).toBe("2 archived, 1 consolidated");
      expect(state.last_report_path).toBe(
        ".argus/reports/curator/20260831T120000Z",
      );
      expect((await gate(repo, NOW + WEEK)).run).toBe(false);
    });
  });

  test("the state write is atomic — no temp file is left behind", async () => {
    await withRepo(async (repo) => {
      await gate(repo, NOW);
      const entries = await readdir(join(repo, ".argus"));
      expect(entries).toEqual(["curator_state.json"]);
    });
  });
});
