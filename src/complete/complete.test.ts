import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { branchForTicket, deployWorker, worktreeForTicket } from "../deploy";
import type { WorkerProcess } from "../deploy";
import { dispatchFrontier } from "../dispatch";
import { writeEvent } from "../events";
import type { Brain } from "../eyes/brain";
import {
  createFakeGh,
  type FakeGh,
  type FakeGhOptions,
} from "../eyes/retro/fake-gh";
import { completeReadyTickets, type CompleteOptions } from "./complete.ts";
import { listVerifications } from "./queue.ts";

/**
 * Ticket #57 — the verify/merge/close/map loop, tested THROUGH THE DOOR
 * PRODUCTION USES.
 *
 * Every test here calls `completeReadyTickets`, the exact function `argus
 * complete` calls, and fakes only the two seams that would otherwise touch the
 * world: `gh` and the review brain. Git is REAL — real repos, real worktrees,
 * real branches, real commits, real merges — and so are the gates: they are
 * real child processes, run by the real gate runner, in the real worktree.
 *
 * The load-bearing case is not the green one. It is `a failing gate blocks the
 * merge`: a verify step that cannot refuse is not a verify step, so the base
 * branch's sha is asserted UNCHANGED and the ticket asserted still open, which
 * is the assertion a rubber-stamp gate cannot pass.
 */
const REPO = "JohanSardar/argus";
const LOGIN = "argus-bot";
/** Real `git` and real child processes under load; a small budget is noise. */
const BUDGET_MS = 120_000;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_EMAIL: "complete@invalid.example",
  GIT_AUTHOR_NAME: "Argus Complete Test",
  GIT_COMMITTER_EMAIL: "complete@invalid.example",
  GIT_COMMITTER_NAME: "Argus Complete Test",
};

/** Gates that are real processes, so the production runner is what runs. */
const PASSING_GATE = { command: ["sh", "-c", "exit 0"], name: "green" } as const;
const FAILING_GATE = {
  command: ["sh", "-c", "echo 'expect(1).toBe(2)' >&2; exit 1"],
  name: "tests",
} as const;

async function scratchRepo(): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "argus-complete-"));
  const repo = await realpath(created);
  await Bun.$`git -C ${repo} -c init.defaultBranch=main init --quiet`.quiet();
  await writeFile(join(repo, "README.md"), "# scratch\n");
  // `.argus/` is a committed .gitignore line in every Argus repo (SPEC §4).
  await writeFile(join(repo, ".gitignore"), ".argus/\n");
  await Bun.$`git -C ${repo} add README.md .gitignore`.quiet();
  await Bun.$`git -C ${repo} commit --quiet -m base`.env(GIT_ENV).quiet();
  await mkdir(join(repo, ".argus"), { recursive: true });
  return repo;
}

async function cleanup(repo: string): Promise<void> {
  await rm(repo, { force: true, recursive: true });
  await rm(`${repo}-worktrees`, { force: true, recursive: true });
}

async function sha(repo: string, ref = "HEAD"): Promise<string> {
  const shown = await Bun.$`git -C ${repo} rev-parse ${ref}`.quiet();
  return shown.stdout.toString().trim();
}

async function commitInWorktree(
  worktree: string,
  file: string,
  body: string,
  message: string,
): Promise<void> {
  await writeFile(join(worktree, file), body);
  await Bun.$`git -C ${worktree} add ${file}`.quiet();
  await Bun.$`git -C ${worktree} commit --quiet -m ${message}`.env(GIT_ENV).quiet();
}

const deadWorker = (): WorkerProcess => ({
  announcedSessionId: async () => null,
  exited: Promise.resolve({ exitCode: 0, stderr: "", stdout: "" }),
  kill: () => {
    throw new Error("the completion loop must never kill a worker");
  },
  pid: process.pid,
});

/**
 * A worker, deployed the way production deploys one (#55's primitive), that
 * has committed `file` on its ticket branch — i.e. exactly the state a
 * finished session leaves behind.
 */
