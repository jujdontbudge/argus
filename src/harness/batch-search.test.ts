import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  BATCH_SEARCH_GATE,
  BATCH_TICKETS,
  batchSearchTitle,
  describeBatchSearchGate,
  probeBatchSearch,
  resolveBatchSearchGate,
  runBatchAndSearch,
  SPEC_BULLET_2,
  SPEC_BULLET_4,
  SPEC_SECTION_14_HEADING,
  type BatchSearchReport,
} from "./batch-search.ts";
import { writeBatchEvidence } from "./batch-search-evidence.ts";

/**
 * Ticket #92 — the gate, the banner, and the live batch.
 *
 * The banner prints on EVERY `bun test`, gate open or shut, for #46's reason:
 * `bun test` prints no name for a skipped test, so a silently-skipped live
 * drive is indistinguishable from one nobody ever wrote.
 */
const CHECKOUT = fileURLToPath(new URL("../..", import.meta.url));
const gate = resolveBatchSearchGate(probeBatchSearch());
// eslint-disable-next-line no-console
console.log(describeBatchSearchGate(gate));

describe("#92: SPEC §14's own words, not the ticket's", () => {
  test("both bullets are quoted from SPEC.md byte-for-byte", async () => {
    const spec = await readFile(new URL("../../SPEC.md", import.meta.url), "utf8");
    expect(spec).toContain(SPEC_SECTION_14_HEADING);
    expect(spec).toContain(SPEC_BULLET_2);
    expect(spec).toContain(SPEC_BULLET_4);
  });

  test("§14 is where this ticket says the bullets are — and it is not", async () => {
    // #89's finding, made mechanical. The ticket cites SPEC.md:707-708 and
    // SPEC.md:730; §14 does not start until line 763. A quotation pinned to a
    // line number is a quotation that rots, so the assertions above match TEXT
    // and this one records what the line numbers actually are today.
    const lines = (await readFile(new URL("../../SPEC.md", import.meta.url), "utf8")).split("\n");
    const heading = lines.indexOf(SPEC_SECTION_14_HEADING) + 1;
    const bullet4 = lines.indexOf(SPEC_BULLET_4) + 1;
    expect(heading).toBeGreaterThan(730);
    expect(bullet4).toBeGreaterThan(730);
  });

  test("the batch's five tickets span both agents, including inside pass 1", () => {
    expect(BATCH_TICKETS).toHaveLength(5);
    // Bullet 4 is "any past session of ANY AGENT". The two tickets the search
    // retrieves (501, 502) must therefore be different agents AND both in the
    // first, three-at-a-time pass — otherwise the retrieval crosses only the
    // serialized tail of the batch.
    expect(BATCH_TICKETS[0]!.agent).not.toBe(BATCH_TICKETS[1]!.agent);
    expect(new Set(BATCH_TICKETS.map((ticket) => ticket.token)).size).toBe(5);
    for (const ticket of BATCH_TICKETS) {
      expect(ticket.token).toBe(`${ticket.halves[0]}-${ticket.halves[1]}`);
    }
  });

  test("the gate is its own, and shut by default", () => {
    const shut = resolveBatchSearchGate({
      claudeInstalled: true,
      codexAuthPresent: true,
      codexInstalled: true,
      env: {},
      nativeClaudeInstalled: true,
    });
    expect(shut.enabled).toBe(false);
    expect(shut.overall.status).toBe("gate-unset");

    // Another gate must never open this one.
    const other = resolveBatchSearchGate({
      claudeInstalled: true,
      codexAuthPresent: true,
      codexInstalled: true,
      env: { ARGUS_LIVE_AGENTS: "1", ARGUS_LIVE_FULL_JOURNEY: "1" },
      nativeClaudeInstalled: true,
    });
    expect(other.enabled).toBe(false);

    // One agent is not enough: bullet 4 is explicitly cross-agent.
    const halfOnly = resolveBatchSearchGate({
      claudeInstalled: true,
      codexAuthPresent: false,
      codexInstalled: true,
      env: { [BATCH_SEARCH_GATE]: "1" },
      nativeClaudeInstalled: true,
    });
    expect(halfOnly.claude.status).toBe("run");
    expect(halfOnly.codex.status).toBe("not-run");
    expect(halfOnly.overall.status).toBe("not-run");
    expect(batchSearchTitle("x", halfOnly.overall)).toContain("NOT RUN");
  });
});

describe("#92: the live batch — five tickets, a cap of three, and search across it", () => {
  test(
    batchSearchTitle(
      "SPEC §14 bullets 2 and 4, driven through dispatchFrontier",
      gate.overall,
    ),
    async () => {
      if (gate.overall.status !== "run") return;

      const { report, sandbox } = await runBatchAndSearch({ checkout: CHECKOUT });
      try {
        await writeBatchEvidence(report);
        assertBatch(report);
      } finally {
        await sandbox.teardown();
      }
    },
    3_600_000,
  );
});

/**
 * Every assertion #92 asks for, in its own order, applied to what the run
 * actually produced. Split out of the test body so the evidence file is
 * written FIRST: a failed assertion must still leave the artifact that
 * explains why.
 */
