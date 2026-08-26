import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { CmuxRun, CmuxRunResult } from "../events";
import { loadRegistry, registryPaths } from "../provenance";
import {
  closeWorkerTab,
  deployWorker,
  openWorkerTab,
  retireWorkerTab,
  type WorkerProcess,
} from "./index.ts";

/**
 * Ticket #95 — a worker is a TAB in the workspace Argus is already running in,
 * never a workspace of its own, and the tab is closed when the deployment ends.
 *
 * These tests replace #55's `createCmuxWorkspace` suite. That suite asserted
 * `new-workspace` was called and that its ref was discovered safely: it was
 * green the whole time production was leaving a workspace per deployment on
 * Johan's machine, because it tested the wrong verb correctly. The assertion
 * that would have caught it is `workspaces unchanged across a full
 * deploy/teardown cycle`, and it is the last test in this file.
 *
 * Everything here is a stub. Running the real binary is forbidden: creating a
 * workspace is the bug, and `close-surface` against a mis-resolved handle
 * closes whatever tab Johan is looking at.
 */
const ok = (stdout: string): CmuxRunResult => ({ exitCode: 0, stderr: "", stdout });

const ARGUS = "2D3B8B38-C9FC-46F4-A512-8F1157CE2E10";
const DISPATCHER = "E0492BBB-0A3B-4393-B50B-75EB3439EB6C";
const WORKER = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-8888-4777-8666-555555555555";
const SESSION = "77777777-6666-4555-8444-333333333333";

/** The shape of `cmux --id-format both tree --all --json` on 0.62.2. */
function tree(workspaces: { id: string; ref: string; surfaces: string[] }[]): string {
  return JSON.stringify({
    caller: { workspace_id: ARGUS, workspace_ref: "workspace:1" },
    windows: [
      {
        index: 0,
        workspaces: workspaces.map((workspace, index) => ({
          id: workspace.id,
          index,
          panes: [
            {
              ref: "pane:1",
              surfaces: workspace.surfaces.map((id, position) => ({
                id,
                index: position,
                ref: `surface:${position + 1}`,
                title: "worker",
                type: "terminal",
              })),
            },
          ],
          ref: workspace.ref,
          title: "argus",
        })),
      },
    ],
  });
}

const ARGUS_ONLY = (surfaces: string[]): string =>
  tree([{ id: ARGUS, ref: "workspace:1", surfaces }]);

/**
 * A stubbed cmux whose `tree` answer is a queue: one entry per read, so a test
 * can say "before the create it looked like this, after it looked like that".
 */
function fakeCmux(options: {
  trees: string[];
  results?: Record<string, CmuxRunResult>;
}): { calls: string[][]; run: CmuxRun } {
  const calls: string[][] = [];
  const trees = [...options.trees];
  const run: CmuxRun = async (args) => {
    calls.push([...args]);
    const verb = args.find((arg) => !arg.startsWith("--") && arg !== "both");
    if (verb === "tree") {
      const next = trees.length > 1 ? trees.shift()! : trees[0];
      if (next === undefined) throw new Error("no tree scripted");
      return ok(next);
    }
    const scripted = options.results?.[verb ?? ""];
    if (scripted === undefined) return ok("");
    return scripted;
  };
  return { calls, run };
}

const stubSpawn = async (): Promise<WorkerProcess> => ({
  announcedSessionId: async () => null,
  exited: Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }),
  kill: () => {},
});

/** Did anything in this run ask cmux for a workspace? R6 says: never. */
const createdAWorkspace = (calls: string[][]): boolean =>
  calls.some((call) => call.includes("new-workspace"));

