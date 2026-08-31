import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createFakeGh, type FakeGh } from "../eyes/retro/fake-gh";
import { registryPaths } from "../provenance";
import type { WorkerProcess, WorkerSpawnRequest } from "../deploy";
import { defaultDispatchPrompt, dispatchFrontier, type DispatchOptions } from "./dispatch.ts";

/**
 * Ticket #56 — the dispatcher, tested THROUGH THE DOOR PRODUCTION USES.
 *
 * The audit's core lesson (AUDIT.md §4) is that bugs survived this build
 * because tests called internals while production went through another door.
 * So every test here calls `dispatchFrontier` — the exact function `argus
 * dispatch` calls — and fakes only the three seams that would otherwise touch
 * the world: `gh`, the worker spawn, and cmux. Git is REAL: real repos, real
 * worktrees, real branches, real commits.
 *
 * In particular the cap is asserted where it has to hold — at the spawn seam.
 * A test that asserted "the config said 3" would pass for a dispatcher that
 * read the number and then span up ten sessions, which is precisely the
 * failure class this ticket exists to close.
 */
const REPO = "JohanSardar/argus";
const LOGIN = "argus-bot";
/** Real `git` under this machine's load swings; a small budget is not a signal. */
const GIT_BUDGET_MS = 120_000;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_EMAIL: "dispatch@invalid.example",
  GIT_AUTHOR_NAME: "Argus Dispatch Test",
  GIT_COMMITTER_EMAIL: "dispatch@invalid.example",
  GIT_COMMITTER_NAME: "Argus Dispatch Test",
};

async function scratchRepo(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), "argus-dispatch-"));
  await Bun.$`git -C ${repo} init --quiet`.quiet();
  await Bun.$`git -C ${repo} commit --quiet --allow-empty -m base`.env(GIT_ENV).quiet();
  return repo;
}

async function cleanup(repo: string): Promise<void> {
  await rm(repo, { force: true, recursive: true });
  await rm(`${repo}-worktrees`, { force: true, recursive: true });
}

/** What the world looked like at the instant each spawn was entered. */
interface SpawnWitness {
  calls: WorkerSpawnRequest[];
  /** The gh argv already issued when the worker process was started. */
  ghAtSpawn: string[][][];
  /** sessions.jsonl as another process would have read it, at spawn time. */
  sessionsAtSpawn: string[];
  pids: number[];
}

function witnessSpawn(
  repo: string,
  gh: FakeGh,
  pid: () => number = () => process.pid,
): { spawn: NonNullable<DispatchOptions["spawn"]>; witness: SpawnWitness } {
  const witness: SpawnWitness = {
    calls: [],
    ghAtSpawn: [],
    pids: [],
    sessionsAtSpawn: [],
  };
  const spawn = async (request: WorkerSpawnRequest): Promise<WorkerProcess> => {
    witness.calls.push(request);
    witness.ghAtSpawn.push(gh.calls.map((call) => [...call]));
    const file = Bun.file(registryPaths(repo).sessionsFile);
    witness.sessionsAtSpawn.push((await file.exists()) ? await file.text() : "");
    const spawned = pid();
    witness.pids.push(spawned);
    return {
      // codex's route is `announced` (routes.ts): it names its own session and
      // `deployWorker` registers on that announcement. A witness that never
      // announced would fail every codex dispatch at the `session-id` stage,
      // which would look exactly like a routing bug and hide the real one.
      announcedSessionId: async () =>
        request.agent === "codex" ? `01a03c64-8acb-7c40-9cf5-000000000${witness.calls.length}` : null,
      // A normal witness represents a worker that remains alive after startup.
      // Immediate exit is a distinct production failure exercised below.
      exited: new Promise(() => {}),
      kill: () => {
        throw new Error("the dispatcher must never kill a worker");
      },
      pid: spawned,
    };
  };
  return { spawn, witness };
}

/** cmux is never invoked for real in a test run; it degrades, as #7 allows. */
const noCmux: NonNullable<DispatchOptions["cmux"]> = async () => ({
  exitCode: 127,
  stderr: "cmux: command not found",
  stdout: "",
});

function options(
  repo: string,
  gh: FakeGh,
  spawn: NonNullable<DispatchOptions["spawn"]>,
  extra: Partial<DispatchOptions> = {},
): DispatchOptions {
  return { cmux: noCmux, gh: gh.run, repo, spawn, startupGraceMs: 0, ...extra };
}

