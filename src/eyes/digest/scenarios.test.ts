import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createScenarioRegistry, runScenario } from "../../harness/index.ts";
import { registerProvenanceScenarios } from "../../provenance";
import { registerReviewerScenarios } from "../reviewer/scenarios";
import {
  digestAutonomousBatchScenario,
  digestTakeoverScenario,
  registerDigestScenarios,
  signalPathsScenario,
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

describe("§13 digest scenarios in the harness registry", () => {
  test("registerDigestScenarios fills slot 7 and extends slots 1 and 2", () => {
    const registry = createScenarioRegistry();
    registerProvenanceScenarios(registry);
    registerReviewerScenarios(registry);
    registerDigestScenarios(registry);

    const status = new Map(registry.list().map((slot) => [slot.number, slot.status]));
    // Only THIS ticket's slots: whole-registry lists drift as parallel tickets merge.
    expect(status.get(1)).toBe("implemented");
    expect(status.get(2)).toBe("implemented");
    expect(status.get(7)).toBe("implemented");
  });

  test("scenario 1 — autonomous batch: reviewer half AND digests + INDEX updated", async () => {
    const result = await runInSandbox(
      "digest-autonomous-batch",
      digestAutonomousBatchScenario(),
    );
    expect(result.error).toBeNull();
    expect(result.status).toBe("passed");
    const descriptions = result.assertions.map(({ description }) => description);
    expect(descriptions).toContain("USER.md stayed byte-identical");
    expect(descriptions).toContain("the session's digest was written with narrative");
    expect(descriptions).toContain("INDEX.md gained the session's one line");
  }, 180_000);

  test("scenario 2 — takeover: earlier halves AND johan_touched: true in the digest", async () => {
    const result = await runInSandbox("digest-takeover", digestTakeoverScenario());
    expect(result.error).toBeNull();
    expect(result.status).toBe("passed");
    const descriptions = result.assertions.map(({ description }) => description);
    expect(descriptions).toContain("USER.md learned from the takeover directive");
    expect(descriptions).toContain("the digest frontmatter carries johan_touched: true");
    expect(descriptions).toContain("INDEX.md surfaces johan_touched=true");
  }, 180_000);

  test("scenario 7 — signal paths: status flips surface via the digest with hooks disabled", async () => {
    const result = await runInSandbox("digest-signal-paths", signalPathsScenario());
    expect(result.error).toBeNull();
    expect(result.status).toBe("passed");
    const descriptions = result.assertions.map(({ description }) => description);
    expect(descriptions).toContain("no push event files exist — hooks are disabled");
    expect(descriptions).toContain(
      "the pending batch was due within the digest cadence (the poll interval bound)",
    );
    expect(descriptions).toContain("the finished session surfaced status=done in INDEX.md");
    expect(descriptions).toContain(
      "the blocked session surfaced status=blocked in INDEX.md",
    );
  }, 180_000);
});
