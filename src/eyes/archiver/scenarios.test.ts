import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createScenarioRegistry,
  runScenario,
  type ScenarioHandler,
} from "../../harness/index.ts";
import {
  archiveAutonomousBatchScenario,
  archiverWatcherDeathScenario,
  registerArchiverScenarios,
} from "./scenarios";

const checkout = fileURLToPath(new URL("../../..", import.meta.url));

async function runInSandbox(name: string, scenario: ScenarioHandler) {
  const reportDirectory = await mkdtemp(join(tmpdir(), "argus-reports-"));
  try {
    return await runScenario({ checkout, name, reportDirectory, scenario });
  } finally {
    await rm(reportDirectory, { force: true, recursive: true });
  }
}

describe("§13 archiver scenarios in the harness registry", () => {
  test("registerArchiverScenarios extends only slots 1 and 6", async () => {
    const registry = createScenarioRegistry();
    let priorOneRan = false;
    registry.register(1, ({ assert }) => {
      priorOneRan = true;
      assert(true, "pre-existing scenario 1 half ran");
    });
    registerArchiverScenarios(registry);

    const status = new Map(registry.list().map((slot) => [slot.number, slot.status]));
    expect(status.get(1)).toBe("implemented");
    expect(status.get(6)).toBe("implemented");

    const result = await runInSandbox("archiver-registered-slot-1", registry.get(1)!);
    expect(result.status).toBe("passed");
    expect(priorOneRan).toBe(true);
    expect(result.assertions.map(({ description }) => description)).toContain(
      "archive grew during the autonomous batch",
    );
  }, 180_000);

  test("scenario 6 archiver half backfills a killed batch with an exact no-dup count", async () => {
    const result = await runInSandbox(
      "archiver-watcher-death",
      archiverWatcherDeathScenario,
    );

    expect(result.error).toBeNull();
    expect(result.status).toBe("passed");
    expect(result.assertions.map(({ description }) => description)).toContain(
      "kill-before-commit backfill has the exact message count with no duplicates",
    );
  }, 180_000);

  test("scenario 1 archiver half is independently executable", async () => {
    const result = await runInSandbox(
      "archiver-autonomous-batch",
      archiveAutonomousBatchScenario,
    );

    expect(result.error).toBeNull();
    expect(result.status).toBe("passed");
    expect(result.assertions.map(({ description }) => description)).toContain(
      "archive grew during the autonomous batch",
    );
  }, 180_000);
});