async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

async function writeConfig(repo: string, body: string): Promise<void> {
  await mkdir(join(repo, ".argus"), { recursive: true });
  await writeFile(join(repo, ".argus/config.yaml"), body);
}

describe("dispatchFrontier (#56): SPEC §7.3's cap is enforced where spawning happens", () => {
  test("ten open tickets, three sessions — the fourth is never spawned", async () => {
    const repo = await scratchRepo();
    try {
      const gh = createFakeGh({ login: LOGIN, repo: REPO });
      for (let number = 1; number <= 10; number += 1) {
        gh.seed({ body: `Do ${number}.`, number, title: `Ticket ${number}` });
      }
      const { spawn, witness } = witnessSpawn(repo, gh);

      const report = await dispatchFrontier(options(repo, gh, spawn));

      expect(report.maxConcurrency).toBe(3);
      expect(witness.calls).toHaveLength(3);
      expect(report.dispatched.map((entry) => entry.ticket)).toEqual(["1", "2", "3"]);
      // The cap is a cap on WORK, so the tickets it did not reach are still
      // untouched on GitHub — not claimed, not queued, not half-started.
      for (const number of ["4", "5", "6", "7", "8", "9", "10"]) {
        expect(gh.find(number)!.assignees).toEqual([]);
      }
    } finally {
      await cleanup(repo);
    }
  }, GIT_BUDGET_MS);

  test("a second run while three workers are alive spawns NOTHING", async () => {
    const repo = await scratchRepo();
    try {
      const gh = createFakeGh({ login: LOGIN, repo: REPO });
      for (let number = 1; number <= 10; number += 1) {
        gh.seed({ number, title: `Ticket ${number}` });
      }
      const first = witnessSpawn(repo, gh);
      await dispatchFrontier(options(repo, gh, first.spawn));

      const second = witnessSpawn(repo, gh);
      const report = await dispatchFrontier(options(repo, gh, second.spawn));

      expect(second.witness.calls).toHaveLength(0);
      expect(report.inFlight).toBe(3);
      expect(report.dispatched).toEqual([]);
    } finally {
      await cleanup(repo);
    }
  }, GIT_BUDGET_MS);

  test("the cap is a REAL config knob: max_concurrency: 1 spawns exactly one", async () => {
    const repo = await scratchRepo();
    try {
      await writeConfig(repo, "dispatch:\n  max_concurrency: 1\n");
      const gh = createFakeGh({ login: LOGIN, repo: REPO });
      gh.seed({ number: 1, title: "one" });
      gh.seed({ number: 2, title: "two" });
      const { spawn, witness } = witnessSpawn(repo, gh);

      const report = await dispatchFrontier(options(repo, gh, spawn));

      expect(report.maxConcurrency).toBe(1);
      expect(witness.calls).toHaveLength(1);
      expect(gh.find("2")!.assignees).toEqual([]);
    } finally {
      await cleanup(repo);
    }
  }, GIT_BUDGET_MS);

  test("the claim and the registry row are BOTH durable before the worker starts", async () => {
    const repo = await scratchRepo();
    try {
      const gh = createFakeGh({ login: LOGIN, repo: REPO });
      // Pinned to claude (#88) because the promise this test makes is the
      // PREASSIGNED route's: only claude lets Argus name the session, so only
      // there can the row precede the process. codex names its own session and
      // its row follows the announcement — strictly weaker, and labelled so in
      // `routes.ts`. Routing a codex ticket through here would silently turn
      // this into a test of the weaker promise.
      gh.seed({
        body: "Build it.",
        labels: ["agent:claude-code"],
        number: 56,
        title: "Ship the frontier",
      });
      const { spawn, witness } = witnessSpawn(repo, gh);

      const report = await dispatchFrontier(options(repo, gh, spawn));

      expect(report.dispatched).toHaveLength(1);
      // SPEC §5 rule 1, unchanged by #56: the row is on disk at spawn time.
      const row = JSON.parse(witness.sessionsAtSpawn[0]!.trim()) as Record<
        string,
        unknown
      >;
      expect(row.ticket).toBe("56");
      expect(row.agent).toBe("claude");
      expect(String(row.dispatchPrompt)).toContain("#56");
      // SPEC §7.3.2, the new half: claim BEFORE the session exists, so no
      // second dispatcher can ever pick the same ticket up mid-spawn.
      const assigned = witness.ghAtSpawn[0]!.filter(
        (call) => call[0] === "issue" && call[1] === "edit",
      );
      expect(assigned[0]).toContain("--add-assignee");
      expect(assigned[0]).toContain(LOGIN);
      expect(gh.find("56")!.assignees).toEqual([LOGIN]);
    } finally {
      await cleanup(repo);
    }
  }, GIT_BUDGET_MS);

  test("each ticket gets its own worktree and its own fresh session", async () => {
    const repo = await scratchRepo();
    try {
      const gh = createFakeGh({ login: LOGIN, repo: REPO });
      gh.seed({ number: 1, title: "one" });
      gh.seed({ number: 2, title: "two" });
      const { spawn, witness } = witnessSpawn(repo, gh);

      const report = await dispatchFrontier(options(repo, gh, spawn));

      const worktrees = witness.calls.map((call) => call.cwd);
      expect(new Set(worktrees).size).toBe(2);
      for (const worktree of worktrees) {
        expect(worktree.startsWith(`${repo}-worktrees/`)).toBe(true);
        expect(await Bun.file(join(worktree, ".git")).exists()).toBe(true);
      }
      const sessions = report.dispatched.map((entry) => entry.sessionId);
      expect(new Set(sessions).size).toBe(2);
    } finally {
      await cleanup(repo);
    }
  }, GIT_BUDGET_MS);
});

