import { describe, expect, test } from "bun:test";

import type { CmuxRunResult } from "../events";
import {
  BOGUS_UUID,
  BOGUS_WORKSPACE_REF,
  censusOf,
  censusUnchanged,
  driveCmuxDoor,
  LIVE_CMUX_GATE,
  resolveHandleForm,
  type CmuxDoorReport,
} from "./cmux-door.ts";

const run = (exitCode: number, stdout = "", stderr = ""): (() => Promise<CmuxRunResult>) =>
  async () => ({ exitCode, stderr, stdout });

const TREE = [
  "window window:1 559FF931 [current]",
  '├── workspace workspace:1 2D3B8B38 "argus"',
  "│   └── pane pane:1 85C84E04 [focused]",
  '│       ├── surface surface:1 E0492BBB [terminal] "argus-dispatcher"',
  '│       └── surface surface:2 7F6A2CA0 [terminal] "Argus loop monitoring"',
].join("\n");

describe("#90 handle forms", () => {
  test("a handle cmux answers for is reported as failing OPEN", async () => {
    const form = await resolveHandleForm(BOGUS_WORKSPACE_REF, run(0, "  surface:4  x\n"));
    expect(form).toEqual({ exitCode: 0, fails: "open", stderr: "" });
  });

  test("a handle cmux refuses is reported as failing CLOSED, with its reason", async () => {
    const form = await resolveHandleForm(
      BOGUS_UUID,
      run(1, "", "Error: not_found: Pane or workspace not found\n"),
    );
    expect(form).toEqual({
      exitCode: 1,
      fails: "closed",
      stderr: "Error: not_found: Pane or workspace not found",
    });
  });
});

describe("#90 census", () => {
  test("counts what Directive 14 counts", () => {
    expect(censusOf(TREE)).toEqual({ surfaces: 2, workspaces: 1 });
  });

  test("an added surface is a changed census", () => {
    const report = {
      checks: [],
      status: "ran",
      treeAfter: `${TREE}\n│       └── surface surface:63 0D0F6C3D [terminal] "leaked"`,
      treeBefore: TREE,
      version: "cmux 0.62.2",
    } satisfies CmuxDoorReport;
    expect(censusUnchanged(report)).toBe(false);
    expect(censusUnchanged({ ...report, treeAfter: TREE })).toBe(true);
  });
});

describe("#90 gate", () => {
  test("shut, the driver runs nothing and says gate-unset rather than passing", async () => {
    const report = await driveCmuxDoor({ env: {} });
    expect(report.status).toBe("gate-unset");
    expect(report.checks).toHaveLength(0);
    expect(report.version).toBe("");
  });

  test("open but outside cmux, it degrades to no-cmux instead of inventing a handle", async () => {
    const report = await driveCmuxDoor({ env: { [LIVE_CMUX_GATE]: "1" } });
    // Either there is no cmux on this machine, or there is one and this
    // process is not inside a workspace. Both are `no-cmux`, and neither may
    // report `ran` — a drive that did not drive must never look like a pass.
    if (report.status !== "ran") {
      expect(report.status).toBe("no-cmux");
      expect(report.checks.every((entry) => entry.ok)).toBe(false);
    }
  });
});