export function assertBatch(report: BatchSearchReport): void {
  expect(report.upExitCode).toBe(0);

  // ---- 1. The cap held -----------------------------------------------------
  //
  // Two independent readings, neither of them a counter the test kept:
  //
  //   (a) STRUCTURAL. `createDispatchSlots` builds exactly `maxConcurrency`
  //       paths and opens each `wx`. A fourth simultaneous holder has nowhere
  //       to go. The poller's peak is a check ON that, not a substitute.
  //   (b) THE FILES' OWN TIMESTAMPS. Group the observed occupancies by slot
  //       path; within one path, each occupant's `acquiredAt` must be strictly
  //       after the previous occupant's, because the path can only be taken
  //       again after an `unlink`.
  expect(report.timeline.peakConcurrentFiles).toBeLessThanOrEqual(3);
  expect(report.timeline.samples).toBeGreaterThan(10);
  const bySlot = new Map<string, string[]>();
  for (const occupancy of report.timeline.occupancies) {
    bySlot.set(occupancy.slot, [...(bySlot.get(occupancy.slot) ?? []), occupancy.acquiredAt]);
  }
  expect(bySlot.size).toBeLessThanOrEqual(3);
  for (const stamps of bySlot.values()) {
    const sorted = [...stamps].sort();
    expect(stamps).toEqual(sorted);
    expect(new Set(stamps).size).toBe(stamps.length);
  }

  // Pass 1 saw five dispatchable tickets and refused two of them. That refusal
  // — not the count of slot files — is the cap doing its job.
  const first = report.passes[0]!;
  expect(first.report.maxConcurrency).toBe(3);
  expect(first.report.dispatched).toHaveLength(3);
  expect(first.report.inFlight).toBe(3);

  // ---- 2. Three worktrees, three sessions, no sharing ----------------------
  expect(report.dispatched).toHaveLength(5);
  expect(new Set(report.dispatched.map((entry) => entry.ticket)).size).toBe(5);
  expect(new Set(report.dispatched.map((entry) => entry.worktree)).size).toBe(5);
  expect(new Set(report.dispatched.map((entry) => entry.sessionId)).size).toBe(5);
  expect(new Set(report.dispatched.map((entry) => entry.branch)).size).toBe(5);
  // Each ticket went to the agent its label routed it to (SPEC §2), not to a
  // default the harness forced.
  for (const entry of report.dispatched) {
    const ticket = BATCH_TICKETS.find((candidate) => candidate.number === entry.ticket)!;
    expect(entry.agent).toBe(ticket.agent);
  }
  // #89: every session ran in the deployment's own worktree, never in a real
  // repo. Asserted against the process's own cwd, not against the plan.
  for (const worker of report.workers) {
    expect(worker.cwd.startsWith(report.sandboxRoot)).toBe(true);
  }
  expect(report.workers).toHaveLength(5);

  // ---- 3. Every message reached the archive, attributed correctly ----------
  const sessions = new Map(report.dispatched.map((entry) => [entry.sessionId, entry]));
  for (const [sessionId, entry] of sessions) {
    const rows = report.archived.filter((row) => row.sessionId === sessionId);
    const prompts = rows.filter((row) => row.role === "user");
    expect(prompts.length).toBeGreaterThan(0);
    for (const prompt of prompts) {
      expect(prompt.provenance).toBe("hermes");
      expect(prompt.via).toBe("dispatch-prompt");
    }
    const ticket = BATCH_TICKETS.find((candidate) => candidate.number === entry.ticket)!;
    const replies = rows.filter(
      (row) => row.role === "assistant" && row.content.includes(ticket.token),
    );
    expect(replies.length).toBeGreaterThan(0);
    // Nothing misattributed across three simultaneous archiver writers: no
    // OTHER session's rows may carry this session's token.
    const strays = report.archived.filter(
      (row) => row.sessionId !== sessionId && row.content.includes(ticket.token),
    );
    expect(strays).toHaveLength(0);
  }

  // ---- 4. USER.md is byte-identical ---------------------------------------
  expect(report.userMdAfter).toBe(report.userMdBefore);
  expect(report.userMdBefore.length).toBeGreaterThan(0);

  // ---- 5. §14 bullet 4, through the CLI, across two agents -----------------
  expect(report.searches).toHaveLength(2);
  const agentsRetrieved = new Set<string>();
  for (const invocation of report.searches) {
    expect(invocation.exitCode).toBe(0);
    const ticket = BATCH_TICKETS.find((candidate) => candidate.token === invocation.query)!;
    const entry = report.dispatched.find((candidate) => candidate.ticket === ticket.number)!;
    // The hit names the right session AND the right agent.
    expect(invocation.stdout).toContain(`session=${entry.sessionId}`);
    expect(invocation.stdout).toContain(`agent=${ticket.agent}`);
    expect(invocation.stdout).toContain("role=assistant");
    // And names no OTHER batch session: a query that returned everything
    // would satisfy the two lines above while proving nothing.
    for (const other of report.dispatched) {
      if (other.sessionId === entry.sessionId) continue;
      expect(invocation.stdout).not.toContain(`session=${other.sessionId}`);
    }
    agentsRetrieved.add(ticket.agent);
  }
  expect([...agentsRetrieved].sort()).toEqual(["claude", "codex"]);
}