describe("dispatchFrontier (#56): losing a claim never becomes a spawn", () => {
  test("a ticket assigned by someone else between read and claim is skipped", async () => {
    const repo = await scratchRepo();
    try {
      let stolen = false;
      const gh = createFakeGh({
        before: (args) => {
          // Another dispatcher assigns #1 in the window between the frontier
          // read and our own `issue edit`.
          if (!stolen && args[0] === "issue" && args[1] === "edit") {
            stolen = true;
            gh.find("1")!.assignees.push("another-dispatcher");
          }
        },
        login: LOGIN,
        repo: REPO,
      });
      gh.seed({ number: 1, title: "contested" });
      gh.seed({ number: 2, title: "free" });
      const { spawn, witness } = witnessSpawn(repo, gh);

      const report = await dispatchFrontier(
        options(repo, gh, spawn, { maxConcurrency: 1 }),
      );

      expect(report.skipped.map((entry) => entry.ticket)).toContain("1");
      expect(witness.calls.map((call) => call.cwd.split("/").at(-1))).toEqual([
        "ticket-2",
      ]);
      // The slot the lost claim held is given back, not leaked.
      expect(report.dispatched.map((entry) => entry.ticket)).toEqual(["2"]);
    } finally {
      await cleanup(repo);
    }
  }, GIT_BUDGET_MS);

  test("a deployment that fails releases BOTH the claim and the slot", async () => {
    const repo = await scratchRepo();
    try {
      const gh = createFakeGh({ login: LOGIN, repo: REPO });
      gh.seed({ number: 1, title: "will fail" });
      const failing: NonNullable<DispatchOptions["spawn"]> = async () => {
        throw new Error("claude: command not found");
      };

      const report = await dispatchFrontier(options(repo, gh, failing));

      expect(report.dispatched).toEqual([]);
      expect(report.skipped[0]!.ticket).toBe("1");
      expect(report.skipped[0]!.reason).toContain("command not found");
      // Back on the frontier: unassigned, and no slot is held.
      expect(gh.find("1")!.assignees).toEqual([]);
      expect(report.inFlight).toBe(0);
    } finally {
      await cleanup(repo);
    }
  }, GIT_BUDGET_MS);

  test("a worker that announces then exits immediately is recovered in the same pass", async () => {
    const repo = await scratchRepo();
    try {
      const gh = createFakeGh({ login: LOGIN, repo: REPO });
      gh.seed({ number: 1, title: "announces then dies" });
      const dead = await deadPid();
      const spawn: NonNullable<DispatchOptions["spawn"]> = async () => ({
        announcedSessionId: async () => "01a03c64-8acb-7c40-9cf5-dead00000001",
        exited: Promise.resolve({
          exitCode: 1,
          stderr: "worker rejected its startup arguments",
          stdout: "",
        }),
        kill: () => {},
        pid: dead,
      });

      const report = await dispatchFrontier(
        options(repo, gh, spawn, { maxConcurrency: 1, startupGraceMs: 10 }),
      );

      expect(report.dispatched).toEqual([]);
      expect(report.inFlight).toBe(0);
      expect(report.recovered).toContainEqual(
        expect.objectContaining({ outcome: "returned-to-frontier", ticket: "1" }),
      );
      expect(report.skipped).toContainEqual(
        expect.objectContaining({ reason: expect.stringContaining("exited 1"), ticket: "1" }),
      );
      expect(report.degraded.join("\n")).toContain("worker rejected its startup arguments");
      expect(gh.find("1")!.assignees).toEqual([]);
    } finally {
      await cleanup(repo);
    }
  }, GIT_BUDGET_MS);

  test("no login means no claim and therefore no dispatch — loudly", async () => {
    const repo = await scratchRepo();
    try {
      const gh = createFakeGh({ failUser: "gh: not authenticated", repo: REPO });
      gh.seed({ number: 1, title: "one" });
      const { spawn, witness } = witnessSpawn(repo, gh);

      const report = await dispatchFrontier(options(repo, gh, spawn));

      expect(witness.calls).toHaveLength(0);
      expect(report.degraded.join(" ")).toContain("not authenticated");
    } finally {
      await cleanup(repo);
    }
  }, GIT_BUDGET_MS);
});

