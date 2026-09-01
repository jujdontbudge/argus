import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_GRILL_MODEL, loadGrillConfig, resolveGrillModel } from "./config.ts";

describe("grill model config (#165)", () => {
  test("defaults every grill mode to Fable", async () => {
    const repo = await mkdtemp(join(tmpdir(), "argus-grill-config-"));
    try {
      expect((await loadGrillConfig(repo)).model).toBe(DEFAULT_GRILL_MODEL);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("reads grill.model from the repo config", async () => {
    const repo = await mkdtemp(join(tmpdir(), "argus-grill-config-"));
    try {
      await mkdir(join(repo, ".argus"));
      await Bun.write(
        join(repo, ".argus", "config.yaml"),
        "grill:\n  model: claude-opus-5\n",
      );
      expect((await loadGrillConfig(repo)).model).toBe("claude-opus-5");
      expect(await resolveGrillModel(repo)).toBe("claude-opus-5");
      expect(await resolveGrillModel(repo, "claude-fable-5")).toBe("claude-fable-5");
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });
});
