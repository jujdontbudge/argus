import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  createScenarioRegistry,
  runScenario,
  type ScenarioHandler,
} from "../harness/index.ts";
import {
  hermesAutonomousBatchScenario,
  hermesPoisoningScenario,
  registerHermesScenarios,
} from "./hermes-scenarios.ts";

const checkout = fileURLToPath(new URL("../..", import.meta.url));

async function runInSandbox(name: string, scenario: ScenarioHandler) {
  const reportDirectory = await mkdtemp(join(tmpdir(), "argus-hermes-report-"));
  try {
    return await runScenario({ checkout, name, reportDirectory, scenario });
  } finally {
    await rm(reportDirectory, { force: true, recursive: true });
  }
}

describe("§13 Hermes state.db scenarios", () => {
  test("registration extends only this source's scenario 1 and 4 slots", async () => {
    const registry = createScenarioRegistry();
    let priorOneRan = false;
    let priorFourRan = false;
    registry.register(1, () => {
      priorOneRan = true;
    });
    registry.register(4, () => {
      priorFourRan = true;
    });

    registerHermesScenarios(registry);

    const status = new Map(registry.list().map((slot) => [slot.number, slot.status]));
    expect(status.get(1)).toBe("implemented");
    expect(status.get(4)).toBe("implemented");
    const result = await runInSandbox("hermes-composed-scenarios", async (context) => {
      await registry.get(1)!(context);
      await registry.get(4)!(context);
    });
    expect(result.status).toBe("passed");
    expect(priorOneRan).toBe(true);
    expect(priorFourRan).toBe(true);
  }, 180_000);

  test("scenario 1 Hermes half feeds its messages into the normalized stream", async () => {
    const result = await runInSandbox(
      "hermes-autonomous-stream",
      hermesAutonomousBatchScenario,
    );
    expect(result.status).toBe("passed");
    expect(result.assertions.map(({ description }) => description)).toContain(
      "Hermes-side messages reached the normalized stream",
    );
  }, 180_000);

  test("scenario 4 Hermes half proves Hermes-authored output never becomes Johan", async () => {
    const result = await runInSandbox(
      "hermes-poisoning-provenance",
      hermesPoisoningScenario,
    );
    expect(result.status).toBe("passed");
    expect(result.assertions.map(({ description }) => description)).toContain(
      "Hermes-authored assistant output never classifies Johan",
    );
  }, 180_000);
});
