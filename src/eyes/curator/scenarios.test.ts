import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createScenarioRegistry, runScenario } from "../../harness/index.ts";
import { registerReviewerScenarios } from "../reviewer/scenarios";
import { registerCuratorScenarios } from "./scenarios";

const checkout = fileURLToPath(new URL("../../..", import.meta.url));

async function runInSandbox(
  name: string,
  scenario: Parameters<typeof runScenario>[0]["scenario"],
): Promise<Awaited<ReturnType<typeof runScenario>>> {
  const reportDirectory = await mkdtemp(join(tmpdir(), "argus-reports-"));
  try {
    return await runScenario({ checkout, name, reportDirectory, scenario });
  } finally {
    await rm(reportDirectory, { force: true, recursive: true });
  }
}

describe("§13 scenario 8 — the curator half of the self-learning loop", () => {
  const slot8 = (registry: ReturnType<typeof createScenarioRegistry>): string | undefined =>
    registry.list().find(({ number }) => number === 8)?.status;

  test("registerCuratorScenarios fills slot 8, with or without the Reviewer's half", () => {
    const extended = createScenarioRegistry();
    registerReviewerScenarios(extended);
    registerCuratorScenarios(extended);
    expect(slot8(extended)).toBe("implemented");

    const alone = createScenarioRegistry();
    registerCuratorScenarios(alone);
    expect(slot8(alone)).toBe("implemented");
  });

  test("registration extends whatever already holds slot 8 rather than replacing it", async () => {
    const registry = createScenarioRegistry();
    registry.register(8, () => {
      throw new Error("the existing half ran");
    });

    registerCuratorScenarios(registry);

    expect(registry.get(8)!({} as never)).rejects.toThrow("the existing half ran");
  });

  test("the curator half EXTENDS the reviewer half — both are asserted in one run", async () => {
    // Composed exactly the way production composes them: the Reviewer
    // registers slot 8 first, the curator adds its half on top.
    const registry = createScenarioRegistry();
    registerReviewerScenarios(registry);
    registerCuratorScenarios(registry);

    const result = await runInSandbox("curator-self-learning", registry.get(8)!);

    expect(result.error).toBeNull();
    expect(result.status).toBe("passed");
    const descriptions = result.assertions.map(({ description }) => description);
    // The reviewer half, unchanged and still graded.
    expect(descriptions).toContain(
      "the novel procedure was written as a SKILL.md under .argus/skills",
    );
    // The curator half.
    expect(descriptions).toContain(
      "the planted stale skill is gone from the live skills tree",
    );
    expect(descriptions).toContain(
      "the stale skill is recoverable under .archive/, never deleted",
    );
    expect(descriptions).toContain("the learned skill was left untouched");
    expect(descriptions).toContain("the pinned skill was left untouched");
    expect(descriptions).toContain(
      "a skill seen for the first time was seeded, not judged",
    );
    expect(descriptions).toContain("the first curator opportunity archived nothing");
    expect(descriptions).toContain("the pass left a report under .argus/reports/curator/");
  }, 240_000);
});
