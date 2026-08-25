import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createScenarioRegistry, runScenario } from "../../harness/index.ts";
import { registerRetroScenarios, rogueSessionScenario } from "./scenarios";

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

describe("§13 retro scenarios in the harness registry", () => {
  test("registerRetroScenarios fills slot 3", () => {
    const registry = createScenarioRegistry();
    registerRetroScenarios(registry);

    const slot = registry.list().find((entry) => entry.number === 3);
    // Only THIS ticket's slot: whole-registry lists drift as tickets merge.
    expect(slot).toEqual({
      number: 3,
      status: "implemented",
      title: "Rogue session",
    });
  });

  test("scenario 3 — rogue session: a closed retro sub-issue with the right parent", async () => {
    const result = await runInSandbox("retro-rogue-session", rogueSessionScenario());

    expect(result.error).toBeNull();
    expect(result.status).toBe("passed");
    const descriptions = result.assertions.map(({ description }) => description);
    expect(descriptions).toContain("exactly one retro was filed for the rogue work");
    expect(descriptions).toContain("the retro was filed CLOSED (no approval queue)");
    expect(descriptions).toContain(
      "it is a sub-issue of the nearest plausible parent (#15)",
    );
    expect(descriptions).toContain("the body reflects Johan's prompts");
    expect(descriptions).toContain("the body reflects the diff and cites the commit");
    expect(descriptions).toContain(
      "the registered ticket session's own work filed no retro",
    );
    expect(result.assertions.every(({ passed }) => passed)).toBe(true);
  }, 300_000);
});
