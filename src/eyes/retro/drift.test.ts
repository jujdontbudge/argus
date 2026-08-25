import { describe, expect, test } from "bun:test";
import type { AttributedChanges } from "./attribution";
import type { GitCommit } from "./git";
import { buildDriftCandidates } from "./drift";

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