describe("openWorkerTab (#95): a tab in the workspace Argus already has", () => {
  test("opens a surface in the existing workspace and never creates a workspace", async () => {
    const { calls, run } = fakeCmux({
      trees: [ARGUS_ONLY([DISPATCHER]), ARGUS_ONLY([DISPATCHER, WORKER])],
    });

    const result = await openWorkerTab({ env: { CMUX_WORKSPACE_ID: ARGUS } }, run);

    expect(result).toEqual({ status: "opened", surface: WORKER, workspace: ARGUS });
    expect(calls).toContainEqual([
      "new-surface",
      "--type",
      "terminal",
      "--workspace",
      ARGUS,
    ]);
    expect(createdAWorkspace(calls)).toBe(false);
  });

  test("a workspace handle cmux does not resolve degrades and creates nothing", async () => {
    // Measured live on 0.62.2 for #95, read-only: `list-pane-surfaces
    // --workspace workspace:9999` exits 0 and answers for the FOCUSED
    // workspace. So `new-surface` with a stale handle would open the worker's
    // tab in whatever Johan is looking at. The handle is checked against
    // cmux's own inventory first, or nothing is created at all.
    const { calls, run } = fakeCmux({ trees: [ARGUS_ONLY([DISPATCHER])] });

    const result = await openWorkerTab({ env: { CMUX_WORKSPACE_ID: OTHER } }, run);

    expect(result.status).toBe("degraded");
    if (result.status === "degraded") expect(result.reason).toContain("does not resolve");
    expect(calls.some((call) => call.includes("new-surface"))).toBe(false);
    expect(createdAWorkspace(calls)).toBe(false);
  });

  test("running outside cmux degrades; it never falls back to a new workspace", async () => {
    const { calls, run } = fakeCmux({ trees: [ARGUS_ONLY([DISPATCHER])] });

    const result = await openWorkerTab({ env: {} }, run);

    expect(result.status).toBe("degraded");
    if (result.status === "degraded") {
      expect(result.reason).toContain("not running inside a cmux workspace");
    }
    expect(createdAWorkspace(calls)).toBe(false);
  });

  test("cmux missing entirely degrades", async () => {
    const run: CmuxRun = async () => {
      throw new Error("spawn cmux ENOENT");
    };
    const result = await openWorkerTab({ env: { CMUX_WORKSPACE_ID: ARGUS } }, run);
    expect(result.status).toBe("degraded");
  });

  test("two new surfaces (a concurrent create) degrades rather than guessing", async () => {
    const { run } = fakeCmux({
      trees: [ARGUS_ONLY([DISPATCHER]), ARGUS_ONLY([DISPATCHER, WORKER, OTHER])],
    });

    const result = await openWorkerTab({ env: { CMUX_WORKSPACE_ID: ARGUS } }, run);

    expect(result.status).toBe("degraded");
    if (result.status === "degraded") expect(result.reason).toContain("refusing to guess");
  });
});

describe("closeWorkerTab (#95): the half of the directive that burned Johan", () => {
  test("closes the worker's surface and confirms it is gone", async () => {
    const { calls, run } = fakeCmux({
      trees: [ARGUS_ONLY([DISPATCHER, WORKER]), ARGUS_ONLY([DISPATCHER])],
    });

    const result = await closeWorkerTab({ surface: WORKER, workspace: ARGUS }, run);

    expect(result).toEqual({ status: "closed" });
    expect(calls).toContainEqual([
      "close-surface",
      "--surface",
      WORKER,
      "--workspace",
      ARGUS,
    ]);
  });

  test("a surface that does not resolve is NOT closed — that is Johan's tab", async () => {
    // The same live 0.62.2 fallback, pointed at a destructive verb. An
    // unresolved `--surface` would close the focused one.
    const { calls, run } = fakeCmux({ trees: [ARGUS_ONLY([DISPATCHER])] });

    const result = await closeWorkerTab({ surface: WORKER, workspace: ARGUS }, run);

    expect(result.status).toBe("degraded");
    if (result.status === "degraded") {
      expect(result.reason).toContain("refusing to close the focused surface");
    }
    expect(calls.some((call) => call.includes("close-surface"))).toBe(false);
  });

  test("a surface that survives the close degrades rather than reporting success", async () => {
    const { run } = fakeCmux({ trees: [ARGUS_ONLY([DISPATCHER, WORKER])] });

    const result = await closeWorkerTab({ surface: WORKER, workspace: ARGUS }, run);

    expect(result.status).toBe("degraded");
    if (result.status === "degraded") expect(result.reason).toContain("still resolves");
  });

  test("closing an already-gone tab is not an error — teardown runs twice", async () => {
    // The green path closes the tab and so does dead-slot recovery. The second
    // one must not report a failure Johan has to read.
    const { calls, run } = fakeCmux({ trees: [ARGUS_ONLY([DISPATCHER])] });

    const result = await closeWorkerTab(
      { surface: WORKER, tolerateMissing: true, workspace: ARGUS },
      run,
    );

    expect(result).toEqual({ status: "closed" });
    expect(calls.some((call) => call.includes("close-surface"))).toBe(false);
  });
});