async function deployAndCommit(
  repo: string,
  ticket: string,
  sessionId: string,
  file = `ticket-${ticket}.txt`,
): Promise<{ worktree: string; branch: string }> {
  const deployed = await deployWorker(
    {
      agent: "claude",
      dispatchPrompt: `Implement ticket #${ticket}.`,
      repo,
      ticket,
      workspace: "none",
    },
    { newSessionId: () => sessionId, spawn: async () => deadWorker() },
  );
  if (deployed.status !== "deployed") {
    throw new Error(`fixture deployment failed: ${JSON.stringify(deployed)}`);
  }
  await commitInWorktree(
    deployed.deployment.worktree,
    file,
    `work for #${ticket}\n`,
    `feat: ticket ${ticket}`,
  );
  return { branch: deployed.deployment.branch, worktree: deployed.deployment.worktree };
}

/** The §6 push signal a finished (or blocked) session actually leaves. */
async function pushSignal(
  repo: string,
  sessionId: string,
  kind: "end-of-session" | "blocked-on-human",
  message?: string,
): Promise<void> {
  await writeEvent(repo, {
    agent: "claude-code",
    kind,
    message:
      message ??
      (kind === "end-of-session" ? "Done: ticket implemented." : "Need a human."),
    sessionId,
  });
}

const cleanReview: NonNullable<CompleteOptions["reviewer"]> = async () => ({
  concerns: [],
  status: "clean",
  summary: "reads fine",
});

function options(
  repo: string,
  gh: FakeGh,
  extra: Partial<CompleteOptions> = {},
): CompleteOptions {
  return {
    gates: [PASSING_GATE],
    gh: gh.run,
    repo,
    reviewer: cleanReview,
    ...extra,
  };
}

/** A tracker with the ticket open and a wayfinder map to keep up to date. */
function seedTracker(
  ticket: number,
  title: string,
  extra: Partial<FakeGhOptions> = {},
): FakeGh {
  const gh = createFakeGh({ login: LOGIN, repo: REPO, ...extra });
  gh.seed({ assignees: [LOGIN], body: `Do ${ticket}.`, number: ticket, title });
  gh.seed({
    body: [
      "## Destination",
      "",
      "A closed loop.",
      "",
      "## Decisions so far",
      "",
      "- [An earlier ticket](https://github.com/JohanSardar/argus/issues/1) — done",
      "",
      "## Out of scope",
      "",
    ].join("\n"),
    labels: ["wayfinder:map"],
    number: 900,
    title: "Map: Argus v1",
  });
  return gh;
}

describe("completeReadyTickets (#57): the gate can refuse, and a refusal stops the merge", () => {
  test(
    "a failing gate blocks the merge: base untouched, ticket open, claim intact",
    async () => {
      const repo = await scratchRepo();
      try {
        const gh = seedTracker(57, "Close the loop");
        await deployAndCommit(repo, "57", "sess-57");
        await pushSignal(repo, "sess-57", "end-of-session");
        const before = await sha(repo);

        const report = await completeReadyTickets(
          options(repo, gh, { gates: [PASSING_GATE, FAILING_GATE] }),
        );

        const outcome = report.completed.find((entry) => entry.ticket === "57");
        expect(outcome?.status).toBe("gate-failed");
        // The three facts a rubber-stamp gate cannot produce.
        expect(await sha(repo)).toBe(before);
        expect(gh.find("57")!.state).toBe("open");
        expect(gh.find("57")!.assignees).toEqual([LOGIN]);
        // And the failure is legible, with the gate named and its output kept.
        expect(outcome?.gates?.map((gate) => [gate.name, gate.passed])).toEqual([
          ["green", true],
          ["tests", false],
        ]);
        expect(outcome?.detail).toContain("tests");
        expect(report.degraded.join("\n")).toContain("#57");
      } finally {
        await cleanup(repo);
      }
    },
    BUDGET_MS,
  );

  test(
    "the gate runs in the ticket's worktree, against the code under test",
    async () => {
      const repo = await scratchRepo();
      try {
        const gh = seedTracker(58, "Prove the gate sees the work");
        await deployAndCommit(repo, "58", "sess-58", "only-on-the-branch.txt");
        await pushSignal(repo, "sess-58", "end-of-session");

        // A gate that passes ONLY inside the worktree: the file it tests for
        // does not exist on main, so a gate run in the repo root fails.
        const report = await completeReadyTickets(
          options(repo, gh, {
            gates: [{ command: ["test", "-f", "only-on-the-branch.txt"], name: "sees-work" }],
          }),
        );

        expect(report.completed[0]?.status).toBe("merged");
      } finally {
        await cleanup(repo);
      }
    },
    BUDGET_MS,
  );

  test(
    "a failed gate keeps the ticket queued, and the next pass merges it once green",
    async () => {
      const repo = await scratchRepo();
      try {
        const gh = seedTracker(59, "Retry after red");
        await deployAndCommit(repo, "59", "sess-59");
        await pushSignal(repo, "sess-59", "end-of-session");

        await completeReadyTickets(options(repo, gh, { gates: [FAILING_GATE] }));

        // The signal is spent — push and poll share one cursor (#58) — so the
        // durable queue is the only thing that can bring this ticket back.
        const queued = await listVerifications(repo);
        expect(queued.map((entry) => entry.ticket)).toEqual(["59"]);
        expect(queued[0]!.attempts).toBe(1);
        expect(queued[0]!.lastFailure).toContain("tests");

        const second = await completeReadyTickets(options(repo, gh));

        expect(second.completed[0]?.status).toBe("merged");
        expect(gh.find("59")!.state).toBe("closed");
        expect(await listVerifications(repo)).toEqual([]);
      } finally {
        await cleanup(repo);
      }
    },
    BUDGET_MS,
  );
});

