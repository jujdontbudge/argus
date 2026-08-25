import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createFullScenarioRegistry,
  registerAllScenarios,
} from "./all-scenarios.ts";
import { createScenarioRegistry, runScenarios } from "./index.ts";
import { registerArchiverScenarios } from "../eyes/archiver/scenarios.ts";
import { registerDigestScenarios } from "../eyes/digest/scenarios.ts";
import { registerHermesScenarios } from "../tailing/hermes-scenarios.ts";

const checkout = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");

/**
 * One assertion per contributing ticket per slot. These are the strings that
 * disappear when a registrar overwrites a half instead of chaining onto it,
 * so they are the actual regression guard — "all ten slots implemented" is
 * not, because a lossy composition still fills all ten.
 */
const CONTRIBUTED: Record<number, string[]> = {
  1: [
    "USER.md stayed byte-identical", // #30 reviewer
    "the session's digest was written with narrative", // #31 digest
    "every autonomous-batch message reached the archive", // #26 archiver
    "Hermes-side messages reached the normalized stream", // #23 hermes
    "Codex autonomous-session messages fed the normalized stream", // #22 codex
  ],
  2: [
    "Johan is the observable Honcho peer", // #28 bindings
    "Johan's mid-session directive classifies Johan-authored via takeover", // #25
    "USER.md learned from the takeover directive", // #30 reviewer
    "the digest frontmatter carries johan_touched: true", // #31 digest
    "the takeover directive was logged as a Johan-peer observation", // #32 honcho
    "exactly one scope-drift retro was filed for the hijacked ticket session", // #38
    "the in-scope refactor in ticket #9's session filed NOTHING", // #38
  ],
  3: [
    "exactly one retro was filed for the rogue work", // #33 retro
    "rogue Codex session attributed to the sandbox repo", // #22 codex
  ],
  4: [
    "every registry-logged send classifies Hermes-authored", // #25
    "Hermes-authored assistant output never classifies Johan", // #23 hermes
  ],
  5: [
    "the documented failure mode: an unlogged send reads as a Johan takeover", // #25
  ],
  6: [
    "reviewer restarted after death", // #29 supervisor
    "kill-before-commit backfill has the exact message count with no duplicates", // #26
    "a removed repo made its real watcher exit cleanly", // #39 watch command
  ],
  7: [
    "the finished session surfaced status=done in INDEX.md", // #31 digest
    "hooks promptly wrote finish and block event files", // #34 events
  ],
  8: [
    "the novel procedure was written as a SKILL.md under .argus/skills", // #30
    "the planted stale skill is gone from the live skills tree", // #35 curator
  ],
  9: [
    "repos bind separate Honcho workspaces", // #28 bindings
    "Johan's representation contains only Johan-authored messages", // #32 honcho
  ],
  10: [
    "peer .argus state stayed byte-identical", // #27 up
  ],
};

describe("the full SPEC §13 suite", () => {
  test("registers all ten scenario slots", () => {
    const slots = createFullScenarioRegistry().list();

    expect(slots).toHaveLength(10);
    expect(slots.filter(({ status }) => status === "unimplemented")).toEqual([]);
  });

  test("a lossy registration order silently drops halves", async () => {
    // The build map merged #23 (hermes) and #26 (archiver) before #31
    // (digest). Both EXTEND slot 1; digest OVERWRITES it. Register in that
    // order and the two earlier halves are gone, with every slot still
    // reporting "implemented".
    const lossy = createScenarioRegistry();
    registerHermesScenarios(lossy);
    registerArchiverScenarios(lossy);
    registerDigestScenarios(lossy);

    expect(
      lossy.list().find(({ number }) => number === 1)?.status,
    ).toBe("implemented");

    const reports = await runScenarios({
      checkout,
      reportDirectory: await mkdtemp(join(tmpdir(), "argus-lossy-")),
      scenarios: [{ name: "1 (lossy order)", scenario: lossy.get(1)! }],
    });
    const descriptions = reports[0]!.assertions.map(
      ({ description }) => description,
    );
    await rm(reports[0]!.reportPath, { force: true });

    expect(reports[0]!.status).toBe("passed");
    expect(descriptions).not.toContain(
      "Hermes-side messages reached the normalized stream",
    );
    expect(descriptions).not.toContain(
      "every autonomous-batch message reached the archive",
    );
  }, 120_000);

  test(
    "all ten scenarios pass with every ticket's half still asserted",
    async () => {
      const registry = createScenarioRegistry();
      registerAllScenarios(registry);
      const reportDirectory = await mkdtemp(join(tmpdir(), "argus-suite-"));

      try {
        const reports = await runScenarios({
          checkout,
          reportDirectory,
          scenarios: registry
            .list()
            .map(({ number, title }) => ({
              name: `${number}. ${title}`,
              scenario: registry.get(number)!,
            })),
        });

        for (const report of reports) {
          const slot = Number.parseInt(report.name, 10);
          const failed = report.assertions.filter(({ passed }) => !passed);
          expect({
            slot,
            error: report.error,
            failed: failed.map(({ description }) => description),
            status: report.status,
          }).toEqual({ slot, error: null, failed: [], status: "passed" });
          expect(report.up.exitCode).toBe(0);
          expect(report.teardown).toBe("completed");

          const descriptions = report.assertions.map(
            ({ description }) => description,
          );
          for (const contributed of CONTRIBUTED[slot] ?? []) {
            expect({ slot, contributed, present: descriptions.includes(contributed) })
              .toEqual({ slot, contributed, present: true });
          }
        }
      } finally {
        await rm(reportDirectory, { force: true, recursive: true });
      }
    },
    300_000,
  );
});