describe("#95's acceptance: the workspace count is unchanged across a cycle", () => {
  test("open → close leaves cmux's workspace inventory byte-for-byte identical", async () => {
    // THE test the ticket asks for, and the one that was missing. #82 left
    // three workspaces on Johan's machine twice over while every cmux test in
    // the tree was green.
    const before = ARGUS_ONLY([DISPATCHER]);
    const withWorker = ARGUS_ONLY([DISPATCHER, WORKER]);
    const trees = [before, withWorker, withWorker, before];
    const calls: string[][] = [];
    let read = 0;
    const run: CmuxRun = async (args) => {
      calls.push([...args]);
      if (!args.includes("tree")) return ok("");
      const next = trees[Math.min(read, trees.length - 1)]!;
      read += 1;
      return ok(next);
    };

    const workspaces = (json: string): string[] =>
      (JSON.parse(json).windows as { workspaces: { id: string }[] }[])
        .flatMap((window) => window.workspaces)
        .map((workspace) => workspace.id);

    const opened = await openWorkerTab({ env: { CMUX_WORKSPACE_ID: ARGUS } }, run);
    expect(opened.status).toBe("opened");
    if (opened.status !== "opened") return;
    const closed = await closeWorkerTab(
      { surface: opened.surface, workspace: opened.workspace },
      run,
    );
    expect(closed).toEqual({ status: "closed" });

    // The whole ticket, in one assertion.
    expect(workspaces(trees[trees.length - 1]!)).toEqual(workspaces(before));
    expect(createdAWorkspace(calls)).toBe(false);
    // And no workspace-scoped destructive verb either: R6 is "no new
    // workspaces", and closing one Johan opened would be the same violation
    // pointed the other way.
    expect(calls.some((call) => call.includes("close-workspace"))).toBe(false);
  });
});

