import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createScenarioRegistry, runScenario } from "../../harness/index.ts";
import {
  registerRetroScenarios,
  rogueSessionScenario,
  scopeDriftScenario,
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

describe("slot 3 composes with halves other tickets register", () => {
  test("a scenario 3 already in the registry still runs, then the retro half", async () => {
    const registry = createScenarioRegistry();
    let priorRan = false;
    registry.register(3, () => {
      priorRan = true;
    });

    registerRetroScenarios(registry);
    const composed = registry.get(3)!;
    const result = await runInSandbox("retro-composed-slot-3", composed);

    expect(priorRan).toBe(true);
    expect(result.status).toBe("passed");
    expect(result.assertions.map(({ description }) => description)).toContain(
      "exactly one retro was filed for the rogue work",
    );
  }, 300_000);
});

describe("§13 scope-drift scenario in the harness registry (#38)", () => {
  test("registerRetroScenarios fills slot 2 as well as slot 3", () => {
    const registry = createScenarioRegistry();
    registerRetroScenarios(registry);

    const slots = registry.list().filter((entry) => entry.number === 2 || entry.number === 3);
    // Only THIS ticket's slots: whole-registry lists drift as tickets merge.
    expect(slots).toEqual([
      { number: 2, status: "implemented", title: "Fake-Johan takeover" },
      { number: 3, status: "implemented", title: "Rogue session" },
    ]);
  });

  test("a scenario 2 already in the registry still runs, then the drift half", async () => {
    const registry = createScenarioRegistry();
    let priorRan = false;
    registry.register(2, () => {
      priorRan = true;
    });

    registerRetroScenarios(registry);
    const result = await runInSandbox("retro-composed-slot-2", registry.get(2)!);

    expect(priorRan).toBe(true);
    expect(result.error).toBeNull();
    expect(result.status).toBe("passed");
  }, 300_000);

  test("scenario 2 — fake-Johan hijacks a REGISTERED ticket session: drift is filed, in-scope work is not", async () => {
    const result = await runInSandbox("retro-scope-drift", scopeDriftScenario());

    expect(result.error).toBeNull();
    expect(result.status).toBe("passed");
    const descriptions = result.assertions.map(({ description }) => description);
    expect(descriptions).toContain(
      "exactly one scope-drift retro was filed for the hijacked ticket session",
    );
    expect(descriptions).toContain(
      "it is a sub-issue of the ticket it drifted from (#7)",
    );
    expect(descriptions).toContain("the body names the ticket and quotes its stated scope");
    expect(descriptions).toContain("the body describes the out-of-scope work concretely");
    expect(descriptions).toContain(
      "the in-scope refactor in ticket #9's session filed NOTHING",
    );
    expect(descriptions).toContain("the same drift is not filed twice");
    expect(result.assertions.every(({ passed }) => passed)).toBe(true);
  }, 300_000);
});