describe("dispatchFrontier (#56): recovery tells a DEAD session from a SLOW one", () => {
  test("a slow worker (pid alive) keeps its ticket, its slot and its worktree", async () => {
    const repo = await scratchRepo();
    try {
      const gh = createFakeGh({ login: LOGIN, repo: REPO });
      gh.seed({ number: 1, title: "slow" });
      gh.seed({ number: 2, title: "next" });
      // A worker pid that is alive for the whole test: this process.
      const first = witnessSpawn(repo, gh, () => process.pid);
      await dispatchFrontier(options(repo, gh, first.spawn, { maxConcurrency: 1 }));

      const second = witnessSpawn(repo, gh);
      const report = await dispatchFrontier(
        options(repo, gh, second.spawn, { maxConcurrency: 1 }),
      );

      expect(report.recovered).toEqual([]);
      expect(report.inFlight).toBe(1);
      expect(second.witness.calls).toHaveLength(0);
      expect(gh.find("1")!.assignees).toEqual([LOGIN]);
    } finally {
      await cleanup(repo);
    }
  }, GIT_BUDGET_MS);

  test("#95: a DEAD worker's cmux tab is closed, and no workspace is ever created", async () => {
    // THE #82 CASE. The worker never reaches a clean completion, so nothing on
    // #57's green path ever runs — recovery is the only thing that will ever
    // touch this deployment again, and if it does not close the tab, the tab
    // leaks. That is precisely how three workspaces ended up on Johan's
    // machine, and closing them was manual work he had to do twice.
    const repo = await scratchRepo();
    const ARGUS = "2D3B8B38-C9FC-46F4-A512-8F1157CE2E10";
    const WORKER = "11111111-2222-4333-8444-555555555555";
    try {
      const gh = createFakeGh({ login: LOGIN, repo: REPO });
      gh.seed({ number: 1, title: "died with a tab open" });

      // A cmux with one workspace (Johan's) that grows a tab on `new-surface`
      // and loses it on `close-surface`. Never the real binary: creating a
      // workspace is the bug and closing a live surface is Johan's tab.
      const calls: string[][] = [];
      // Unique per create: the second pass re-dispatches the returned ticket
      // and legitimately opens a tab of its own, so "the tab is gone" has to
      // mean THIS deployment's tab, not "no worker tab exists".
      let minted = 0;
      let surfaces = ["E0492BBB-0A3B-4393-B50B-75EB3439EB6C"];
      const cmux: NonNullable<DispatchOptions["cmux"]> = async (args) => {
        calls.push([...args]);
        if (args.includes("tree")) {
          return {
            exitCode: 0,
            stderr: "",
            stdout: JSON.stringify({
              windows: [
                {
                  workspaces: [
                    {
                      id: ARGUS,
                      panes: [
                        {
                          ref: "pane:1",
                          surfaces: surfaces.map((id, index) => ({
                            id,
                            ref: `surface:${index + 1}`,
                          })),
                        },
                      ],
                      ref: "workspace:1",
                      title: "argus",
                    },
                  ],
                },
              ],
            }),
          };
        }
        if (args[0] === "new-surface") {
          minted += 1;
          surfaces = [...surfaces, `${WORKER}-${minted}`];
        }
        if (args[0] === "close-surface") {
          surfaces = surfaces.filter((id) => id !== args[args.indexOf("--surface") + 1]);
        }
        return { exitCode: 0, stderr: "", stdout: "" };
      };
      const env = { ...process.env, CMUX_WORKSPACE_ID: ARGUS };

      const dead = await deadPid();
      const first = witnessSpawn(repo, gh, () => dead);
      await dispatchFrontier(
        options(repo, gh, first.spawn, { cmux, env, maxConcurrency: 1 }),
      );
      // The deployment got a TAB, in Johan's workspace, not one of its own.
      expect(surfaces).toContain(`${WORKER}-1`);
      expect(calls.some((call) => call.includes("new-workspace"))).toBe(false);

      const second = witnessSpawn(repo, gh);
      await dispatchFrontier(
        options(repo, gh, second.spawn, { cmux, env, maxConcurrency: 1 }),
      );

      // Recovery closed it. This is the assertion #82 needed and did not have.
      expect(calls.some((call) => call.includes("close-surface"))).toBe(true);
      expect(surfaces).not.toContain(`${WORKER}-1`);
      // Johan's own tab is untouched throughout, and the only surface left
      // beside it belongs to the live redeployment.
      expect(surfaces).toEqual([
        "E0492BBB-0A3B-4393-B50B-75EB3439EB6C",
        `${WORKER}-2`,
      ]);
      expect(calls.some((call) => call.includes("close-workspace"))).toBe(false);
    } finally {
      await cleanup(repo);
    }
  }, GIT_BUDGET_MS);

  test("a DEAD worker that produced nothing releases the ticket back to the frontier", async () => {
    const repo = await scratchRepo();
    try {
      const gh = createFakeGh({ login: LOGIN, repo: REPO });
      gh.seed({ number: 1, title: "died early" });
      const dead = await deadPid();
      const first = witnessSpawn(repo, gh, () => dead);
      await dispatchFrontier(options(repo, gh, first.spawn, { maxConcurrency: 1 }));
      expect(gh.find("1")!.assignees).toEqual([LOGIN]);

      const second = witnessSpawn(repo, gh);
      const report = await dispatchFrontier(
        options(repo, gh, second.spawn, { maxConcurrency: 1 }),
      );

      expect(report.recovered).toHaveLength(1);
      expect(report.recovered[0]).toMatchObject({
        outcome: "returned-to-frontier",
        ticket: "1",
      });
      // Released, and re-dispatched in the SAME pass — one worker, never two.
      expect(second.witness.calls).toHaveLength(1);
      expect(report.dispatched.map((entry) => entry.ticket)).toEqual(["1"]);
      expect(gh.find("1")!.assignees).toEqual([LOGIN]);
    } finally {
      await cleanup(repo);
    }
  }, GIT_BUDGET_MS);

  test("a DEAD worker that COMMITTED keeps its claim — never re-dispatched over its work", async () => {
    const repo = await scratchRepo();
    try {
      const gh = createFakeGh({ login: LOGIN, repo: REPO });
      gh.seed({ number: 1, title: "did work then died" });
      const dead = await deadPid();
      const first = witnessSpawn(repo, gh, () => dead);
      const started = await dispatchFrontier(
        options(repo, gh, first.spawn, { maxConcurrency: 1 }),
      );
      const worktree = started.dispatched[0]!.worktree;
      await writeFile(join(worktree, "work.txt"), "real work\n");
      await Bun.$`git -C ${worktree} add work.txt`.quiet();
      await Bun.$`git -C ${worktree} commit --quiet -m "the worker's work"`
        .env(GIT_ENV)
        .quiet();

      const second = witnessSpawn(repo, gh);
      const report = await dispatchFrontier(
        options(repo, gh, second.spawn, { maxConcurrency: 1 }),
      );

      expect(report.recovered[0]).toMatchObject({
        outcome: "awaiting-verification",
        ticket: "1",
      });
      expect(second.witness.calls).toHaveLength(0);
      expect(gh.find("1")!.assignees).toEqual([LOGIN]);
      // The slot IS freed, though: a dead session must not hold capacity.
      expect(report.inFlight).toBe(0);
    } finally {
      await cleanup(repo);
    }
  }, GIT_BUDGET_MS);

  test("a DEAD worker with UNCOMMITTED changes keeps its claim and its worktree", async () => {
    const repo = await scratchRepo();
    try {
      const gh = createFakeGh({ login: LOGIN, repo: REPO });
      gh.seed({ number: 1, title: "edited but never committed" });
      const dead = await deadPid();
      const first = witnessSpawn(repo, gh, () => dead);
      const started = await dispatchFrontier(
        options(repo, gh, first.spawn, { maxConcurrency: 1 }),
      );
      const worktree = started.dispatched[0]!.worktree;
      await writeFile(join(worktree, "half-done.txt"), "in progress\n");

      const second = witnessSpawn(repo, gh);
      const report = await dispatchFrontier(
        options(repo, gh, second.spawn, { maxConcurrency: 1 }),
      );

      expect(report.recovered[0]).toMatchObject({
        outcome: "uncommitted-work",
        ticket: "1",
      });
      expect(second.witness.calls).toHaveLength(0);
      expect(gh.find("1")!.assignees).toEqual([LOGIN]);
      // Nothing was thrown away: the file the dead session wrote is still there.
      expect(await Bun.file(join(worktree, "half-done.txt")).text()).toBe(
        "in progress\n",
      );
      expect(report.degraded.join(" ")).toContain("uncommitted");
    } finally {
      await cleanup(repo);
    }
  }, GIT_BUDGET_MS);

  test("returning a ticket to the frontier clears the branch a re-dispatch needs", async () => {
    const repo = await scratchRepo();
    try {
      const gh = createFakeGh({ login: LOGIN, repo: REPO });
      gh.seed({ number: 1, title: "died early" });
      const dead = await deadPid();
      const first = witnessSpawn(repo, gh, () => dead);
      const started = await dispatchFrontier(
        options(repo, gh, first.spawn, { maxConcurrency: 1 }),
      );
      const worktree = started.dispatched[0]!.worktree;

      const second = witnessSpawn(repo, gh);
      await dispatchFrontier(options(repo, gh, second.spawn, { maxConcurrency: 1 }));

      // The abandoned worktree is gone and the branch is fresh — proof the
      // re-dispatch really re-created them rather than inheriting a corpse.
      const worktrees = await Bun.$`git -C ${repo} worktree list --porcelain`.text();
      expect(worktrees.split("\n").filter((line) => line.startsWith("worktree "))).toHaveLength(2);
      expect(second.witness.calls[0]!.cwd).toBe(worktree);
    } finally {
      await cleanup(repo);
    }
  }, GIT_BUDGET_MS);

  test("recovery never kills anything — a live worker's process is left alone", async () => {
    const repo = await scratchRepo();
    try {
      const gh = createFakeGh({ login: LOGIN, repo: REPO });
      gh.seed({ number: 1, title: "one" });
      // `kill()` throws in the witness, so any kill would fail this test.
      const first = witnessSpawn(repo, gh, () => process.pid);
      await dispatchFrontier(options(repo, gh, first.spawn, { maxConcurrency: 1 }));
      const second = witnessSpawn(repo, gh);

      const report = await dispatchFrontier(
        options(repo, gh, second.spawn, { maxConcurrency: 1 }),
      );

      expect(report.degraded).toEqual([]);
    } finally {
      await cleanup(repo);
    }
  }, GIT_BUDGET_MS);
});

