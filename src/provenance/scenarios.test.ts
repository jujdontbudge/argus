import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createScenarioRegistry, runScenario } from "../harness/index.ts";
import {
  poisoningScenario,
  registerProvenanceScenarios,
  takeoverScenario,
  unloggedSendScenario,
} from "./scenarios";

const checkout = fileURLToPath(new URL("../..", import.meta.url));

describe("§13 provenance scenarios in the harness registry", () => {
  test("registerProvenanceScenarios fills exactly slots 2, 4 and 5", () => {
    const registry = createScenarioRegistry();
    registerProvenanceScenarios(registry);

    const byNumber = new Map(registry.list().map((slot) => [slot.number, slot.status]));
    expect(byNumber.get(2)).toBe("implemented");
    expect(byNumber.get(4)).toBe("implemented");
    expect(byNumber.get(5)).toBe("implemented");
    expect(
      registry
        .list()
        .filter(({ status }) => status === "unimplemented")
        .map(({ number }) => number),
    ).toEqual([1, 3, 6, 7, 8]);
    expect(registry.get(2)).toBeFunction();
  });

  test("scenario 2 — fake-Johan takeover: Johan-authored + johan_touched", async () => {
    const reportDirectory = await mkdtemp(join(tmpdir(), "argus-reports-"));
    try {
      const result = await runScenario({
        checkout,
        name: "provenance-takeover",
        reportDirectory,
        scenario: takeoverScenario(),
      });
      expect(result.error).toBeNull();
      expect(result.status).toBe("passed");
      expect(result.assertions.map(({ description }) => description)).toContain(
        "johan_touched is set on the session after the takeover",
      );
    } finally {
      await rm(reportDirectory, { force: true, recursive: true });
    }
  }, 180_000);

  test("scenario 4 — poisoning: registry-logged nudges never classify Johan", async () => {
    const reportDirectory = await mkdtemp(join(tmpdir(), "argus-reports-"));
    try {
      const result = await runScenario({
        checkout,
        name: "provenance-poisoning",
        reportDirectory,
        scenario: poisoningScenario(),
      });
      expect(result.error).toBeNull();
      expect(result.status).toBe("passed");
      expect(result.assertions.map(({ description }) => description)).toContain(
        "no user-side message classified Johan — USER.md stays untouched",
      );
    } finally {
      await rm(reportDirectory, { force: true, recursive: true });
    }
  }, 180_000);

  test("scenario 5 — unlogged send: the fault is visible, never silent", async () => {
    const reportDirectory = await mkdtemp(join(tmpdir(), "argus-reports-"));
    try {
      const result = await runScenario({
        checkout,
        name: "provenance-unlogged-send",
        reportDirectory,
        scenario: unloggedSendScenario(),
      });
      expect(result.error).toBeNull();
      expect(result.status).toBe("passed");
      expect(result.assertions.map(({ description }) => description)).toContain(
        "the unlogged landing is not silently absorbed as Hermes",
      );
      expect(result.assertions.map(({ description }) => description)).toContain(
        "a logged send that never lands expires as a loud audit",
      );
    } finally {
      await rm(reportDirectory, { force: true, recursive: true });
    }
  }, 180_000);
});
