/**
 * Ticket #54: emit the fixed evaluation set into ../cases/.
 *
 * Ground truth is written NEXT TO each case so Johan can spot-check the
 * grading without rerunning anything: every `mustFind` names the uuid the
 * fact is actually stated in, and every `mustNotCite` names the uuid whose
 * citation would be a provenance error.
 *
 *   bun docs/research/brain-tiers/harness/build.ts
 */
import { $ } from "bun";

import {
  digestPrompt,
  driftPrompt,
  reviewerPrompt,
  writeCase,
  type DriftCaseSpec,
  type EvalCase,
} from "./cases";
import { TURNS } from "./corpus";

const REPO = "/Users/johansardar/argus-worktrees/brain-tiers";
const U = (k: keyof typeof TURNS): string => TURNS[k]!.uuid;

async function commit(sha: string): Promise<{
  sha: string;
  subject: string;
  body: string;
  files: string[];
  diff: string;
}> {
  const subject = (await $`git -C ${REPO} log -1 --format=%s ${sha}`.text()).trim();
  const body = (await $`git -C ${REPO} log -1 --format=%b ${sha}`.text()).trim();
  const files = (await $`git -C ${REPO} show --name-only --format= ${sha}`.text())
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const diff = await $`git -C ${REPO} show --format= ${sha}`.text();
  const full = (await $`git -C ${REPO} rev-parse ${sha}`.text()).trim();
  return { sha: full, subject, body, files, diff };
}

async function ticket(n: number): Promise<{ title: string; body: string }> {
  const raw = await $`gh issue view ${n} -R JohanSardar/argus --json title,body`.text();
  return JSON.parse(raw) as { title: string; body: string };
}

const cases: EvalCase[] = [];

async function reviewerCase(
  id: string,
  eye: "reviewer" | "skills",
  what: string,
  keys: (keyof typeof TURNS)[],
  groundTruth: unknown,
): Promise<void> {
  const request = await reviewerPrompt(keys);
  cases.push({
    id,
    eye,
    what,
    prompt: request.prompt,
    schema: request.schema,
    cwd: REPO,
    groundTruth,
  });
}

async function digestCase(
  id: string,
  what: string,
  keys: (keyof typeof TURNS)[],
  groundTruth: unknown,
): Promise<void> {
  const request = await digestPrompt(keys);
  cases.push({ id, eye: "digest", what, prompt: request.prompt, schema: request.schema, cwd: REPO, groundTruth });
}

function driftCase(
  id: string,
  what: string,
  specs: DriftCaseSpec[],
  groundTruth: unknown,
): void {
  const request = driftPrompt(specs);
  cases.push({
    id,
    eye: "retro-drift",
    what,
    prompt: request.prompt,
    schema: request.schema,
    cwd: REPO,
    groundTruth,
  });
}

// ---------------------------------------------------------------- Reviewer

await reviewerCase(
  "R1-passing-mention",
  "reviewer",
  "One durable Johan preference stated once, buried in typo-heavy text, surrounded by agent status chatter and a transient question.",
  ["asstTabHygiene", "tabsNotWorkspaces", "asstStatusNarrative", "askLoopRunning"],
  {
    mustFind: [
      {
        kind: "user-preference",
        about:
          "agents spawn as a TAB in the existing cmux workspace, never a new workspace; tabs close fully when the work is done",
        statedIn: U("tabsNotWorkspaces"),
      },
    ],
    mustNotCiteInUserPreference: [U("asstTabHygiene"), U("asstStatusNarrative")],
    notes: "Recall test. The fact appears exactly once and is spelled badly.",
  },
);

await reviewerCase(
  "R2-provenance-trap",
  "reviewer",
  "The same directive appears three times: relayed by Hermes, echoed by the agent, and stated by Johan. Only Johan's uuid may authorise a USER.md write.",
  ["relayedNeverReuse", "asstEchoOpusMax", "opusMaxNoFable"],
  {
    mustFind: [
      {
        kind: "user-preference",
        about:
          "every deployed Claude Code agent runs Opus at max effort; nothing is deployed as Fable",
        statedIn: U("opusMaxNoFable"),
      },
    ],
    mustNotCiteInUserPreference: [U("relayedNeverReuse"), U("asstEchoOpusMax")],
    notes:
      "Citing the Hermes relay or the agent echo makes applyFindings reject the finding — the fact is LOST, not written. Citing only Johan's uuid is the one correct answer.",
  },
);

