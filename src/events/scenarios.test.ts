import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { registerDigestScenarios } from "../eyes/digest/scenarios.ts";
import { createScenarioRegistry, runScenario } from "../harness/index.ts";
import {
  eventSignalPathsScenario,
  registerEventScenarios,
} from "./scenarios.ts";

const checkout = fileURLToPath(new URL("../..", import.meta.url));

describe("§13 event push-path scenario", () => {
  test("extends the existing scenario-7 slot", () => {
    const registry = createScenarioRegistry();
    registerDigestScenarios(registry);
    registerEventScenarios(registry);

    const status = new Map(registry.list().map((slot) => [slot.number, slot.status]));
    expect(status.get(7)).toBe("implemented");
  });

  test("hooks disabled retain the digest half; hooks enabled push both events promptly", async () => {
    const reportDirectory = await mkdtemp(join(tmpdir(), "argus-event-reports-"));
    try {
      const result = await runScenario({
        checkout,
        name: "events-signal-paths",
        reportDirectory,
        scenario: eventSignalPathsScenario(),
      });

      expect(result.error).toBeNull();
      expect(result.status).toBe("passed");
      const descriptions = result.assertions.map(({ description }) => description);
      expect(descriptions).toContain("no push event files exist — hooks are disabled");
      expect(descriptions).toContain("the finished session surfaced status=done in INDEX.md");
      expect(descriptions).toContain("hooks promptly wrote finish and block event files");
      expect(descriptions).toContain("every mission-control send was logged before cmux");
    } finally {
      await rm(reportDirectory, { force: true, recursive: true });
    }
  }, 180_000);
});
