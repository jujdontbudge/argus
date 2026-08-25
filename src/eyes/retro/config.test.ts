import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_EYES_CONFIG, loadEyesConfig } from "../config";

async function withRepo(body: (repo: string) => Promise<void>): Promise<void> {
  const repo = await mkdtemp(join(tmpdir(), "argus-retro-config-"));
  try {
    await body(repo);
  } finally {
    await rm(repo, { force: true, recursive: true });
  }
}

describe("the retro eye's cadence knob", () => {
  test("defaults to the slowest cadence of the eyes — it files tickets, not notes", async () => {
    await withRepo(async (repo) => {
      const config = await loadEyesConfig(repo);
      expect(config.retro).toEqual({ quietWindowSeconds: 60, maxWaitSeconds: 600 });
      expect(config.retro.maxWaitSeconds).toBeGreaterThan(
        DEFAULT_EYES_CONFIG.digest.maxWaitSeconds,
      );
    });
  });

  test("`.argus/config.yaml` overrides the retro cadence like any other eye", async () => {
    await withRepo(async (repo) => {
      await mkdir(join(repo, ".argus"), { recursive: true });
      await Bun.write(
        join(repo, ".argus/config.yaml"),
        "retro:\n  quiet_window_seconds: 5\n  max_wait_seconds: 9\n",
      );
      const config = await loadEyesConfig(repo);
      expect(config.retro).toEqual({ quietWindowSeconds: 5, maxWaitSeconds: 9 });
    });
  });
});
