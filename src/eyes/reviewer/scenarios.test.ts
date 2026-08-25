import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createScenarioRegistry, runScenario } from "../../harness/index.ts";
import { registerProvenanceScenarios } from "../../provenance";
import {
  autonomousBatchScenario,
  registerReviewerScenarios,
  reviewerTakeoverScenario,
  selfLearningScenario,
} from "./scenarios";

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

describe("§13 reviewer scenarios in the harness registry", () => {
  test("registerReviewerScenarios fills slots 1 and 8 and extends slot 2", () => {
    const registry = createScenarioRegistry();
    registerProvenanceScenarios(registry);
    registerReviewerScenarios(registry);

    const status = new Map(registry.list().map((slot) => [slot.number, slot.status]));
    expect(status.get(1)).toBe("implemented");
    expect(status.get(2)).toBe("implemented");
    expect(status.get(8)).toBe("implemented");
    expect(
      registry
        .list()
        .filter(({ status: slotStatus }) => slotStatus === "unimplemented")
        .map(({ number }) => number),
    ).toEqual([3, 6, 7]);
  });

  test("scenario 1 — autonomous batch: USER.md byte-identical, MEMORY.md gains facts", async () => {
    const result = await runInSandbox(
      "reviewer-autonomous-batch",
      autonomousBatchScenario(),
    );
    expect(result.error).toBeNull();
    expect(result.status).toBe("passed");
    const descriptions = result.assertions.map(({ description }) => description);
    expect(descriptions).toContain("USER.md stayed byte-identical");
    expect(descriptions).toContain("MEMORY.md gained a project fact");
  }, 180_000);

  test("scenario 2 — takeover: provenance half AND the reviewer half (USER.md learns)", async () => {
    const result = await runInSandbox(
      "reviewer-takeover",
      reviewerTakeoverScenario(),
    );
    expect(result.error).toBeNull();
    expect(result.status).toBe("passed");
    const descriptions = result.assertions.map(({ description }) => description);
    expect(descriptions).toContain(
      "johan_touched is set on the session after the takeover",
    );
    expect(descriptions).toContain("USER.md learned from the takeover directive");
  }, 180_000);

  test("scenario 8 — self-learning loop: a repeated novel procedure becomes a skill", async () => {
    const result = await runInSandbox(
      "reviewer-self-learning",
      selfLearningScenario(),
    );
    expect(result.error).toBeNull();
    expect(result.status).toBe("passed");
    expect(result.assertions.map(({ description }) => description)).toContain(
      "the novel procedure was written as a SKILL.md under .argus/skills",
    );
  }, 180_000);
});
