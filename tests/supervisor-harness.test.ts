import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createScenarioRegistry, runScenario } from "../src/harness/index.ts";

const checkout = fileURLToPath(new URL("..", import.meta.url));

setDefaultTimeout(90_000);

describe("supervisor harness acceptance", () => {
  test("scenario 6 kills every watcher and observes a live replacement", async () => {
    const reportDirectory = await mkdtemp(join(tmpdir(), "argus-supervisor-report-"));
    const registry = createScenarioRegistry();
    const scenario = registry.get(6);

    try {
      expect(registry.list()[5]).toEqual({
        number: 6,
        status: "implemented",
        title: "Watcher death",
      });
      expect(scenario).toBeFunction();
      const result = await runScenario({
        checkout,
        name: "watcher-death-supervisor",
        reportDirectory,
        scenario: scenario!,
      });

      expect(result.error).toBeNull();
      expect(result.status).toBe("passed");
      expect(result.assertions).toEqual([
        { description: "sandbox was converged by argus up", passed: true },
        { description: "all five watcher fixtures started", passed: true },
        { description: "reviewer restarted after death", passed: true },
        { description: "archiver restarted after death", passed: true },
        { description: "honcho restarted after death", passed: true },
        { description: "digest restarted after death", passed: true },
        { description: "retro restarted after death", passed: true },
        { description: "supervisor stopped every watcher fixture", passed: true },
      ]);
    } finally {
      await rm(reportDirectory, { force: true, recursive: true });
    }
  }, 90_000);
});
