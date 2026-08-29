import { describe, expect, test } from "bun:test";
import type { RogueChanges } from "./attribution";
import {
  composeRetro,
  composeScopeDrift,
  MAX_BODY_BYTES,
  type RetroPrompt,
} from "./compose";
import type { DriftCandidate, TicketScope } from "./drift";
import type { DriftJudgment } from "./schema";
import type { RetroSignal } from "./signal";

const changes: RogueChanges = {
  dir: "/repo",
  commits: [
    {
      sha: "abc1234def567890abc1234def567890abc12345",
      authorName: "Johan Sardar",
      authorEmail: "johansardar77@gmail.com",
      ts: "2026-08-24T12:05:00Z",
      subject: "add the frobnicator",
      body: "",
      files: ["src/frobnicator.ts"],
      diff: "--- /dev/null\n+++ b/src/frobnicator.ts\n+export const frobnicate = () => {};",
    },
  ],
  workingTree: null,
  sessionIds: ["sess-rogue"],
  referencedTickets: [],
  sessionTickets: [],
};

const signal: RetroSignal = {
  id: "retro-0123456789abcdef",
  sources: ["git", "transcript"],
  dir: "/repo",
  changes,
  sessions: [
    {
      sessionId: "sess-rogue",
      agent: "claude",
      digestFile: "adhoc-sess-rogue.md",
      narrative: "Implemented the frobnicator end to end.",
      johanTouched: true,
    },
  ],
  referencedTickets: [],
  sessionTickets: [],
};

const johanPrompt: RetroPrompt = {
  sessionId: "sess-rogue",
  ts: "2026-08-24T12:00:00Z",
  text: "just add a frobnicator to the widget module, don't bother with a ticket",
  author: "johan",
};

function compose(overrides: Parameters<typeof composeRetro>[0] extends infer T
  ? Partial<T>
  : never = {}) {
  return composeRetro({
    what: "frobnicator implemented with no ticket",
    summary: "A session with no registered ticket added src/frobnicator.ts.",
    signal,
    prompts: [johanPrompt],
    parent: { parent: "15", rule: "session-ticket" },
    repoRoot: "/repo",
    ...overrides,
  });
}

describe("composing the retro ticket (SPEC §5.5: prompts + the diff)", () => {
  test("the title is `Retro: <what>`", () => {
    expect(compose().title).toBe("Retro: frobnicator implemented with no ticket");
  });

  test("a runaway title is capped to what GitHub accepts", () => {
    const title = compose({ what: "x".repeat(500) }).title;
    expect(title.length).toBeLessThanOrEqual(256);
    expect(title.startsWith("Retro: xxx")).toBe(true);
    expect(title.endsWith("…")).toBe(true);
  });

  test("the body carries Johan's prompts and the diff", () => {
    const { body } = compose();
    expect(body).toContain(
      "just add a frobnicator to the widget module, don't bother with a ticket",
    );
    expect(body).toContain("+export const frobnicate = () => {};");
    expect(body).toContain("```diff");
    expect(body).toContain("src/frobnicator.ts");
    expect(body).toContain("abc1234"); // the commit is cited
  });

  test("the body says how it was detected and how the parent was chosen", () => {
    const { body } = compose();
    expect(body).toContain("Argus Retro eye");
    expect(body).toContain("git");
    expect(body).toContain("transcript");
    expect(body).toContain("sess-rogue");
    expect(body).toContain("session-ticket");
    expect(body).toContain("retro-0123456789abcdef");
  });

  test("ONLY provenance-verified Johan prompts are quoted as Johan's", () => {
    const { body } = compose({
      prompts: [
        johanPrompt,
        {
          sessionId: "sess-rogue",
          ts: "2026-08-24T12:01:00Z",
          text: "HERMES DISPATCH: implement ticket #9 and stop",
          author: "hermes",
        },
        {
          sessionId: "sess-rogue",
          ts: "2026-08-24T12:02:00Z",
          text: "I have implemented the frobnicator.",
          author: "agent",
        },
      ],
    });

    expect(body).toContain("just add a frobnicator");
    expect(body).not.toContain("HERMES DISPATCH");
    expect(body).not.toContain("I have implemented the frobnicator.");
  });

  test("autonomous work with no Johan prompts says so instead of an empty section", () => {
    const { body } = compose({ prompts: [] });
    expect(body).toMatch(/no Johan-authored prompts/i);
  });

  test("the digest narrative rides along as the transcript evidence", () => {
    expect(compose().body).toContain("Implemented the frobnicator end to end.");
  });

  test("uncommitted work is described as uncommitted", () => {
    const { body } = compose({
      signal: {
        ...signal,
        sources: ["git"],
        changes: {
          ...changes,
          commits: [],
          workingTree: { files: ["src/wip.ts"], diff: "+const wip = 1;" },
        },
      },
    });
    expect(body).toMatch(/uncommitted/i);
    expect(body).toContain("src/wip.ts");
    expect(body).toContain("+const wip = 1;");
  });

  test("an enormous diff is truncated so the body always fits GitHub", () => {
    const { body } = compose({
      signal: {
        ...signal,
        changes: {
          ...changes,
          commits: [{ ...changes.commits[0]!, diff: "+x\n".repeat(60_000) }],
        },
      },
    });
    expect(body.length).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(body).toMatch(/truncated/i);
    // Truncation never eats the sections that make the retro readable.
    expect(body).toContain("just add a frobnicator");
  });

  test("oversized prompts, narratives, and file lists are bounded before composition", () => {
    const files = Array.from({ length: 6_000 }, (_, index) =>
      `generated/${index}/${"deep-".repeat(30)}asset.png`,
    );
    const sessions = Array.from({ length: 100 }, (_, index) => ({
      sessionId: `session-${index}`,
      agent: "claude",
      digestFile: `adhoc-session-${index}.md`,
      narrative: `narrative-${index}:${"n".repeat(200_000)}`,
      johanTouched: true,
    }));
    const prompts = Array.from({ length: 100 }, (_, index) => ({
      sessionId: `session-${index}`,
      ts: "2026-08-29T20:00:00.000Z",
      text: `prompt-${index}:${"p".repeat(200_000)}`,
      author: "johan" as const,
    }));

    const { body } = compose({
      prompts,
      signal: {
        ...signal,
        sessions,
        changes: {
          ...changes,
          commits: [],
          workingTree: { files, diff: "+x\n".repeat(100_000) },
        },
      },
    });

    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(body).toContain("retro-0123456789abcdef");
    expect(body).toMatch(/truncated|omitted/i);
  });

  test("a transcript-only signal still composes a complete body", () => {
    const { body } = compose({
      signal: { ...signal, sources: ["transcript"], changes: null, dir: null },
      parent: { parent: null, rule: "root-level" },
    });
    expect(body).toContain("Implemented the frobnicator end to end.");
    expect(body).toContain("root-level");
    expect(body).toMatch(/no git changes/i);
  });
});