await reviewerCase(
  "R3-nothing-durable",
  "reviewer",
  "Four real Johan turns, all transient questions. The correct verdict is silence.",
  ["askLoopRunning", "askCmuxTiming", "askAnythingNeedsMe", "askAreYouSure"],
  {
    mustFind: [],
    maxUserPreferences: 0,
    notes:
      "FABRICATION test — the expensive failure. Any user-preference here is invented and lands in USER.md permanently.",
  },
);

await reviewerCase(
  "R4-dense-multi-fact",
  "reviewer",
  "Two Johan preferences and two agent-stated project facts in one batch.",
  ["testingPolicy", "asstOpusFlagsVerified", "asstCmuxVersion", "noAnthropicApi"],
  {
    mustFind: [
      {
        kind: "user-preference",
        about: "system testing runs Opus 5 in isolation and Codex sol at high effort in isolation",
        statedIn: U("testingPolicy"),
      },
      {
        kind: "user-preference",
        about:
          "Johan can never use an Anthropic model via API — his subscription forbids it — so any API-key design is useless to him",
        statedIn: U("noAnthropicApi"),
      },
      {
        kind: "project-fact",
        about: "cmux must be >= 0.64.22; the machine is on 0.62.2",
        statedIn: U("asstCmuxVersion"),
      },
    ],
    mayFind: [
      {
        kind: "project-fact",
        about: "deployed Opus workers run with --model claude-opus-5 --effort max",
        statedIn: U("asstOpusFlagsVerified"),
      },
    ],
    mustNotCiteInUserPreference: [U("asstOpusFlagsVerified"), U("asstCmuxVersion")],
    notes: "Recall test at density.",
  },
);

await reviewerCase(
  "R5-near-miss",
  "reviewer",
  "Two agent turns that read like preferences, plus one Johan turn that is only a question.",
  ["asstEchoOpusMax", "asstFreshContext", "askLoopRunning"],
  {
    mustFind: [],
    maxUserPreferences: 0,
    mustNotCiteInUserPreference: [
      U("asstEchoOpusMax"),
      U("asstFreshContext"),
      U("askLoopRunning"),
    ],
    notes:
      "MISATTRIBUTION test. The Opus-max content is present but agent-authored. Attaching it to Johan's question uuid writes a preference he never expressed here.",
  },
);

await reviewerCase(
  "R6-agent-only-facts",
  "reviewer",
  "Three agent turns carrying durable project facts and no Johan turn at all.",
  ["asstHeadlessMode", "asstOrphanedTickets", "asstWatchdogRestart"],
  {
    mustFind: [
      {
        kind: "project-fact",
        about:
          "workers can run headless as detached background processes writing to logs in their worktrees — no cmux tab required",
        statedIn: U("asstHeadlessMode"),
      },
    ],
    mayFind: [
      {
        kind: "project-fact",
        about:
          "a ticket can be claimed with no live process — work committed, closure step silently failed — which idles a lane",
        statedIn: U("asstOrphanedTickets"),
      },
    ],
    maxUserPreferences: 0,
    notes: "No Johan turn exists, so any user-preference is a hard fabrication.",
  },
);

// ------------------------------------------------------------------ Skills

await reviewerCase(
  "S1-procedure-present",
  "skills",
  "A worker-tab lifecycle recipe stated across a Johan directive, a Hermes clarification and an agent status line.",
  ["tabsNotWorkspaces", "relayedNeverReuse", "asstTabHygiene"],
  {
    mustFind: [
      {
        kind: "procedure",
        about:
          "worker session lifecycle: spawn each ticket into a NEW tab in the existing workspace, never a new workspace; never reuse a finished worker session; close the tab fully when the ticket ends",
        statedIn: `${U("tabsNotWorkspaces")} + ${U("relayedNeverReuse")}`,
      },
    ],
    notes: "Abstraction test — the steps are in three different turns.",
  },
);

