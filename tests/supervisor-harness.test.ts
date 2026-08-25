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
      const descriptions = result.assertions.map(({ description }) => description);
      expect(descriptions).toContain("all five real eye commands started");
      for (const eye of ["reviewer", "archiver", "honcho", "digest", "retro"]) {
        expect(descriptions).toContain(`${eye} restarted after death`);
      }
      expect(descriptions).toContain(
        "the replacement archiver observed a transcript written after restart",
      );
      expect(descriptions).toContain("supervisor stopped every real eye command");
    } finally {
      await rm(reportDirectory, { force: true, recursive: true });
    }
  }, 90_000);
});
