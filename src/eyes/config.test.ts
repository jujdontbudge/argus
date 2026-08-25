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
