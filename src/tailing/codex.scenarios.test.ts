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
  codexAutonomousBatchScenario,
  codexRogueSessionScenario,
  registerCodexScenarios,
} from "./codex-scenarios.ts";

const checkout = fileURLToPath(new URL("../..", import.meta.url));

async function runInSandbox(name: string, scenario: ScenarioHandler) {
  const reportDirectory = await mkdtemp(join(tmpdir(), "argus-codex-report-"));
  try {
    return await runScenario({ checkout, name, reportDirectory, scenario });
  } finally {
    await rm(reportDirectory, { force: true, recursive: true });
  }
}

describe("§13 Codex rollout scenarios", () => {
  test("registration extends only this source's scenario 1 and 3 slots", async () => {
    const registry = createScenarioRegistry();
    let priorOneRan = false;
    let priorThreeRan = false;
    registry.register(1, () => {
      priorOneRan = true;
    });
    registry.register(3, () => {
      priorThreeRan = true;
    });

    registerCodexScenarios(registry);

    const status = new Map(registry.list().map((slot) => [slot.number, slot.status]));
    expect(status.get(1)).toBe("implemented");
    expect(status.get(3)).toBe("implemented");
    const result = await runInSandbox("codex-composed-scenarios", async (context) => {
      await registry.get(1)!(context);
      await registry.get(3)!(context);
    });
    expect(result.status).toBe("passed");
    expect(priorOneRan).toBe(true);
    expect(priorThreeRan).toBe(true);
  }, 180_000);

  test("scenario 1 Codex half feeds its session into the normalized stream", async () => {
    const result = await runInSandbox(
      "codex-autonomous-stream",
      codexAutonomousBatchScenario,
    );
    expect(result.status).toBe("passed");
    expect(result.assertions.map(({ description }) => description)).toContain(
      "Codex autonomous-session messages fed the normalized stream",
    );
  }, 180_000);

  test("scenario 3 Codex half attributes a rogue session to the sandbox repo", async () => {
    const result = await runInSandbox("codex-rogue-attribution", codexRogueSessionScenario);
    expect(result.status).toBe("passed");
    expect(result.assertions.map(({ description }) => description)).toContain(
      "rogue Codex session attributed to the sandbox repo",
    );
  }, 180_000);
});
