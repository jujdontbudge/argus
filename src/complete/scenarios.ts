/**
 * SPEC §13 scenario 1's missing half (ticket #57): **tickets closed**.
 *
 * Scenario 1 asserts "autonomous batch, zero human input" and, until this
 * registrar, asserted USER.md, memory, digests, INDEX and the archive — every
 * part of the batch EXCEPT the step that makes it autonomous. AUDIT.md §4 item
 * 3 is exactly that: "scenario 1's assertion list has no ticket-closure
 * contribution at all". A batch nobody can finish is not an autonomous batch,
 * however green the other nine assertions are.
 *
 * WHAT THIS HALF IS, HONESTLY. It is FIXTURE-DRIVEN, and it grades PARTIAL, not
 * PASS. Real: the git repo, the worktree, the branch, the commit, the merge
 * base, the merge, the durable event file, the signal consumption, and
 * `completeReadyTickets` itself — the same function `argus complete` calls.
 * Faked: `gh` (SPEC §13 forbids a test run from writing to a tracker), the
 * review brain, the worker process, and the gate commands. So what it proves is
 * that the production loop closes a ticket end to end against a tracker double
 * — not that a live agent's work survives a live review. The live half belongs
 * to #63's acceptance gates, and claiming it here would be the "ten pass"
 * overclaim AUDIT.md §4 item 10 records.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { completeReadyTickets } from "./complete.ts";
import { deployWorker, worktreeForTicket } from "../deploy";
import type { WorkerProcess } from "../deploy";
import { writeEvent } from "../events";
import { createFakeGh } from "../eyes/retro/fake-gh";
import type { Brain } from "../eyes/brain";
import type { ScenarioHandler, ScenarioRegistry } from "../harness/index.ts";

const TICKET = "7";
const LOGIN = "argus-bot";
const MAP_BODY = ["## Destination", "", "A closed loop.", "", "## Decisions so far", ""].join(
  "\n",
);

const GIT_IDENTITY = {
  GIT_AUTHOR_EMAIL: "harness@invalid.example",
  GIT_AUTHOR_NAME: "Argus Harness",
  GIT_COMMITTER_EMAIL: "harness@invalid.example",
  GIT_COMMITTER_NAME: "Argus Harness",
};

async function git(args: readonly string[], cwd: string): Promise<string> {
  const child = Bun.spawn(["git", ...args], {
    cwd,
    env: { ...process.env, ...GIT_IDENTITY },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [, stdout] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  return stdout.trim();
}

/** A worker process stub: the batch's agent is not what this half grades. */
const finishedWorker = (): WorkerProcess => ({
  announcedSessionId: async () => null,
  exited: Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }),
  kill: () => {
    throw new Error("the completion loop must never kill a worker");
  },
  pid: process.pid,
});

/**
 * The closure half of the autonomous batch: a dispatched ticket session
 * commits, signals that it finished through the §6 event file, and the
 * production completion pass verifies, merges, closes and maps it — with no
 * human anywhere in the sequence.
 */
export function batchClosureScenario(brain?: Brain): ScenarioHandler {
  return async ({ assert, assertSandboxed, sandbox }) => {
    const repo = sandbox.repo;
    const base = await git(["rev-parse", "--abbrev-ref", "HEAD"], repo);

    const gh = createFakeGh({ login: LOGIN, repo: "argus-sandbox/sandbox" });
    gh.seed({
      assignees: [LOGIN],
      body: "Implement the batch's one ticket.",
      number: Number(TICKET),
      title: "Autonomous batch ticket",
    });
    gh.seed({ body: MAP_BODY, labels: ["wayfinder:map"], number: 900, title: "Map" });

    const deployed = await deployWorker(
      {
        agent: "claude",
        dispatchPrompt: `Implement ticket #${TICKET}.`,
        repo,
        ticket: TICKET,
        workspace: "none",
      },
      { newSessionId: () => "sess-batch-close", spawn: async () => finishedWorker() },
    );
    assert(deployed.status === "deployed", "the batch's ticket session was deployed");
    if (deployed.status !== "deployed") return;

    const worktree = deployed.deployment.worktree;
    assertSandboxed(worktree, "the ticket worktree is inside the sandbox");

    await mkdir(join(worktree, "src"), { recursive: true });
    await writeFile(join(worktree, "src/batch.ts"), "export const batch = 7;\n");
    await git(["add", "src/batch.ts"], worktree);
    await git(["commit", "--quiet", "-m", `feat: ticket ${TICKET}`], worktree);

    // The §6 push signal a finished session leaves behind — the only channel.
    await writeEvent(repo, {
      agent: "claude-code",
      kind: "end-of-session",
      message: "Done: implemented ticket 7.",
      sessionId: "sess-batch-close",
    });

    const report = await completeReadyTickets({
      base,
      ...(brain !== undefined && { brain }),
      gates: [{ command: ["git", "rev-parse", "HEAD"], name: "gate" }],
      gh: gh.run,
      repo,
      ...(brain === undefined && {
        reviewer: async () => ({ concerns: [], status: "clean" as const, summary: "clean" }),
      }),
    });

    const outcome = report.completed.find((entry) => entry.ticket === TICKET);
    assert(
      outcome?.status === "merged",
      "the finished ticket passed its gates and merged, with no human input",
    );
    assert(
      (await Bun.file(join(repo, "src/batch.ts")).exists()) === true,
      "the ticket's work is on the sandbox repo's base branch",
    );
    // THE ASSERTION SCENARIO 1 DID NOT HAVE.
    assert(
      gh.find(TICKET)?.state === "closed" && gh.find(TICKET)?.closeReason === "completed",
      "the autonomous batch closed its ticket on the tracker",
    );
    assert(
      gh.find("900")?.body.includes("Autonomous batch ticket") === true,
      "the wayfinder map indexed the closed ticket",
    );
    assert(
      (await Bun.file(join(worktreeForTicket(repo, TICKET), "src/batch.ts")).exists()) ===
        false,
      "the merged ticket's worktree was retired",
    );
    assert(
      gh.cwds.every((cwd) => cwd.startsWith(sandbox.root)),
      "every tracker call the closure made ran inside the sandbox",
    );
  };
}

/**
 * Slot 1, EXTENDED — never overwritten. Scenario 1 already carries five
 * tickets' halves (reviewer, digest, archiver, hermes, codex) and
 * `all-scenarios.test.ts` pins each of them by description; replacing the slot
 * instead of chaining onto it is the exact lossy-registration bug that test
 * exists to catch.
 */
export function registerCompletionScenarios(
  registry: ScenarioRegistry,
  brain?: Brain,
): void {
  const existing = registry.get(1);
  const closure = batchClosureScenario(brain);
  registry.register(1, async (context) => {
    if (existing !== undefined) await existing(context);
    await closure(context);
  });
}