describe("composing an in-ticket scope-drift retro (#38)", () => {
  const candidate: DriftCandidate = {
    id: "drift-0123456789abcdef",
    ticket: "7",
    repoRoot: "/repo",
    sessionIds: ["sess-seven"],
    work: [
      {
        dir: "/worktrees/seven",
        commits: [
          {
            sha: "feed1234def567890abc1234def567890abc1234",
            authorName: "Johan Sardar",
            authorEmail: "johansardar77@gmail.com",
            ts: "2026-08-25T09:00:00Z",
            subject: "feat: stripe billing webhooks",
            body: "",
            files: ["src/billing/stripe-webhooks.ts"],
            diff: "--- /dev/null\n+++ b/src/billing/stripe-webhooks.ts\n+export const onStripeEvent = () => {};",
          },
        ],
        workingTree: null,
      },
    ],
  };
  const scope: TicketScope = {
    number: "7",
    title: "Ship the widget pipeline",
    body: "Build the widget renderer and its cache.\nThe pipeline must stream.",
    state: "open",
  };
  const judgment: DriftJudgment = {
    candidateId: candidate.id,
    drift: true,
    confident: true,
    what: "Stripe billing webhooks",
    outOfScopeWork:
      "Added src/billing/stripe-webhooks.ts, a Stripe event handler and its route.",
    whyOutOfScope: "The ticket states the widget pipeline; billing is a different goal.",
  };
  const composed = composeScopeDrift({ candidate, scope, judgment });

  test("the title names the drift and the ticket it drifted from", () => {
    expect(composed.title).toContain("Stripe billing webhooks");
    expect(composed.title).toContain("#7");
    expect(composed.title.startsWith("Retro: ")).toBe(true);
  });

  test("the body NAMES the ticket and QUOTES its stated scope", () => {
    expect(composed.body).toContain("#7 Ship the widget pipeline");
    expect(composed.body).toContain("> Build the widget renderer and its cache.");
    expect(composed.body).toContain("> The pipeline must stream.");
  });

  test("the body describes the out-of-scope work concretely, with the diff", () => {
    expect(composed.body).toContain(
      "Added src/billing/stripe-webhooks.ts, a Stripe event handler and its route.",
    );
    expect(composed.body).toContain("billing is a different goal");
    expect(composed.body).toContain("`src/billing/stripe-webhooks.ts`");
    expect(composed.body).toContain("+export const onStripeEvent = () => {};");
    expect(composed.body).toContain("feed123");
    expect(composed.body).toContain("sess-seven");
    expect(composed.body).toContain("/worktrees/seven");
  });

  test("it says a wrong call is cheap to close — the retro invites correction", () => {
    expect(composed.body.toLowerCase()).toContain("scope drift");
    expect(composed.body).toContain(candidate.id);
  });

  test("a closed parent ticket is composed against, not crashed on", () => {
    const onClosed = composeScopeDrift({
      candidate,
      scope: { ...scope, state: "closed" },
      judgment,
    });
    expect(onClosed.body).toContain("closed");
    expect(onClosed.body).toContain("#7 Ship the widget pipeline");
  });

  test("a huge diff loses bytes from the DIFF, never from the record", () => {
    const enormous = composeScopeDrift({
      candidate: {
        ...candidate,
        work: [
          {
            ...candidate.work[0]!,
            commits: [
              { ...candidate.work[0]!.commits[0]!, diff: `+${"x".repeat(400_000)}` },
            ],
          },
        ],
      },
      scope,
      judgment,
    });

    expect(enormous.body.length).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(enormous.body).toContain("> Build the widget renderer and its cache.");
    expect(enormous.body).toContain(
      "Added src/billing/stripe-webhooks.ts, a Stripe event handler and its route.",
    );
  });
});
