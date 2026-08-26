import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { MessageEvent } from "../tailing";
import {
  classifierFromRegistry,
  loadRegistry,
  registryPaths,
  type ProvenanceRecord,
} from "../provenance";
import {
  deployWorker,
  type DeployWorkerOptions,
  type WorkerProcess,
  type WorkerSpawnRequest,
} from "./index.ts";

/**
 * Ticket #55 — the write-then-spawn ordering, proven from the OUTSIDE.
 *
 * SPEC §5 rule 1 is an ORDERING requirement, not a bookkeeping one: Hermes
 * records every deployment BEFORE the session starts, so that a prompt can
 * never land in a transcript before the registry can explain who sent it.
 * A test that only checks "a row exists afterwards" passes just as happily
 * when the two are swapped, so every ordering assertion below is made from
 * inside the spawn seam, reading the registry file off disk at the exact
 * instant the agent process would start.
 */
async function scratchRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "argus-deploy-"));
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
  return repo;
}

/** What the registry file said at the moment spawn() was entered. */
interface SpawnWitness {
  calls: WorkerSpawnRequest[];
  sessionsAtSpawn: string[];
}

function witnessSpawn(
  repo: string,
  announce?: string | null,
): { witness: SpawnWitness; spawn: NonNullable<DeployWorkerOptions["spawn"]> } {
  const witness: SpawnWitness = { calls: [], sessionsAtSpawn: [] };
  const spawn = async (request: WorkerSpawnRequest): Promise<WorkerProcess> => {
    witness.calls.push(request);
    const file = Bun.file(registryPaths(repo).sessionsFile);
    witness.sessionsAtSpawn.push((await file.exists()) ? await file.text() : "");
    return {
      announcedSessionId: async () => announce ?? null,
      exited: Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }),
      kill: () => {},
      pid: 4242,
    };
  };
  return { witness, spawn };
}

/** Real `git` under this machine's load swings; 5s is not a signal. */
const GIT_BUDGET_MS = 60_000;

const DISPATCH = "You are working ticket #55. Build the deployment primitive.";