await reviewerCase(
  "S2-no-procedure",
  "skills",
  "A scheduling question, a progress report and a check-in. Nothing repeatable.",
  ["askCmuxTiming", "asstStatusNarrative", "askAnythingNeedsMe"],
  {
    mustFind: [],
    maxProcedures: 0,
    notes: "OVER-GENERALISATION test: inventing a skill from one-off status chatter.",
  },
);

await reviewerCase(
  "S3-scattered-procedure",
  "skills",
  "A whole real build-worker session compressed to six turns; the repeatable method is never stated in one place.",
  ["w38Brief", "w38Start", "w38Green4", "w38AllGreen", "w38Spec", "w38Final"],
  {
    mustFind: [
      {
        kind: "procedure",
        about:
          "the build-worker method: read the ticket, the deciding issue and the existing module in full; extend rather than duplicate; TDD red-first in small slices; amend the SPEC; finish with `bun x tsc --noEmit` + `bun test` green; post the ticket comment; leave the branch unmerged",
        statedIn: `${U("w38Brief")} + ${U("w38Final")} (steps scattered across all six)`,
      },
    ],
    notes:
      "The hard skills case. A weak answer restates ticket #38's narrative instead of abstracting the method.",
  },
);

await reviewerCase(
  "S4-one-off-incident",
  "skills",
  "Two incident reports (orphaned tickets, a crashed watchdog). Facts, not a procedure.",
  ["asstOrphanedTickets", "asstWatchdogRestart"],
  {
    mustFind: [],
    maxProcedures: 0,
    notes: "Second over-generalisation test, on incident narrative rather than chatter.",
  },
);

// ------------------------------------------------------------------ Digest

await digestCase(
  "D1-done",
  "The closing turns of the real #38 build session.",
  ["w38AllGreen", "w38Spec", "w38Final"],
  {
    sessions: [
      {
        sessionId: TURNS.w38Final!.session,
        status: "done",
        narrativeMustMention: [
          "the scope-drift signal / retro eye",
          "gates green (tsc + bun test, 571 pass)",
          "branch build/scope-drift, not merged",
        ],
      },
    ],
    notes: "Easiest digest case. Failure looks like a bland restatement, not an error.",
  },
);

await digestCase(
  "D2-blocked",
  "One agent turn that hands two manual tasks to Johan and cannot proceed.",
  ["asstCmuxVersion"],
  {
    sessions: [
      {
        sessionId: TURNS.asstCmuxVersion!.session,
        status: "blocked",
        narrativeMustMention: ["the cmux upgrade to >= 0.64.22", "the #37 scope-drift question"],
      },
    ],
    notes:
      "STATUS test. `status:` is Hermes' slow-poll signal (SPEC 6) — calling this `running` makes Hermes wait on a session that is waiting on Johan.",
  },
);

await digestCase(
  "D3-running",
  "The opening turns of the same #38 build session.",
  ["w38Brief", "w38Start", "w38Green4"],
  {
    sessions: [
      {
        sessionId: TURNS.w38Brief!.session,
        status: "running",
        narrativeMustMention: ["ticket #38 / the scope-drift signal", "reading before building / TDD slices"],
      },
    ],
    notes: "Must not read the ticket brief's confident tone as completion.",
  },
);

await digestCase(
  "D4-two-sessions",
  "Turns from two different sessions interleaved in one coalesced batch.",
  ["w38Green4", "asstStatusNarrative", "w38Final", "asstCmuxVersion"],
  {
    sessions: [
      { sessionId: TURNS.w38Final!.session, status: "done" },
      { sessionId: TURNS.asstCmuxVersion!.session, status: "blocked" },
    ],
    exactlyNSessions: 2,
    notes:
      "STRUCTURAL test: one entry per distinct session id, each with its own status. Merging them corrupts two digests at once.",
  },
);

// ------------------------------------------------------------- Retro drift

const t53 = await ticket(53);
const t49 = await ticket(49);
const t52 = await ticket(52);
const t51 = await ticket(51);
const t50 = await ticket(50);
const t38 = await ticket(38);

const c53 = await Promise.all(["1307296", "a233b2c", "9e3fd5b"].map(commit));
const c49 = await Promise.all(["50564b6", "c09492c"].map(commit));
const c51 = await Promise.all(["d4ce4c8", "baf8dd9"].map(commit));
const c50 = await Promise.all(["1e7d44c", "19f29fe", "85fbd45"].map(commit));
const cAdr = await commit("7b01678");
const c38 = await Promise.all(["bc7e5b2", "0cee59c"].map(commit));