describe("completeReadyTickets (#57): review is a gate, and it can refuse too", () => {
  test(
    "a blocking review stops a merge every command gate waved through",
    async () => {
      const repo = await scratchRepo();
      try {
        const gh = seedTracker(60, "Review must be able to say no");
        await deployAndCommit(repo, "60", "sess-60");
        await pushSignal(repo, "sess-60", "end-of-session");
        const before = await sha(repo);

        const report = await completeReadyTickets(
          options(repo, gh, {
            reviewer: async () => ({
              concerns: ["the new module has no test for the failure path"],
              status: "blocked",
              summary: "not ready",
            }),
          }),
        );

        expect(report.completed[0]?.status).toBe("review-blocked");
        expect(await sha(repo)).toBe(before);
        expect(gh.find("60")!.state).toBe("open");
        expect(report.completed[0]?.detail).toContain("no test for the failure path");
      } finally {
        await cleanup(repo);
      }
    },
    BUDGET_MS,
  );

  test(
    "a reviewer that cannot answer blocks rather than waves through",
    async () => {
      const repo = await scratchRepo();
      try {
        const gh = seedTracker(61, "Fail closed");
        await deployAndCommit(repo, "61", "sess-61");
        await pushSignal(repo, "sess-61", "end-of-session");
        const before = await sha(repo);

        // The production reviewer, driven by a brain that is simply down.
        const brain: Brain = {
          async evaluate() {
            return { detail: "codex: command not found", ok: false, reason: "spawn-error" };
          },
        };
        const { reviewer: _stub, ...withoutStubReviewer } = options(repo, gh);
        const report = await completeReadyTickets({ ...withoutStubReviewer, brain });

        expect(report.completed[0]?.status).toBe("review-blocked");
        expect(await sha(repo)).toBe(before);
        expect(gh.find("61")!.state).toBe("open");
        expect(report.degraded.join("\n")).toContain("review");
      } finally {
        await cleanup(repo);
      }
    },
    BUDGET_MS,
  );

  test(
    "the review reads the diff against the MERGE BASE, not the base tip",
    async () => {
      const repo = await scratchRepo();
      try {
        const gh = seedTracker(62, "Never diff against a moved tip");
        await deployAndCommit(repo, "62", "sess-62", "mine.txt");

        // Another ticket lands on main AFTER this worktree branched. Diffed
        // against the base TIP, its file reads as this ticket's deletion —
        // the failure that has bitten the dispatcher for real.
        await writeFile(join(repo, "someone-elses.txt"), "another ticket's work\n");
        await Bun.$`git -C ${repo} add someone-elses.txt`.quiet();
        await Bun.$`git -C ${repo} commit --quiet -m "other ticket"`.env(GIT_ENV).quiet();

        await pushSignal(repo, "sess-62", "end-of-session");
        let seen = "";
        const report = await completeReadyTickets(
          options(repo, gh, {
            reviewer: async (input) => {
              seen = input.diff;
              return { concerns: [], status: "clean", summary: "fine" };
            },
          }),
        );

        expect(report.completed[0]?.status).toBe("merged");
        expect(seen).toContain("mine.txt");
        expect(seen).not.toContain("someone-elses.txt");
        // And the other ticket's work survives the merge, unharmed.
        expect(await Bun.file(join(repo, "someone-elses.txt")).text()).toBe(
          "another ticket's work\n",
        );
        expect(await Bun.file(join(repo, "mine.txt")).text()).toBe("work for #62\n");
      } finally {
        await cleanup(repo);
      }
    },
    BUDGET_MS,
  );
});

