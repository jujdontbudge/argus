import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CmuxRun, CmuxRunResult } from "../events";
import { loadRegistry, registryPaths } from "../provenance";
import { createCmuxWorkspace, deployWorker, type WorkerProcess } from "./index.ts";

/**
 * Ticket #55 — cmux is 0.62.2 on this machine PERMANENTLY, so every assertion
 * here is about degrading rather than about working. A workspace is optional
 * context; a deployment that cannot get one still deploys.
 *
 * The second theme is #7's live hazard: 0.62.2's `new-workspace` prints no
 * ref, and an unresolvable handle exits 0 and acts on the FOCUSED workspace.
 * So a ref is only ever accepted when cmux's own listing grew by exactly one.
 */
const ok = (stdout: string): CmuxRunResult => ({ exitCode: 0, stderr: "", stdout });

function fakeCmux(script: Record<string, CmuxRunResult | (() => CmuxRunResult)>): {
  calls: string[][];
  run: CmuxRun;
} {
  const calls: string[][] = [];
  const run: CmuxRun = async (args) => {
    calls.push([...args]);
    const entry = script[args[0] ?? ""];
    if (entry === undefined) throw new Error(`unscripted cmux ${args.join(" ")}`);
    return typeof entry === "function" ? entry() : entry;
  };
  return { calls, run };
}

const stubSpawn = async (): Promise<WorkerProcess> => ({
  announcedSessionId: async () => null,
  exited: Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }),
  kill: () => {},
});

describe("createCmuxWorkspace (#55): optional context, never a dependency", () => {
  test("the new ref is discovered from cmux's own listing, never guessed", async () => {
    let listed = 0;
    const { run } = fakeCmux({
      "list-workspaces": () => {
        listed += 1;
        return ok(
          listed === 1
            ? "* workspace:14  argus\n"
            : "* workspace:14  argus\n  workspace:15  argus-ticket-55\n",
        );
      },
      "new-workspace": ok(""),
    });
    expect(await createCmuxWorkspace({ cwd: "/tmp/wt" }, run)).toEqual({
      status: "created",
      workspace: "workspace:15",
    });
  });

  test("no new ref (or two) degrades rather than guessing a handle", async () => {
    const { run } = fakeCmux({
      "list-workspaces": ok("* workspace:14  argus\n"),
      "new-workspace": ok(""),
    });
    const result = await createCmuxWorkspace({ cwd: "/tmp/wt" }, run);
    expect(result.status).toBe("degraded");
    if (result.status === "degraded") expect(result.reason).toContain("refusing to guess");
  });

  test("cmux missing entirely degrades", async () => {
    const run: CmuxRun = async () => {
      throw new Error("spawn cmux ENOENT");
    };
    const result = await createCmuxWorkspace({ cwd: "/tmp/wt" }, run);
    expect(result.status).toBe("degraded");
  });
});

describe("deployWorker (#55): a workspace failure never blocks the deployment", () => {
  test("workspace: auto with no cmux still deploys, and says why there is none", async () => {
    const repo = await mkdtemp(join(tmpdir(), "argus-ws-"));
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
      const result = await deployWorker(
        {
          agent: "claude",
          dispatchPrompt: "ticket #55",
          repo,
          ticket: "55",
          workspace: "auto",
        },
        {
          cmux: async () => {
            throw new Error("spawn cmux ENOENT");
          },
          newSessionId: () => "99999999-8888-4777-8666-555555555555",
          spawn: stubSpawn,
        },
      );
      expect(result.status).toBe("deployed");
      if (result.status !== "deployed") return;
      worktree = result.deployment.worktree;
      expect(result.deployment.workspace).toBeUndefined();
      expect(result.deployment.workspaceDegraded).toContain("cmux is unavailable");

      // And the row carries no workspace field, so nothing downstream can aim
      // a send at a handle that was never resolved.
      const registry = await loadRegistry(registryPaths(repo));
      expect(registry.sessions.map(({ sessionId, workspace }) => ({ sessionId, workspace })))
        .toEqual([{ sessionId: "99999999-8888-4777-8666-555555555555", workspace: undefined }]);
    } finally {
      if (worktree) await rm(worktree, { force: true, recursive: true });
      await rm(repo, { force: true, recursive: true });
    }
  }, 60_000);
});