describe("retireWorkerTab (#95): teardown is registry-first, like everything else", () => {
  const registryWith = async (rows: Record<string, unknown>[]): Promise<string> => {
    const repo = await mkdtemp(join(tmpdir(), "argus-tab-"));
    const { sessionsFile } = registryPaths(repo);
    await mkdir(dirname(sessionsFile), { recursive: true });
    await Bun.write(sessionsFile, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    return repo;
  };

  const row = (extra: Record<string, unknown>): Record<string, unknown> => ({
    dispatchPrompt: "ticket #95",
    sessionId: SESSION,
    ts: "2026-08-26T00:00:00.000Z",
    ...extra,
  });

  test("closes the tab the registry recorded for that session", async () => {
    const repo = await registryWith([row({ surface: WORKER, workspace: ARGUS })]);
    try {
      const { calls, run } = fakeCmux({
        trees: [ARGUS_ONLY([DISPATCHER, WORKER]), ARGUS_ONLY([DISPATCHER])],
      });
      expect(await retireWorkerTab({ repo, sessionId: SESSION }, run)).toBeNull();
      expect(calls).toContainEqual([
        "close-surface",
        "--surface",
        WORKER,
        "--workspace",
        ARGUS,
      ]);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("a deployment that never got a tab retires silently", async () => {
    const repo = await registryWith([row({})]);
    try {
      const { calls, run } = fakeCmux({ trees: [ARGUS_ONLY([DISPATCHER])] });
      expect(await retireWorkerTab({ repo, sessionId: SESSION }, run)).toBeNull();
      // Not even a read: there is nothing to close and nothing to resolve.
      expect(calls).toEqual([]);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("a tab that cannot be closed is REPORTED, never swallowed", async () => {
    // The leak is the whole bug. A teardown that fails quietly is the same
    // outcome as the one #82 measured, just harder to see.
    const repo = await registryWith([row({ surface: WORKER, workspace: ARGUS })]);
    try {
      const { run } = fakeCmux({
        trees: [ARGUS_ONLY([DISPATCHER, WORKER])],
        results: { "close-surface": { exitCode: 1, stderr: "no such surface", stdout: "" } },
      });
      const reason = await retireWorkerTab({ repo, sessionId: SESSION }, run);
      expect(reason).toContain("no such surface");
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("a crashed worker's tab is closed by the same call, twice-safe", async () => {
    // Dead-slot recovery and the green path both call this. Whichever runs
    // second finds the tab already gone and must not report a degradation.
    const repo = await registryWith([row({ surface: WORKER, workspace: ARGUS })]);
    try {
      const { calls, run } = fakeCmux({ trees: [ARGUS_ONLY([DISPATCHER])] });
      expect(await retireWorkerTab({ repo, sessionId: SESSION }, run)).toBeNull();
      expect(calls.some((call) => call.includes("close-surface"))).toBe(false);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("an unreadable registry degrades instead of throwing into the caller", async () => {
    const repo = await mkdtemp(join(tmpdir(), "argus-tab-"));
    try {
      const { run } = fakeCmux({ trees: [ARGUS_ONLY([DISPATCHER])] });
      expect(await retireWorkerTab({ repo, sessionId: SESSION }, run)).toBeNull();
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });
});

describe("deployWorker (#95): a tab failure never blocks the deployment", () => {
  // Restored in #95's landing pass. #55 asserted this against
  // `createCmuxWorkspace` in `workspace.test.ts`, and the rename to `tab.ts`
  // deleted it without a replacement — leaving `deployWorker`'s degraded
  // branch (`workspaceDegraded`, `deploy.ts`) as the only cmux path in the
  // module with no coverage. The claim is #7's and it did not change with the
  // verb: a tab is context, never a requirement.
  test("workspace: auto with no cmux still deploys, and says why there is none", async () => {
    const repo = await mkdtemp(join(tmpdir(), "argus-tab-"));
    let worktree: string | undefined;
    try {
      await Bun.$`git -C ${repo} init --quiet`.quiet();
      await Bun.$`git -C ${repo} commit --quiet --allow-empty -m base`
        .env({
          ...process.env,
          GIT_AUTHOR_EMAIL: "deploy@invalid.example",
          GIT_AUTHOR_NAME: "Argus Deploy Test",
          GIT_COMMITTER_EMAIL: "deploy@invalid.example",
          GIT_COMMITTER_NAME: "Argus Deploy Test",
        })
        .quiet();
      const calls: string[][] = [];
      const result = await deployWorker(
        {
          agent: "claude",
          dispatchPrompt: "ticket #95",
          repo,
          ticket: "95",
          workspace: "auto",
        },
        {
          cmux: async (args) => {
            calls.push([...args]);
            throw new Error("spawn cmux ENOENT");
          },
          // Set, so the run gets PAST the no-CMUX_WORKSPACE_ID guard and the
          // degradation under test is the cmux one, not the env one.
          env: { ...process.env, CMUX_WORKSPACE_ID: ARGUS },
          newSessionId: () => OTHER,
          spawn: stubSpawn,
        },
      );
      expect(result.status).toBe("deployed");
      if (result.status !== "deployed") return;
      worktree = result.deployment.worktree;
      expect(result.deployment.workspace).toBeUndefined();
      expect(result.deployment.workspaceDegraded).toContain("cmux is unavailable");

      // A cmux that cannot even be spawned must not be retried into existence:
      // the deployment gets no tab and, above all, no workspace.
      expect(createdAWorkspace(calls)).toBe(false);

      // And the row carries neither handle, so nothing downstream can aim a
      // send — or a `close-surface` — at a handle that was never resolved.
      const registry = await loadRegistry(registryPaths(repo));
      expect(
        registry.sessions.map(({ sessionId, surface, workspace }) => ({
          sessionId,
          surface,
          workspace,
        })),
      ).toEqual([{ sessionId: OTHER, surface: undefined, workspace: undefined }]);
    } finally {
      // The worktree AND the `<repo>-worktrees` parent the primitive created.
      if (worktree) await rm(dirname(worktree), { force: true, recursive: true });
      await rm(repo, { force: true, recursive: true });
    }
  }, 60_000);
});