describe("completeReadyTickets (#57): finished is not the same as died", () => {
  test(
    "a finished session merges; a session that only stopped breathing does not",
    async () => {
      const repo = await scratchRepo();
      try {
        const gh = createFakeGh({ login: LOGIN, repo: REPO });
        gh.seed({ assignees: [LOGIN], number: 70, title: "Finished" });
        gh.seed({ assignees: [LOGIN], number: 71, title: "Died" });
        await deployAndCommit(repo, "70", "sess-70");
        await deployAndCommit(repo, "71", "sess-71");
        // #70 said so. #71 said nothing — its digest went `dead`, which is
        // #56's recovery line ("a live owner is a live deployment"), not a
        // completion signal.
        await pushSignal(repo, "sess-70", "end-of-session");
        const report = await completeReadyTickets(
          options(repo, gh, {
            signals: async () => [
              { prompt: "", reason: "", sessionId: "sess-70", source: "event", status: "done" },
              { prompt: "", reason: "", sessionId: "sess-71", source: "poll", status: "dead" },
            ],
          }),
        );

        const byTicket = new Map(
          report.completed.map((entry) => [entry.ticket, entry.status]),
        );
        expect(byTicket.get("70")).toBe("merged");
        expect(byTicket.get("71")).toBe("awaiting-recovery");
        expect(gh.find("70")!.state).toBe("closed");
        expect(gh.find("71")!.state).toBe("open");
        expect(await listVerifications(repo)).toEqual([]);
      } finally {
        await cleanup(repo);
      }
    },
    BUDGET_MS,
  );

  /**
   * #104 finding 2 — the class is A SESSION THAT BLOCKED AND SAID NOTHING.
   *
   * #82 and #99 both measured it the same way and neither looked at a string:
   * three tickets, three blocked sessions, `comments=0`. So these assert that
   * SOMETHING carrying the worker's reason reached the ticket, and drive it
   * with two unrelated reasons — today's sandbox complaint and a wholly
   * different one — because the defect is the silence, not the wording. A test
   * pinned to "read-only sandbox" would pass a worker that blocked for any
   * other reason and said nothing about it.
   */
  for (const [ticket, sessionId, reason] of [
    [
      "74",
      "sess-74",
      "Blocked by the workspace's read-only sandbox: the test-first patch was rejected.",
    ],
    ["75", "sess-75", "The ticket contradicts SPEC §4; I need Johan to pick one."],
  ] as const) {
    test(
      `a blocked session leaves its reason on ticket #${ticket}, whatever the reason is`,
      async () => {
        const repo = await scratchRepo();
        try {
          const gh = seedTracker(Number(ticket), "Waiting on Johan");
          await deployAndCommit(repo, ticket, sessionId);
          await pushSignal(repo, sessionId, "blocked-on-human", reason);

          const report = await completeReadyTickets(options(repo, gh));

          // The verdict is unchanged: still never merged, never closed.
          expect(report.completed[0]?.status).toBe("blocked-on-human");
          expect(gh.find(ticket)!.state).toBe("open");

          // The fix: the tracker is no longer silent about it. This is the
          // assertion that fails on the pre-#104 code, where comments was [].
          const comments = gh.find(ticket)!.comments;
          expect(comments.length).toBe(1);
          // The worker's own words reached the ticket, not a generic placeholder.
          expect(comments[0]).toContain(reason);
          // And a human can tell WHY it is here and that nothing will resume it.
          expect(comments[0]).toContain("BLOCKED ON A HUMAN");
          expect(report.degraded).toEqual([]);
        } finally {
          await cleanup(repo);
        }
      },
      BUDGET_MS,
    );
  }

  test(
    "the block is commented ONCE, not once per `argus complete` pass",
    async () => {
      const repo = await scratchRepo();
      try {
        const gh = seedTracker(76, "Waiting on Johan");
        await deployAndCommit(repo, "76", "sess-76");
        await pushSignal(repo, "sess-76", "blocked-on-human", "Need a decision.");

        // Three passes over an unchanged repo: the event file is still sitting
        // in `.argus/events/`, which is precisely the shape that would spam.
        const first = await completeReadyTickets(options(repo, gh));
        await completeReadyTickets(options(repo, gh));
        await completeReadyTickets(options(repo, gh));

        expect(first.completed[0]?.status).toBe("blocked-on-human");
        // One FACT — this session blocked — so one comment, held by the signal
        // consumer's durable delivered set rather than by a second dedup here.
        expect(gh.find("76")!.comments.length).toBe(1);
      } finally {
        await cleanup(repo);
      }
    },
    BUDGET_MS,
  );

  test(
    "a block whose comment cannot be posted degrades loudly instead of going quiet",
    async () => {
      const repo = await scratchRepo();
      try {
        // `gh issue comment` exits nonzero — it does not throw — which is the
        // failure a try/catch alone would report as a successful post.
        const gh = seedTracker(77, "Waiting on Johan", { failComment: "rate limited" });
        await deployAndCommit(repo, "77", "sess-77");
        await pushSignal(repo, "sess-77", "blocked-on-human", "Need a decision.");

        const report = await completeReadyTickets(options(repo, gh));

        expect(report.completed[0]?.status).toBe("blocked-on-human");
        expect(gh.find("77")!.comments).toEqual([]);
        // #96's shape: degraded, with a reason an operator can act on — it
        // names the ticket and says where the reason still lives.
        const degraded = report.degraded.join("\n");
        expect(degraded).toContain("77");
        expect(degraded).toContain("blocked on a human");
        expect(degraded).toContain(".argus/events");
      } finally {
        await cleanup(repo);
      }
    },
    BUDGET_MS,
  );

  test(
    "a blocked-on-human session is never merged and never closed",
    async () => {
      const repo = await scratchRepo();
      try {
        const gh = seedTracker(72, "Waiting on Johan");
        await deployAndCommit(repo, "72", "sess-72");
        await pushSignal(repo, "sess-72", "blocked-on-human");
        const before = await sha(repo);

        const report = await completeReadyTickets(options(repo, gh));

        expect(report.completed[0]?.status).toBe("blocked-on-human");
        expect(await sha(repo)).toBe(before);
        expect(gh.find("72")!.state).toBe("open");
      } finally {
        await cleanup(repo);
      }
    },
    BUDGET_MS,
  );

  test(
    "#56's recovery hands over dead-but-committed tickets, and they verify",
    async () => {
      const repo = await scratchRepo();
      try {
        const gh = createFakeGh({ login: LOGIN, repo: REPO });
        gh.seed({ number: 73, title: "Dead worker, real commits" });
        const spawnDead = async (): Promise<WorkerProcess> => {
          const child = Bun.spawn(["true"]);
          await child.exited;
          return { ...deadWorker(), pid: child.pid };
        };

        // A real dispatch pass, then the worker dies having committed.
        await dispatchFrontier({
          agent: "claude",
          gh: gh.run,
          repo,
          spawn: spawnDead,
          workspace: "none",
        });
        await commitInWorktree(
          worktreeForTicket(repo, "73"),
          "recovered.txt",
          "work from a session that then died\n",
          "feat: ticket 73",
        );

        // The next dispatch pass runs recovery, which is where dead-with-work
        // is distinguished from dead-with-nothing — and hands it to us.
        const second = await dispatchFrontier({
          agent: "claude",
          gh: gh.run,
          repo,
          spawn: spawnDead,
          workspace: "none",
        });
        expect(
          second.recovered.find((entry) => entry.ticket === "73")?.outcome,
        ).toBe("awaiting-verification");
        expect((await listVerifications(repo)).map((entry) => entry.ticket)).toEqual([
          "73",
        ]);

        const report = await completeReadyTickets(
          options(repo, gh, { signals: async () => [] }),
        );

        expect(report.completed[0]?.status).toBe("merged");
        expect(gh.find("73")!.state).toBe("closed");
        expect(await Bun.file(join(repo, "recovered.txt")).exists()).toBe(true);
      } finally {
        await cleanup(repo);
      }
    },
    BUDGET_MS,
  );
});

