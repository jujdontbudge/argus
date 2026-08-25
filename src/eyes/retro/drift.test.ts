import { describe, expect, test } from "bun:test";
import type { AttributedChanges } from "./attribution";
import type { DriftJudgment } from "./schema";
import type { GitCommit } from "./git";
import {
  buildDriftCandidates,
  buildDriftPrompt,
  decideDrift,
  isJudgeableScope,
  type TicketScope,
} from "./drift";

function commit(overrides: Partial<GitCommit> = {}): GitCommit {
  return {
    sha: "a".repeat(40),
    authorName: "Johan Sardar",
    authorEmail: "johansardar77@gmail.com",
    ts: "2026-08-25T10:00:00Z",
    subject: "feat: add the widget",
    body: "",
    files: ["src/widget.ts"],
    diff: "+export const widget = 1;\n",
    ...overrides,
  };
}

function attributed(overrides: Partial<AttributedChanges> = {}): AttributedChanges {
  return {
    dir: "/repo",
    commits: [commit()],
    workingTree: null,
    coverage: { by: "session-workspace", sessionId: "sess-seven", ticket: "7" },
    sessionIds: ["sess-seven"],
    ...overrides,
  };
}

describe("scope-drift candidates come from work a ticket session DOES cover", () => {
  test("a registered ticket session's changes become one candidate for its ticket", () => {
    const candidates = buildDriftCandidates({
      attributed: [attributed()],
      parentRepoOf: () => "/repo",
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.ticket).toBe("7");
    expect(candidates[0]!.repoRoot).toBe("/repo");
    expect(candidates[0]!.sessionIds).toEqual(["sess-seven"]);
    expect(candidates[0]!.work.map(({ dir }) => dir)).toEqual(["/repo"]);
  });

  test("changes with nothing in them are not a question worth asking", () => {
    expect(
      buildDriftCandidates({
        attributed: [attributed({ commits: [], workingTree: null })],
        parentRepoOf: () => "/repo",
      }),
    ).toEqual([]);
  });

  test("one ticket's work across its worktrees is ONE question, not one per checkout", () => {
    const candidates = buildDriftCandidates({
      attributed: [
        attributed({ dir: "/repo" }),
        attributed({ dir: "/worktrees/seven", commits: [commit({ sha: "b".repeat(40) })] }),
      ],
      parentRepoOf: () => "/repo",
    });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.work.map(({ dir }) => dir)).toEqual([
      "/repo",
      "/worktrees/seven",
    ]);
  });

  test("a diff spanning several parent repos is judged per parent repo", () => {
    const candidates = buildDriftCandidates({
      attributed: [
        attributed({ dir: "/repo-a" }),
        attributed({ dir: "/repo-b", commits: [commit({ sha: "c".repeat(40) })] }),
      ],
      parentRepoOf: (dir) => dir,
    });

    expect(candidates.map(({ repoRoot }) => repoRoot)).toEqual(["/repo-a", "/repo-b"]);
    expect(candidates[0]!.id).not.toBe(candidates[1]!.id);
  });

  test("the id is content-derived, so the same unjudged work always keys the same", () => {
    const build = () =>
      buildDriftCandidates({
        attributed: [attributed()],
        parentRepoOf: () => "/repo",
      })[0]!.id;

    expect(build()).toBe(build());
    expect(
      buildDriftCandidates({
        attributed: [attributed({ commits: [commit({ sha: "d".repeat(40) })] })],
        parentRepoOf: () => "/repo",
      })[0]!.id,
    ).not.toBe(build());
  });
});

describe("too little stated scope is never a guess (the ticket says nothing)", () => {
  const scope = (body: string): TicketScope => ({
    number: "7",
    title: "Ship the widget pipeline",
    body,
    state: "open",
  });

  test("a ticket with a real body is judgeable", () => {
    expect(
      isJudgeableScope(
        scope(
          "Build the widget renderer and its cache.\n\nThe pipeline must stream," +
            " and the renderer needs a fixture test.",
        ),
      ),
    ).toBe(true);
  });

  test("an empty body states no scope, so there is nothing to judge against", () => {
    expect(isJudgeableScope(scope(""))).toBe(false);
    expect(isJudgeableScope(scope("   \n\n  "))).toBe(false);
  });

  test("a one-line body is a label, not a scope: still nothing to judge", () => {
    expect(
      isJudgeableScope(scope("Build the widget renderer and its streaming cache.")),
    ).toBe(false);
  });

  test("two lines of near-nothing is not scope either", () => {
    expect(isJudgeableScope(scope("do it\nthanks"))).toBe(false);
  });

  test("a CLOSED ticket is still judged — closing it does not un-state its scope", () => {
    expect(
      isJudgeableScope({
        ...scope(
          "Build the widget renderer and its cache.\n\nThe pipeline must stream," +
            " and the renderer needs a fixture test.",
        ),
        state: "closed",
      }),
    ).toBe(true);
  });
});

