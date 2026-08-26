import { describe, expect, test } from "bun:test";

import { createCmuxSend, type CmuxRun } from "./notify.ts";

/**
 * Ticket #7 — the production cmux seam, measured against a real cmux 0.62.2.
 *
 * `sendWithCmux` had no test at all, and the live probe found why that
 * mattered: on 0.62.2 an UNRESOLVABLE handle is not an error. Both
 *
 *   cmux send --workspace workspace:9999 -- <text>
 *   cmux read-screen --surface surface:99999
 *
 * exit 0 and act on the FOCUSED workspace instead — so a stale mission
 * workspace in the registry does not degrade, it types an `[argus]` line into
 * whatever human or worker session happens to be selected, and reports
 * `sent`. That is §6 delivery failing silently and §5's poisoning hazard in
 * one call.
 *
 * The seam therefore resolves the handle FIRST, against cmux's own listing,
 * and refuses to type when it does not resolve. Refusing surfaces as
 * `ok: false`, which `notifyMissionControl` already turns into the durable
 * `ARGUS EVENT DELIVERY DEGRADED` line — the event file is untouched either
 * way.
 */
const LIST = "  workspace:14  argus\n* workspace:1  selected one\n";
const SURFACES = "* surface:79  Argus loop monitoring\n  surface:84  argus-dispatcher\n";

function recorder(
  responses: (args: readonly string[]) => { exitCode: number; stdout?: string; stderr?: string },
): { calls: string[][]; run: CmuxRun } {
  const calls: string[][] = [];
  const run: CmuxRun = async (args) => {
    calls.push([...args]);
    const response = responses(args);
    return {
      exitCode: response.exitCode,
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
    };
  };
  return { calls, run };
}

describe("cmux send seam", () => {
  test("types and enters when the workspace resolves", async () => {
    const { calls, run } = recorder((args) =>
      args[0] === "list-workspaces" ? { exitCode: 0, stdout: LIST } : { exitCode: 0 },
    );

    const result = await createCmuxSend(run)({
      workspace: "workspace:14",
      text: "[argus] claude-code session s1 finished",
    });

    expect(result).toEqual({ ok: true });
    expect(calls).toEqual([
      ["list-workspaces"],
      ["send", "--workspace", "workspace:14", "--", "[argus] claude-code session s1 finished"],
      ["send-key", "--workspace", "workspace:14", "--", "enter"],
    ]);
  });

  test("refuses to type when the workspace does not resolve", async () => {
    const { calls, run } = recorder((args) =>
      args[0] === "list-workspaces" ? { exitCode: 0, stdout: LIST } : { exitCode: 0 },
    );

    const result = await createCmuxSend(run)({
      workspace: "workspace:9999",
      text: "[argus] must never reach the focused workspace",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("workspace:9999");
    // The whole point: nothing was typed anywhere.
    expect(calls).toEqual([["list-workspaces"]]);
  });

  test("refuses to type when the surface does not resolve", async () => {
    const { calls, run } = recorder((args) => {
      if (args[0] === "list-workspaces") return { exitCode: 0, stdout: LIST };
      if (args[0] === "list-pane-surfaces") return { exitCode: 0, stdout: SURFACES };
      return { exitCode: 0 };
    });

    const result = await createCmuxSend(run)({
      workspace: "workspace:14",
      surface: "surface:99999",
      text: "[argus] must never reach the focused surface",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("surface:99999");
    expect(calls.map((call) => call[0])).toEqual([
      "list-workspaces",
      "list-pane-surfaces",
    ]);
  });

  test("targets the surface when both it and its workspace resolve", async () => {
    const { calls, run } = recorder((args) => {
      if (args[0] === "list-workspaces") return { exitCode: 0, stdout: LIST };
      if (args[0] === "list-pane-surfaces") return { exitCode: 0, stdout: SURFACES };
      return { exitCode: 0 };
    });

    const result = await createCmuxSend(run)({
      workspace: "workspace:14",
      surface: "surface:84",
      text: "[argus] codex session s2 blocked on a human",
    });

    expect(result).toEqual({ ok: true });
    expect(calls.slice(2)).toEqual([
      ["send", "--surface", "surface:84", "--", "[argus] codex session s2 blocked on a human"],
      ["send-key", "--surface", "surface:84", "--", "enter"],
    ]);
  });

  test("degrades when cmux itself cannot be reached", async () => {
    const { run } = recorder(() => ({
      exitCode: 1,
      stderr: "cmux: could not connect to socket",
    }));

    const result = await createCmuxSend(run)({
      workspace: "workspace:14",
      text: "[argus] anything",
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("could not connect");
  });

  test("reports a failing send-key rather than claiming delivery", async () => {
    const { run } = recorder((args) => {
      if (args[0] === "list-workspaces") return { exitCode: 0, stdout: LIST };
      if (args[0] === "send-key") return { exitCode: 3, stderr: "send-key exploded" };
      return { exitCode: 0 };
    });

    const result = await createCmuxSend(run)({
      workspace: "workspace:14",
      text: "[argus] anything",
    });

    expect(result).toEqual({ ok: false, error: "send-key exploded" });
  });
});