/**
 * Ticket #88 — WHICH agent a ticket reaches, asserted as a table.
 *
 * SPEC §2: "Routing is by ticket label. Hermes reads the label and picks the
 * worker: `grilling`, `spec`, `review`, `diagnosis` → Claude Code;
 * implementation tickets (default) → Codex; exceptions can be pinned
 * per-ticket with an explicit `agent:claude-code` / `agent:codex` label."
 *
 * Nothing in this tree ever asked before this block existed: `readFrontier`
 * fetched `labels` and `dispatchFrontier` dropped them on the floor
 * (`const agent = options.agent ?? "claude"`), so every ticket went to Claude
 * and a per-ticket pin was silently ignored. The tests that existed asserted
 * that SOME agent was deployed, which a wholly wrong routing table passes.
 *
 * The four rows are asserted TOGETHER and in one set, because the interesting
 * failure is a table that gets three right and one wrong: a per-row test that
 * happens to cover the three implemented rows reads as green.
 */
describe("dispatchFrontier (#88): SPEC §2's routing table, per ticket", () => {
  test("spec→claude, diagnosis→claude, unlabelled→codex, spec+agent:codex→codex", async () => {
    const repo = await scratchRepo();
    try {
      await writeConfig(repo, "dispatch:\n  max_concurrency: 4\n");
      const gh = createFakeGh({ login: LOGIN, repo: REPO });
      gh.seed({ labels: ["spec"], number: 1, title: "A: write the spec" });
      gh.seed({ labels: ["diagnosis"], number: 2, title: "B: diagnose it" });
      gh.seed({ number: 3, title: "C: implement it" });
      gh.seed({ labels: ["spec", "agent:codex"], number: 4, title: "D: pinned" });
      const { spawn, witness } = witnessSpawn(repo, gh);

      const report = await dispatchFrontier(options(repo, gh, spawn));

      // The evidence artifact: the argv actually handed to the spawn seam, per
      // ticket, in dispatch order.
      const commands = witness.calls.map((call) => call.command.join(" "));
      // Printed, not just asserted: the argv is the evidence this ticket asks
      // for, and a reader of the test output should not have to re-derive it.
      for (const [index, line] of commands.entries()) {
        console.log(
          `#88 routed #${report.dispatched[index]?.ticket}: ${line.slice(0, 120)}`,
        );
      }
      expect(witness.calls.map((call) => call.agent)).toEqual([
        "claude",
        "claude",
        "codex",
        "codex",
      ]);
      expect(commands.map((line) => line.split(" ")[0])).toEqual([
        "claude",
        "claude",
        "codex",
        "codex",
      ]);
      // And the report — what `argus dispatch` prints and #57 reads back.
      expect(report.dispatched.map((entry) => [entry.ticket, entry.agent])).toEqual([
        ["1", "claude"],
        ["2", "claude"],
        ["3", "codex"],
        ["4", "codex"],
      ]);
      // cmux is unavailable in a test run and degrades per ticket (#7); no
      // ROUTING entry is allowed, which is what this test is about.
      expect(
        report.degraded.filter((entry) => !entry.includes("no cmux workspace")),
      ).toEqual([]);
    } finally {
      await cleanup(repo);
    }
  }, GIT_BUDGET_MS);

  test("`agent:claude-code` is SPEC §2's spelling and pins an unlabelled ticket to claude", async () => {
    const repo = await scratchRepo();
    try {
      const gh = createFakeGh({ login: LOGIN, repo: REPO });
      gh.seed({ labels: ["agent:claude-code"], number: 7, title: "pinned to claude" });
      const { spawn, witness } = witnessSpawn(repo, gh);

      const report = await dispatchFrontier(options(repo, gh, spawn));

      expect(witness.calls.map((call) => call.agent)).toEqual(["claude"]);
      expect(report.dispatched.map((entry) => entry.agent)).toEqual(["claude"]);
    } finally {
      await cleanup(repo);
    }
  }, GIT_BUDGET_MS);

  test("a CONFLICTING pin refuses the ticket: nothing spawned, nothing claimed, said out loud", async () => {
    const repo = await scratchRepo();
    try {
      const gh = createFakeGh({ login: LOGIN, repo: REPO });
      gh.seed({
        labels: ["agent:claude-code", "agent:codex"],
        number: 5,
        title: "two pins",
      });
      gh.seed({ number: 6, title: "the next one still goes" });
      const { spawn, witness } = witnessSpawn(repo, gh);

      const report = await dispatchFrontier(options(repo, gh, spawn));

      expect(report.dispatched.map((entry) => entry.ticket)).toEqual(["6"]);
      expect(witness.calls).toHaveLength(1);
      // The refused ticket is untouched on the tracker: a refusal must not
      // claim a ticket it then does not work.
      expect(gh.find("5")!.assignees).toEqual([]);
      expect(report.skipped.map((entry) => entry.ticket)).toEqual(["5"]);
      expect(report.degraded.join("\n")).toContain("#5");
      expect(report.degraded.join("\n")).toContain("agent:codex");
    } finally {
      await cleanup(repo);
    }
  }, GIT_BUDGET_MS);

  test("an UNKNOWN agent pin refuses rather than falling back to a default", async () => {
    const repo = await scratchRepo();
    try {
      const gh = createFakeGh({ login: LOGIN, repo: REPO });
      gh.seed({ labels: ["agent:gpt"], number: 8, title: "agent that does not exist" });
      const { spawn, witness } = witnessSpawn(repo, gh);

      const report = await dispatchFrontier(options(repo, gh, spawn));

      expect(witness.calls).toHaveLength(0);
      expect(report.dispatched).toEqual([]);
      expect(gh.find("8")!.assignees).toEqual([]);
      expect(report.skipped.map((entry) => entry.reason).join("")).toContain("agent:gpt");
      expect(report.degraded.join("\n")).toContain("agent:gpt");
    } finally {
      await cleanup(repo);
    }
  }, GIT_BUDGET_MS);

  test("`options.agent` still overrides the table for every ticket in the pass", async () => {
    const repo = await scratchRepo();
    try {
      const gh = createFakeGh({ login: LOGIN, repo: REPO });
      gh.seed({ number: 9, title: "an implementation ticket" });
      const { spawn, witness } = witnessSpawn(repo, gh);

      await dispatchFrontier(options(repo, gh, spawn, { agent: "claude" }));

      expect(witness.calls.map((call) => call.agent)).toEqual(["claude"]);
    } finally {
      await cleanup(repo);
    }
  }, GIT_BUDGET_MS);
});