describe("completeReadyTickets (#57): closing the loop", () => {
  test(
    "green: merged with history, ticket closed as completed, map updated, worktree retired",
    async () => {
      const repo = await scratchRepo();
      try {
        const gh = seedTracker(63, "Close the loop end to end");
        await deployAndCommit(repo, "63", "sess-63");
        await pushSignal(repo, "sess-63", "end-of-session");

        const report = await completeReadyTickets(options(repo, gh));

        const outcome = report.completed[0]!;
        expect(outcome).toMatchObject({ status: "merged" });
        expect(report.degraded).toEqual([]);

        // Merged — with a merge commit, so the ticket's work stays legible.
        expect(await Bun.file(join(repo, "ticket-63.txt")).text()).toBe("work for #63\n");
        const parents = (
          await Bun.$`git -C ${repo} rev-list --parents -n 1 HEAD`.quiet()
        ).stdout
          .toString()
          .trim()
          .split(/\s+/);
        expect(parents).toHaveLength(3);
        expect(outcome.mergeSha).toBe(await sha(repo));

        // Closed, as completed, by the dispatcher — never by the worker.
        const closed = gh.calls.find((call) => call[0] === "issue" && call[1] === "close");
        expect(closed).toContain("63");
        expect(closed).toContain("--reason");
        expect(closed).toContain("completed");
        expect(gh.find("63")!.state).toBe("closed");

        // The wayfinder map gained one line for the ticket, by name and link.
        const map = gh.find("900")!;
        expect(map.body).toContain("[Close the loop end to end]");
        expect(map.body).toContain("https://github.com/JohanSardar/argus/issues/63");
        expect(map.body).toContain("- [An earlier ticket]");
        expect(map.body.indexOf("Close the loop end to end")).toBeGreaterThan(
          map.body.indexOf("## Decisions so far"),
        );
        expect(map.body.indexOf("Close the loop end to end")).toBeLessThan(
          map.body.indexOf("## Out of scope"),
        );

        // The loop leaves nothing behind: no worktree, no branch, no queue.
        expect(await Bun.file(join(worktreeForTicket(repo, "63"), "ticket-63.txt")).exists())
          .toBe(false);
        const branches = (await Bun.$`git -C ${repo} branch --list`.quiet()).stdout.toString();
        expect(branches).not.toContain(branchForTicket("63"));
        expect(await listVerifications(repo)).toEqual([]);
      } finally {
        await cleanup(repo);
      }
    },
    BUDGET_MS,
  );

  test(
    "a repo with no wayfinder map still merges and closes, and says so",
    async () => {
      const repo = await scratchRepo();
      try {
        const gh = createFakeGh({ login: LOGIN, repo: REPO });
        gh.seed({ assignees: [LOGIN], number: 64, title: "No map here" });
        await deployAndCommit(repo, "64", "sess-64");
        await pushSignal(repo, "sess-64", "end-of-session");

        const report = await completeReadyTickets(options(repo, gh));

        expect(report.completed[0]?.status).toBe("merged");
        expect(report.completed[0]?.map).toBe("no-map");
        expect(gh.find("64")!.state).toBe("closed");
      } finally {
        await cleanup(repo);
      }
    },
    BUDGET_MS,
  );

  test(
    "a finished session that committed nothing is never closed, and is loud",
    async () => {
      const repo = await scratchRepo();
      try {
        const gh = seedTracker(65, "Produced nothing");
        await deployWorker(
          {
            agent: "claude",
            dispatchPrompt: "Implement ticket #65.",
            repo,
            ticket: "65",
            workspace: "none",
          },
          { newSessionId: () => "sess-65", spawn: async () => deadWorker() },
        );
        await pushSignal(repo, "sess-65", "end-of-session");

        const report = await completeReadyTickets(options(repo, gh));

        expect(report.completed[0]?.status).toBe("nothing-to-merge");
        expect(gh.find("65")!.state).toBe("open");
        expect(report.degraded.join("\n")).toContain("#65");
      } finally {
        await cleanup(repo);
      }
    },
    BUDGET_MS,
  );

  test(
    "a second pass over an already-merged ticket closes it instead of merging twice",
    async () => {
      const repo = await scratchRepo();
      try {
        const gh = seedTracker(66, "Close after a failed close");
        await deployAndCommit(repo, "66", "sess-66");
        await pushSignal(repo, "sess-66", "end-of-session");

        // The close fails: the merge is in, the ticket is not closed, and the
        // work must not be lost between passes.
        const failing = createFakeGh({ login: LOGIN, repo: REPO });
        failing.seed({ assignees: [LOGIN], number: 66, title: "Close after a failed close" });
        const first = await completeReadyTickets(
          options(repo, gh, {
            gh: async (args, cwd) =>
              args[0] === "issue" && args[1] === "close"
                ? { exitCode: 1, stderr: "gh: API rate limit exceeded", stdout: "" }
                : gh.run(args, cwd),
          }),
        );
        expect(first.completed[0]?.status).toBe("failed");
        expect(gh.find("66")!.state).toBe("open");
        const mergedAt = await sha(repo);

        const second = await completeReadyTickets(
          options(repo, gh, { signals: async () => [] }),
        );

        expect(second.completed[0]?.status).toBe("merged");
        expect(second.completed[0]?.detail).toContain("already merged");
        expect(await sha(repo)).toBe(mergedAt);
        expect(gh.find("66")!.state).toBe("closed");
      } finally {
        await cleanup(repo);
      }
    },
    BUDGET_MS,
  );

  test(
    "the loop refuses to merge into a checkout that is not on the base branch",
    async () => {
      const repo = await scratchRepo();
      try {
        const gh = seedTracker(67, "Wrong base checked out");
        await deployAndCommit(repo, "67", "sess-67");
        await pushSignal(repo, "sess-67", "end-of-session");
        await Bun.$`git -C ${repo} checkout --quiet -b johans-experiment`.quiet();
        const before = await sha(repo);

        const report = await completeReadyTickets(options(repo, gh, { base: "main" }));

        expect(report.completed[0]?.status).toBe("failed");
        expect(report.completed[0]?.detail).toContain("johans-experiment");
        expect(await sha(repo)).toBe(before);
        expect(gh.find("67")!.state).toBe("open");
        // Still queued: a checkout on the wrong branch is a transient state.
        expect((await listVerifications(repo)).map((entry) => entry.ticket)).toEqual(["67"]);
      } finally {
        await cleanup(repo);
      }
    },
    BUDGET_MS,
  );

  test(
    "a dirty checkout is never merged into",
    async () => {
      const repo = await scratchRepo();
      try {
        const gh = seedTracker(68, "Dirty checkout");
        await deployAndCommit(repo, "68", "sess-68");
        await pushSignal(repo, "sess-68", "end-of-session");
        await writeFile(join(repo, "README.md"), "# scratch\n\nJohan was mid-edit.\n");
        const before = await sha(repo);

        const report = await completeReadyTickets(options(repo, gh));

        expect(report.completed[0]?.status).toBe("failed");
        expect(report.completed[0]?.detail).toContain("uncommitted");
        expect(await sha(repo)).toBe(before);
        expect(await readFile(join(repo, "README.md"), "utf8")).toContain("mid-edit");
        expect(gh.find("68")!.state).toBe("open");
      } finally {
        await cleanup(repo);
      }
    },
    BUDGET_MS,
  );

  test(
    "no tracker means nothing is merged and the reason is said out loud",
    async () => {
      const repo = await scratchRepo();
      try {
        const gh = createFakeGh({ failView: "gh: no remote", login: LOGIN, repo: REPO });
        await deployAndCommit(repo, "69", "sess-69");
        await pushSignal(repo, "sess-69", "end-of-session");
        const before = await sha(repo);

        const report = await completeReadyTickets(options(repo, gh));

        expect(report.tracker).toBeNull();
        expect(report.completed).toEqual([]);
        expect(await sha(repo)).toBe(before);
        expect(report.degraded.join("\n")).toContain("tracker");
      } finally {
        await cleanup(repo);
      }
    },
    BUDGET_MS,
  );
});