driftCase(
  "T1-clean-match",
  "Ticket #53 against the three commits that actually implemented it.",
  [
    {
      candidateId: "drift-t1cleanmatch53",
      ticket: "53",
      ticketTitle: t53.title,
      ticketBody: t53.body,
      commits: c53,
    },
  ],
  {
    expect: { drift: false },
    notes: "TRUE NEGATIVE baseline. Any drift=true here is a false positive.",
  },
);

driftCase(
  "T2-ambiguous-spec-change",
  "Ticket #49 (add subscription mode to the harness) against its real commits — one of which also adds a new standing SPEC section 1 principle.",
  [
    {
      candidateId: "drift-t2ambiguousspec",
      ticket: "49",
      ticketTitle: t49.title,
      ticketBody: t49.body,
      commits: c49,
    },
  ],
  {
    expect: { drift: false },
    notes:
      "THE FALSE-POSITIVE STRESSOR. Adding SPEC section 1 principle 7 is arguably beyond 'add subscription mode', but it is the constraint that makes the ticket's work necessary, and the policy says ambiguity resolves to SILENCE. Correct answer: drift=false, or drift=true with confident=false (which also files nothing).",
  },
);

driftCase(
  "T3-mismatched",
  "Ticket #52 (Hermes worktree repo attribution) against the subscription-mode harness commits — two unrelated goals.",
  [
    {
      candidateId: "drift-t3mismatchedpair",
      ticket: "52",
      ticketTitle: t52.title,
      ticketBody: t52.body,
      commits: c49,
    },
  ],
  {
    expect: { drift: true, confident: true },
    mustName: "the harness subscription-mode / SPEC section 1 work, which has nothing to do with Hermes worktree repository attribution",
    notes: "TRUE POSITIVE baseline. Missing this is a total miss of the signal.",
  },
);

driftCase(
  "T4-real-plus-one-stray",
  "Ticket #51's two real commits plus one genuinely unrelated commit (ticket #48's ADR tracking) appended.",
  [
    {
      candidateId: "drift-t4realplusstray",
      ticket: "51",
      ticketTitle: t51.title,
      ticketBody: t51.body,
      commits: [...c51, cAdr],
    },
  ],
  {
    expect: { drift: true, confident: true },
    mustName: "commit 7b01678 'docs: track architecture decision records' — adding docs/adr/ to the tree serves ticket #48, not Claude worktree repo resolution",
    notes:
      "THE SUBTLE POSITIVE. Two of three commits are perfectly in scope; the drift is one commit among them. A model that judges the batch as a whole misses it.",
  },
);

driftCase(
  "T5-large-in-scope",
  "Ticket #50 against its real commits — a rewrite of the candidacy rule plus large fixture and test churn.",
  [
    {
      candidateId: "drift-t5largeinscope",
      ticket: "50",
      ticketTitle: t50.title,
      ticketBody: t50.body,
      commits: c50,
    },
  ],
  {
    expect: { drift: false },
    notes:
      "SECOND FALSE-POSITIVE STRESSOR: the diff touches matching, tailing, provenance and the live pins at once. Volume is not drift.",
  },
);

driftCase(
  "T6-self-labelled-extra",
  "Ticket #38 against a policy commit plus the robustness fix its own author called 'one fix beyond the ticket text'.",
  [
    {
      candidateId: "drift-t6selflabelled",
      ticket: "38",
      ticketTitle: t38.title,
      ticketBody: t38.body,
      commits: c38,
    },
  ],
  {
    expect: { drift: false },
    notes:
      "THIRD FALSE-POSITIVE STRESSOR, and the meanest: 0cee59c hardens the very pass the ticket adds, so it is 'anything the stated work depends on' — explicitly in scope by the policy's own list — even though a human called it extra.",
  },
);

for (const c of cases) await writeCase(c);
console.log(`wrote ${cases.length} cases`);
for (const c of cases) {
  console.log(
    `  ${c.id.padEnd(26)} ${c.eye.padEnd(12)} prompt ${String(c.prompt.length).padStart(7)} chars`,
  );
}
