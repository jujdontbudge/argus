import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { createScenarioRegistry, runScenario } from "../../harness/index.ts";
import {
  honchoSemanticIsolationScenario,
  honchoTakeoverScenario,
  registerHonchoScenarios,
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

describe("§13 Honcho-eye scenarios", () => {
  test("registerHonchoScenarios extends its own slots 2 and 9", () => {
    const registry = createScenarioRegistry();
    registerHonchoScenarios(registry);

    const status = new Map(registry.list().map((slot) => [slot.number, slot.status]));
    expect(status.get(2)).toBe("implemented");
    expect(status.get(9)).toBe("implemented");
    expect(registry.get(2)).toBeFunction();
    expect(registry.get(9)).toBeFunction();
  });

  test("scenario 2 logs the takeover as a Johan peer observation", async () => {
    const result = await runInSandbox("honcho-takeover", honchoTakeoverScenario());

    expect(result.error).toBeNull();
    expect(result.status).toBe("passed");
    const descriptions = result.assertions.map(({ description }) => description);
    expect(descriptions).toContain(
      "johan_touched is set on the session after the takeover",
    );
    expect(descriptions).toContain(
      "the takeover directive was logged as a Johan-peer observation",
    );
  }, 180_000);

  test("scenario 9 derives Johan only from Johan-authored routed messages", async () => {
    const result = await runInSandbox(
      "honcho-semantic-isolation",
      honchoSemanticIsolationScenario(),
    );

    expect(result.error).toBeNull();
    expect(result.status).toBe("passed");
    expect(result.assertions.map(({ description }) => description)).toContain(
      "Johan's representation contains only Johan-authored messages",
    );
  }, 180_000);
});