describe("deployWorker (#55): the deployment is durable before the agent starts", () => {
  test("a preassigned-id route writes sessions.jsonl BEFORE it spawns", async () => {
    const repo = await scratchRepo();
    try {
      const { witness, spawn } = witnessSpawn(repo);
      const result = await deployWorker(
        { agent: "claude", dispatchPrompt: DISPATCH, repo, ticket: "55" },
        { newSessionId: () => "11111111-2222-4333-8444-555555555555", spawn },
      );
      expect(result.status).toBe("deployed");
      if (result.status !== "deployed") return;

      // THE ORDERING PROOF. This is the registry as another process would have
      // read it at the instant the agent was started. Swap the write and the
      // spawn and this string is empty.
      const seen = witness.sessionsAtSpawn[0] ?? "";
      const row = JSON.parse(seen.trim()) as Record<string, unknown>;
      expect(row.sessionId).toBe("11111111-2222-4333-8444-555555555555");
      expect(row.dispatchPrompt).toBe(DISPATCH);
      expect(row.ticket).toBe("55");
      expect(row.agent).toBe("claude");

      // And the id Argus chose is the one the agent is told to use, so the
      // registry row and the transcript are the same session (§5 rule 3).
      expect(witness.calls[0]?.command).toContain(
        "11111111-2222-4333-8444-555555555555",
      );
      expect(result.deployment.sessionId).toBe(
        "11111111-2222-4333-8444-555555555555",
      );
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  }, GIT_BUDGET_MS);

  test("a registry write that fails never spawns anything (fail closed)", async () => {
    const repo = await scratchRepo();
    try {
      // `.argus/registry` as a FILE: the append cannot create its directory.
      await mkdir(join(repo, ".argus"), { recursive: true });
      await writeFile(join(repo, ".argus/registry"), "not a directory\n");
      const { witness, spawn } = witnessSpawn(repo);
      const result = await deployWorker(
        { agent: "claude", dispatchPrompt: DISPATCH, repo, ticket: "55" },
        { spawn },
      );
      expect(result.status).toBe("failed");
      if (result.status === "failed") expect(result.stage).toBe("registry");
      expect(witness.calls).toEqual([]);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  }, GIT_BUDGET_MS);

  test("a worktree that cannot be created leaves no phantom deployment row", async () => {
    const repo = await scratchRepo();
    try {
      const { witness, spawn } = witnessSpawn(repo);
      const result = await deployWorker(
        {
          agent: "claude",
          branch: "argus/ticket-55",
          dispatchPrompt: DISPATCH,
          repo,
          ticket: "55",
          worktree: join(repo, "..", "definitely/not/creatable/because/parent/is/a/file"),
        },
        { git: async () => ({ exitCode: 128, stderr: "fatal: nope", stdout: "" }), spawn },
      );
      expect(result.status).toBe("failed");
      if (result.status === "failed") expect(result.stage).toBe("worktree");
      expect(witness.calls).toEqual([]);
      const registry = await loadRegistry(registryPaths(repo));
      expect(registry.sessions).toEqual([]);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  }, GIT_BUDGET_MS);
});

describe("deployWorker (#55): routes whose CLI assigns its own session id", () => {
  test("codex is registered under the id it announces, and only then", async () => {
    const repo = await scratchRepo();
    try {
      const announced = "01a03c64-8acb-7c40-9cf5-68ddcac45e56";
      const { witness, spawn } = witnessSpawn(repo, announced);
      const result = await deployWorker(
        { agent: "codex", dispatchPrompt: DISPATCH, repo, ticket: "55" },
        { spawn },
      );
      expect(result.status).toBe("deployed");
      if (result.status !== "deployed") return;
      expect(result.deployment.sessionId).toBe(announced);

      // Argus never invents an id for a route that assigns its own: at spawn
      // time there was no row to invent one into.
      expect(witness.sessionsAtSpawn[0]).toBe("");
      const registry = await loadRegistry(registryPaths(repo));
      expect(registry.sessions.map(({ sessionId }) => sessionId)).toContain(announced);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  }, GIT_BUDGET_MS);

  test("a codex session that never announces an id fails closed and is killed", async () => {
    const repo = await scratchRepo();
    try {
      let killed = false;
      const spawn = async (): Promise<WorkerProcess> => ({
        announcedSessionId: async () => null,
        exited: Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }),
        kill: () => {
          killed = true;
        },
      });
      const result = await deployWorker(
        { agent: "codex", dispatchPrompt: DISPATCH, repo, ticket: "55" },
        { spawn },
      );
      expect(result.status).toBe("failed");
      if (result.status === "failed") expect(result.stage).toBe("session-id");
      expect(killed).toBe(true);
      const registry = await loadRegistry(registryPaths(repo));
      expect(registry.sessions).toEqual([]);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  }, GIT_BUDGET_MS);
});

describe("deployWorker (#55): the rows satisfy the consumers that read them", () => {
  test("the dispatch prompt classifies hermes/dispatch-prompt, a typed line johan/takeover", async () => {
    const repo = await scratchRepo();
    try {
      const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
      const { spawn } = witnessSpawn(repo);
      await deployWorker(
        { agent: "claude", dispatchPrompt: DISPATCH, repo, ticket: "55" },
        { newSessionId: () => sessionId, spawn },
      );

      const { classifier } = classifierFromRegistry(
        await loadRegistry(registryPaths(repo)),
      );
      const message = (text: string, ts: string): MessageEvent => ({
        candidate: true,
        file: "/transcript.jsonl",
        promptSource: "sdk",
        role: "user",
        sessionId,
        text,
        ts,
        type: "message",
      });
      const records: ProvenanceRecord[] = [];
      for (const event of [
        message(DISPATCH, "2026-08-25T00:00:00.000Z"),
        message("actually, do it the other way", "2026-08-25T00:05:00.000Z"),
      ]) {
        const { record } = classifier.handle(event);
        if (record) records.push(record);
      }
      expect(records.map(({ author, via }) => ({ author, via }))).toEqual([
        { author: "hermes", via: "dispatch-prompt" },
        { author: "johan", via: "takeover" },
      ]);
      expect(records[0]?.ticket).toBe("55");
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  }, GIT_BUDGET_MS);
});

describe("deployWorker (#55): the worktree is real (SPEC §7.3.2)", () => {
  test("git creates a fresh linked worktree on a fresh branch", async () => {
    const repo = await scratchRepo();
    let worktree: string | undefined;
    try {
      const { spawn } = witnessSpawn(repo);
      const result = await deployWorker(
        { agent: "claude", dispatchPrompt: DISPATCH, repo, ticket: "55" },
        { spawn },
      );
      expect(result.status).toBe("deployed");
      if (result.status !== "deployed") return;
      worktree = result.deployment.worktree;
      expect(result.deployment.branch).toBe("argus/ticket-55");
      expect(await Bun.file(join(worktree, ".git")).exists()).toBe(true);
      const listed = await Bun.$`git -C ${repo} worktree list`.quiet().text();
      expect(listed).toContain("argus/ticket-55");
      // One ticket, one session: the worker's cwd is the worktree, never the repo.
      expect(await Bun.file(join(worktree, ".git")).text()).toContain("gitdir:");
    } finally {
      // The worktree AND the `<repo>-worktrees` parent the primitive created.
      if (worktree) await rm(dirname(worktree), { force: true, recursive: true });
      await rm(repo, { force: true, recursive: true });
    }
  }, GIT_BUDGET_MS);
});

/**
 * Ticket #62 extended `deployWorker` with a second checkout mode so §7.2's
 * grill could compose on this primitive instead of spawning around it. The
 * ordering is untouched; what these assert is that the new mode still FAILS
 * CLOSED in the same direction — no checkout means no row, and no row means no
 * process.
 */
describe("deployWorker checkout modes (#62)", () => {
  test('checkout "repo" writes a ticketless row and makes no worktree', async () => {
    const repo = await scratchRepo();
    try {
      const { spawn, witness } = witnessSpawn(repo);
      const result = await deployWorker(
        {
          agent: "claude",
          checkout: "repo",
          dispatchPrompt: "grill me",
          repo,
          workspaceRef: "workspace:15",
        },
        { newSessionId: () => "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee", spawn },
      );
      expect(result.status).toBe("deployed");
      if (result.status !== "deployed") return;
      expect(result.deployment.worktree).toBe(repo);
      expect(result.deployment.ticket).toBeUndefined();
      // §7.5 exempts planning and grilling, so a ticket field would be a
      // scope the Retro eye would then judge the session against.
      const row = JSON.parse(witness.sessionsAtSpawn[0]!.trim()) as Record<string, unknown>;
      expect(row.ticket).toBeUndefined();
      // A caller-supplied ref is recorded exactly as a self-created one is.
      expect(row.workspace).toBe("workspace:15");
      expect(result.deployment.workspace).toBe("workspace:15");
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("a worktree deployment without a ticket fails before any row exists", async () => {
    const repo = await scratchRepo();
    try {
      const { spawn, witness } = witnessSpawn(repo);
      const result = await deployWorker(
        { agent: "claude", dispatchPrompt: "implement it", repo },
        { spawn },
      );
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.stage).toBe("worktree");
        expect(result.reason).toContain("needs a ticket");
      }
      expect(witness.calls).toEqual([]);
      expect(await Bun.file(registryPaths(repo).sessionsFile).exists()).toBe(false);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test('checkout "repo" outside a git repository never reaches the registry', async () => {
    const notARepo = await mkdtemp(join(tmpdir(), "argus-deploy-bare-"));
    try {
      const { spawn, witness } = witnessSpawn(notARepo);
      const result = await deployWorker(
        {
          agent: "claude",
          checkout: "repo",
          dispatchPrompt: "grill me",
          repo: notARepo,
          workspaceRef: "workspace:15",
        },
        { spawn },
      );
      expect(result.status).toBe("failed");
      if (result.status === "failed") expect(result.stage).toBe("worktree");
      expect(witness.calls).toEqual([]);
      expect(await Bun.file(registryPaths(notARepo).sessionsFile).exists()).toBe(false);
    } finally {
      await rm(notARepo, { force: true, recursive: true });
    }
  });
});