describe("dispatch prompt retrieval audit copies (#132, #133)", () => {
  test("stores matched memory and Codex skill in the registry prompt", async () => {
    const repo = await scratchRepo();
    try {
      await mkdir(join(repo, ".argus/memory"), { recursive: true });
      await mkdir(join(repo, ".argus/skills/deploy"), { recursive: true });
      await writeFile(join(repo, ".argus/memory/MEMORY.md"), "- [Port fact](port.md) — Metro port\n");
      await writeFile(join(repo, ".argus/memory/port.md"), "Metro uses port 8082.\n");
      await writeFile(join(repo, ".argus/skills/deploy/SKILL.md"), "---\nname: deploy\ndescription: deploy implementation tickets\n---\nDeploy body verbatim.\n");
      const gh = createFakeGh({ login: LOGIN, repo: REPO });
      gh.seed({ number: 132, title: "Metro port dispatch", body: "implementation" });
      gh.seed({ number: 133, title: "Deploy implementation", body: "skill match", labels: ["ready-for-agent"] });
      const { spawn, witness } = witnessSpawn(repo, gh);
      await dispatchFrontier(options(repo, gh, spawn, { maxConcurrency: 2 }));
      const prompts = (await Bun.file(registryPaths(repo).sessionsFile).text()).split(/\r?\n/).filter(Boolean).map((text) => String(JSON.parse(text).dispatchPrompt));
      expect(prompts.join("\n")).toContain("RECORDED PROJECT FACTS");
      expect(prompts.join("\n")).toContain("Metro uses port 8082.\n");
      expect(prompts.join("\n")).toContain("MATCHED CODEX SKILLS");
      expect(prompts.join("\n")).toContain("Deploy body verbatim.\n");
    } finally { await cleanup(repo); }
  }, GIT_BUDGET_MS);

  test("missing or entry-less memory preserves the default prompt bytes", async () => {
    const first = await scratchRepo(); const second = await scratchRepo();
    try {
      await mkdir(join(second, ".argus/memory"), { recursive: true });
      await writeFile(join(second, ".argus/memory/MEMORY.md"), "# Memory index\n");
      const ticket = { number: "1", title: "plain", body: "body", labels: [] };
      const expected = defaultDispatchPrompt(ticket, REPO);
      for (const repo of [first, second]) {
        const gh = createFakeGh({ login: LOGIN, repo: REPO }); gh.seed({ number: 1, title: ticket.title, body: ticket.body });
        const { spawn, witness } = witnessSpawn(repo, gh);
        await dispatchFrontier(options(repo, gh, spawn));
        const stored = await Bun.file(registryPaths(repo).sessionsFile).text();
        expect(String(JSON.parse(stored.split(/\r?\n/).filter(Boolean).at(-1)!).dispatchPrompt)).toBe(expected);
      }
    } finally { await cleanup(first); await cleanup(second); }
  }, GIT_BUDGET_MS);
});
