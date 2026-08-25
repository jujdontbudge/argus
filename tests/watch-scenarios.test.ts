import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createScenarioRegistry,
  runScenario,
} from "../src/harness/index.ts";
import { registerWatchScenarios } from "../src/watch/scenarios.ts";

const checkout = fileURLToPath(new URL("..", import.meta.url));

describe("watch §13 registration", () => {
  test("extends slot 6 and proves a removed repo stops its real watcher", async () => {
    const registry = createScenarioRegistry();
    const prior = registry.get(6);
    registerWatchScenarios(registry);
    const extended = registry.get(6);
    const reportDirectory = await mkdtemp(join(tmpdir(), "argus-watch-scenario-"));

    try {
      expect(prior).toBeFunction();
      expect(extended).toBeFunction();
      expect(extended).not.toBe(prior);
      const result = await runScenario({
        checkout,
        name: "watch-command-slot-6",
        reportDirectory,
        scenario: extended!,
      });
      expect(result.error).toBeNull();
      expect(result.status).toBe("passed");
      expect(result.assertions.map(({ description }) => description)).toContain(
        "a removed repo made its real watcher exit cleanly",
      );
    } finally {
      await rm(reportDirectory, { force: true, recursive: true });
    }
  }, 120_000);
});
