/**
 * Per-scenario assertion transcript for the §13 suite — the evidence behind
 * the acceptance verdict table (#45).
 *
 * `all-scenarios.test.ts` proves the composition is lossless, but it only
 * reports pass/fail. A verdict table needs to name what each slot actually
 * asserted, so this runs the same composed registry and prints every
 * assertion, per slot, in order.
 *
 * This is a reporting script. It adds no assertions of its own and is not
 * part of the `bun test` gate.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFullScenarioRegistry } from "../../src/harness/all-scenarios.ts";
import { runScenarios } from "../../src/harness/index.ts";

const checkout = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const registry = createFullScenarioRegistry();
const reportDirectory = await mkdtemp(join(tmpdir(), "argus-evidence-"));
const smoke = Bun.env.ARGUS_ACCEPTANCE_SMOKE === "1";
const slots = registry.list();
const smokeSlot = slots.find(({ number }) => number === 10);
const selectedSlots = smoke ? (smokeSlot === undefined ? [] : [smokeSlot]) : slots;
if (
  selectedSlots.length === 0 ||
  selectedSlots.some(({ number, status }) =>
    status !== "implemented" || registry.get(number) === undefined
  )
) {
  throw new Error("the selected evidence scenario is not implemented");
}

console.log("=".repeat(78));
console.log(
  smoke
    ? "ARGUS §13 SCENARIO EVIDENCE SMOKE"
    : "ARGUS §13 SCENARIO EVIDENCE — ticket #45 re-acceptance",
);
console.log("=".repeat(78));
console.log(`checkout ${checkout}`);
console.log("");

try {
  const started = Date.now();
  const reports = await runScenarios({
    checkout,
    reportDirectory,
    scenarios: selectedSlots.map(({ number, title }) => ({
      name: `${number}. ${title}`,
      scenario: registry.get(number)!,
    })),
  });

  let totalAssertions = 0;
  for (const report of reports) {
    const failed = report.assertions.filter(({ passed }) => !passed);
    totalAssertions += report.assertions.length;
    console.log("-".repeat(78));
    console.log(
      `${report.name}  ->  ${report.status.toUpperCase()}  ` +
        `(${report.assertions.length} assertions, ${failed.length} failed)`,
    );
    console.log(
      `  argus up exit ${report.up.exitCode} | teardown ${report.teardown}` +
        `${report.error === null ? "" : ` | error ${String(report.error)}`}`,
    );
    console.log("-".repeat(78));
    for (const assertion of report.assertions) {
      console.log(`  ${assertion.passed ? "PASS" : "FAIL"}  ${assertion.description}`);
    }
    console.log("");
  }

  console.log("=".repeat(78));
  console.log("SUMMARY");
  console.log("=".repeat(78));
  for (const report of reports) {
    console.log(
      `  ${report.status.padEnd(6)}  ${String(report.assertions.length).padStart(3)} assertions  ${report.name}`,
    );
  }
  console.log(
    `\n  ${reports.length} scenarios, ${totalAssertions} assertions, ` +
      `${reports.filter(({ status }) => status !== "passed").length} not passing, ` +
      `${((Date.now() - started) / 1000).toFixed(1)}s`,
  );
} finally {
  await rm(reportDirectory, { force: true, recursive: true });
}
