import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadEyesConfig } from "./config";

async function withRepo(
  body: (repo: string) => Promise<void>,
): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), "argus-eyes-config-"));
  try {
    await body(repo);
  } finally {
    await rm(repo, { force: true, recursive: true });
  }
}

describe("eyes config (ADR-0002 values, defaults in code)", () => {
  test("defaults apply when .argus/config.yaml is absent", async () => {
    await withRepo(async (repo) => {
      const config = await loadEyesConfig(repo);
      expect(config).toEqual({
        brain: {
          model: "gpt-5.6-luna",
          reasoningEffort: "low",
          maxConcurrency: 2,
        },
        reviewer: { quietWindowSeconds: 30, maxWaitSeconds: 300 },
        digest: { quietWindowSeconds: 30, maxWaitSeconds: 120 },
        retro: { quietWindowSeconds: 60, maxWaitSeconds: 600 },
        curator: {
          enabled: true,
          intervalHours: 168,
          staleAfterDays: 30,
          archiveAfterDays: 90,
        },
        dispatch: { maxConcurrency: 3 },
      });
    });
  });

  test("defaults apply when the config file is the argus-up template (all comments)", async () => {
    await withRepo(async (repo) => {
      await mkdir(join(repo, ".argus"), { recursive: true });
      await Bun.write(
        join(repo, ".argus/config.yaml"),
        "# Argus per-repo overrides.\n# reviewer:\n#   quiet_window_seconds: 5\n",
      );
      const config = await loadEyesConfig(repo);
      expect(config.reviewer.quietWindowSeconds).toBe(30);
    });
  });

  test("uncommented overrides win over defaults, untouched keys keep defaults", async () => {
    await withRepo(async (repo) => {
      await mkdir(join(repo, ".argus"), { recursive: true });
      await Bun.write(
        join(repo, ".argus/config.yaml"),
        [
          "brain:",
          "  model: gpt-5.7-nova",
          "  max_concurrency: 1",
          "reviewer:",
          "  quiet_window_seconds: 10",
          "",
        ].join("\n"),
      );
      const config = await loadEyesConfig(repo);
      expect(config.brain.model).toBe("gpt-5.7-nova");
      expect(config.brain.maxConcurrency).toBe(1);
      expect(config.brain.reasoningEffort).toBe("low");
      expect(config.reviewer.quietWindowSeconds).toBe(10);
      expect(config.reviewer.maxWaitSeconds).toBe(300);
    });
  });

  test("malformed values fall back to defaults instead of crashing the eye", async () => {
    await withRepo(async (repo) => {
      await mkdir(join(repo, ".argus"), { recursive: true });
      await Bun.write(
        join(repo, ".argus/config.yaml"),
        "reviewer:\n  quiet_window_seconds: soon\n  max_wait_seconds: -5\n",
      );
      const config = await loadEyesConfig(repo);
      expect(config.reviewer).toEqual({
        quietWindowSeconds: 30,
        maxWaitSeconds: 300,
      });
    });
  });
});

describe("the curator block (ticket #35)", () => {
  test("a repo can disable the weekly pass and retune its thresholds", async () => {
    await withRepo(async (repo) => {
      await mkdir(join(repo, ".argus"), { recursive: true });
      await Bun.write(
        join(repo, ".argus/config.yaml"),
        [
          "curator:",
          "  enabled: false",
          "  interval_hours: 24",
          "  stale_after_days: 14",
          "  archive_after_days: 60",
          "",
        ].join("\n"),
      );
      expect((await loadEyesConfig(repo)).curator).toEqual({
        enabled: false,
        intervalHours: 24,
        staleAfterDays: 14,
        archiveAfterDays: 60,
      });
    });
  });

  test("a nonsense value falls back to its default rather than taking the eye down", async () => {
    await withRepo(async (repo) => {
      await mkdir(join(repo, ".argus"), { recursive: true });
      await Bun.write(
        join(repo, ".argus/config.yaml"),
        "curator:\n  enabled: maybe\n  archive_after_days: -3\n",
      );
      const { curator } = await loadEyesConfig(repo);
      expect(curator.enabled).toBe(true);
      expect(curator.archiveAfterDays).toBe(90);
    });
  });
});

describe("dispatch concurrency (SPEC §7.3.3: cap 3, a config knob) — #56", () => {
  test("the default is SPEC's 3, not the brain's 2 — they are different budgets", async () => {
    await withRepo(async (repo) => {
      const config = await loadEyesConfig(repo);
      expect(config.dispatch.maxConcurrency).toBe(3);
      expect(config.brain.maxConcurrency).toBe(2);
    });
  });

  test("dispatch.max_concurrency is read from .argus/config.yaml", async () => {
    await withRepo(async (repo) => {
      await mkdir(join(repo, ".argus"), { recursive: true });
      await Bun.write(
        join(repo, ".argus/config.yaml"),
        "dispatch:\n  max_concurrency: 5\n",
      );
      const config = await loadEyesConfig(repo);
      expect(config.dispatch.maxConcurrency).toBe(5);
      expect(config.brain.maxConcurrency).toBe(2);
    });
  });

  test("raising dispatch concurrency does not raise the brain budget, or the reverse", async () => {
    await withRepo(async (repo) => {
      await mkdir(join(repo, ".argus"), { recursive: true });
      await Bun.write(
        join(repo, ".argus/config.yaml"),
        "brain:\n  max_concurrency: 8\ndispatch:\n  max_concurrency: 1\n",
      );
      const config = await loadEyesConfig(repo);
      expect(config.dispatch.maxConcurrency).toBe(1);
      expect(config.brain.maxConcurrency).toBe(8);
    });
  });

  test("a nonsense cap falls back to 3 rather than taking dispatch down", async () => {
    await withRepo(async (repo) => {
      await mkdir(join(repo, ".argus"), { recursive: true });
      await Bun.write(
        join(repo, ".argus/config.yaml"),
        "dispatch:\n  max_concurrency: banana\n",
      );
      expect((await loadEyesConfig(repo)).dispatch.maxConcurrency).toBe(3);
    });
  });
});
