import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CmuxRun, CmuxRunResult } from "../events";
import { appendSessionRow, loadRegistry, registryPaths } from "../provenance";
import { parseGrillArgs } from "../cli.ts";
import { startGrill } from "./index.ts";
import { fakeMachine } from "./machine.fixture.ts";

const WORKSPACE = "2D3B8B38-C9FC-46F4-A512-8F1157CE2E10";
const DISPATCHER = "E0492BBB-0A3B-4393-B50B-75EB3439EB6C";
const GRILL = "AAAA1111-2222-4333-8444-555555555555";
const SESSION = "11111111-2222-4333-8444-555555555555";

const ok = (stdout = ""): CmuxRunResult => ({ exitCode: 0, stderr: "", stdout });

function inventory(surfaces: string[]): string {
  return JSON.stringify({
    windows: [
      {
        workspaces: [
          {
            id: WORKSPACE,
            ref: "workspace:1",
            panes: [{ surfaces: surfaces.map((id, index) => ({ id, ref: `surface:${index + 1}` })) }],
          },
        ],
      },
    ],
  });
}

function cmuxStub(): CmuxRun {
  let surfaces = [DISPATCHER];
  let launch = "";
  return async (args) => {
    const verb = args.find((argument) => !argument.startsWith("--") && argument !== "both");
    if (verb === "tree") return ok(inventory(surfaces));
    if (verb === "list-workspaces") return ok();
    if (verb === "new-surface") {
      surfaces = [DISPATCHER, GRILL];
      return ok();
    }
    if (verb === "send") {
      launch = args.at(-1) ?? "";
      return ok();
    }
    if (verb === "send-key") {
      const child = Bun.spawn(["/bin/zsh", "-c", launch], {
        stderr: "ignore",
        stdout: "ignore",
      });
      child.unref();
      return ok();
    }
    if (verb === "rename-tab" || verb === "notify") return ok();
    throw new Error(`unscripted cmux ${args.join(" ")}`);
  };
}

describe("grill ticket ownership (#167)", () => {
  test("parses the owning ticket flag", () => {
    expect(
      parseGrillArgs(["scope drift", "--ticket", "167", "--mode", "spec", "--dry-run"]),
    ).toEqual({
      dryRun: true,
      mode: "spec",
      ticket: "167",
      topic: "scope drift",
    });
  });

  test("writes the owning ticket on a new row and preserves existing rows", async () => {
    const machine = await fakeMachine();
    const oldRow = {
      ts: "2026-08-30T12:00:00.000Z",
      sessionId: "old-session",
      dispatchPrompt: "an existing session",
    };
    await appendSessionRow(registryPaths(machine.repo).sessionsFile, oldRow);

    try {
      const result = await startGrill(
        { repo: machine.repo, ticket: "167", topic: "scope drift" },
        {
          cmux: cmuxStub(),
          env: { ...process.env, CMUX_WORKSPACE_ID: WORKSPACE },
          git: async () => ({ exitCode: 0, stderr: "", stdout: "main\n" }),
          manifestFile: machine.manifest,
          newSessionId: () => SESSION,
          now: () => new Date("2026-08-31T12:00:00.000Z"),
        },
      );

      expect(result.status).toBe("started");
      const sessions = (await loadRegistry(registryPaths(machine.repo))).sessions;
      expect(sessions[0]).toEqual(oldRow);
      expect(sessions.at(-1)?.ticket).toBe("167");
      expect(result.status === "started" && result.prompt).toContain("owning ticket is #167");
      expect(result.status === "started" && result.prompt).not.toContain(
        "It has no ticket, on purpose",
      );
    } finally {
      await rm(machine.root, { force: true, recursive: true });
    }
  });
});