describe("the burden of proof is on DRIFT (the encoded policy)", () => {
  const judged = (overrides: Partial<DriftJudgment> = {}): DriftJudgment => ({
    candidateId: "drift-abc123",
    drift: true,
    confident: true,
    what: "Stripe billing webhooks",
    outOfScopeWork: "Added src/billing/stripe-webhooks.ts and wired its routes.",
    whyOutOfScope: "The ticket states the widget pipeline; billing is another goal.",
    ...overrides,
  });

  test("a confident, articulated drift files", () => {
    expect(decideDrift(judged()).file).toBe(true);
  });

  test("`drift: false` is silence — the ordinary case", () => {
    const decision = decideDrift(
      judged({ drift: false, what: null, outOfScopeWork: null, whyOutOfScope: null }),
    );
    expect(decision.file).toBe(false);
    expect(decision.reason).toContain("not drift");
  });

  test("an UNCONFIDENT drift is silence: ambiguity never files", () => {
    const decision = decideDrift(judged({ confident: false }));
    expect(decision.file).toBe(false);
    expect(decision.reason).toContain("not confident");
  });

  test("a drift the model cannot describe concretely is not a drift", () => {
    expect(decideDrift(judged({ outOfScopeWork: null })).file).toBe(false);
    expect(decideDrift(judged({ outOfScopeWork: "   " })).file).toBe(false);
    expect(decideDrift(judged({ what: null })).file).toBe(false);
  });

  test("a drift with no stated reason does not file either", () => {
    expect(decideDrift(judged({ whyOutOfScope: null })).file).toBe(false);
  });

  test("every refusal says WHY, so a missed drift is auditable", () => {
    for (const judgment of [
      judged({ drift: false }),
      judged({ confident: false }),
      judged({ outOfScopeWork: null }),
    ]) {
      expect(decideDrift(judgment).reason.length).toBeGreaterThan(0);
    }
  });
});

describe("the prompt states the policy the eye enforces", () => {
  const candidate = buildDriftCandidates({
    attributed: [attributed()],
    parentRepoOf: () => "/repo",
  })[0]!;
  const scope: TicketScope = {
    number: "7",
    title: "Ship the widget pipeline",
    body: "Build the widget renderer and its cache.\nThe pipeline must stream.",
    state: "open",
  };
  const prompt = buildDriftPrompt([{ candidate, scope }]);

  test("it asks the one question, per candidate id", () => {
    expect(prompt).toContain("is this diff what the ticket asked for");
    expect(prompt).toContain(`[candidate=${candidate.id}`);
    expect(prompt).toContain("#7 Ship the widget pipeline");
    expect(prompt).toContain("The pipeline must stream.");
  });

  test("it states the burden of proof, the safe list, and the cost asymmetry", () => {
    expect(prompt).toContain("burden of proof is on DRIFT");
    expect(prompt).toContain("refactor");
    expect(prompt).toContain("test");
    expect(prompt).toContain("rename");
    expect(prompt).toContain("gates");
    expect(prompt).toContain("DIFFERENT goal");
    expect(prompt.toLowerCase()).toContain("ambigu");
    expect(prompt).toContain("false positive");
  });

  test("it shows the diff, and a huge diff degrades instead of blowing the prompt", () => {
    const huge = buildDriftCandidates({
      attributed: [
        attributed({
          commits: [
            commit({ diff: `+${"x".repeat(400_000)}\n`, subject: "feat: enormous" }),
          ],
        }),
      ],
      parentRepoOf: () => "/repo",
    })[0]!;

    const bounded = buildDriftPrompt([{ candidate: huge, scope }]);

    expect(bounded).toContain("feat: enormous");
    expect(bounded.length).toBeLessThan(60_000);
    expect(bounded).toContain("truncated");
    // Truncation is not evidence: the model must not read elision as guilt.
    expect(bounded.toLowerCase()).toContain("not evidence of drift");
  });

  test("an enormous ticket body is capped too", () => {
    const bounded = buildDriftPrompt([
      { candidate, scope: { ...scope, body: "y".repeat(200_000) } },
    ]);
    expect(bounded.length).toBeLessThan(60_000);
  });
});
