import { describe, expect, test } from "bun:test";
import type { SessionRecord } from "../../provenance";
import { attributeChanges } from "./attribution";
import type { GitCommit, GitScan } from "./git";

function commit(overrides: Partial<GitCommit> = {}): GitCommit {
  return {
    sha: "a".repeat(40),
    authorName: "Johan Sardar",
    authorEmail: "johansardar77@gmail.com",
    ts: "2026-08-24T12:00:00Z",
    subject: "add the frobnicator",
    body: "",
    files: ["src/frobnicator.ts"],
    diff: "+export const frobnicate = () => {};",
    ...overrides,
  };
}

function scan(overrides: Partial<GitScan> = {}): GitScan {
  return {
    repoRoot: "/repo",
    roots: [{ dir: "/repo", commits: [commit()], workingTree: null }],
    seen: [],
    ...overrides,
  };
}

function registered(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    ts: "2026-08-24T11:00:00Z",
    sessionId: "sess-dispatch",
    dispatchPrompt: "Implement ticket #7.",
    agent: "codex",
    ticket: "7",
    workspace: "/worktrees/seven",
    ...overrides,
  };
}

/** A deployment with no ticket: a planning/grilling session (§7.5 exempt). */
function ticketless(overrides: Partial<SessionRecord>): SessionRecord {
  const { ticket: _ticket, ...rest } = registered(overrides);
  return rest;
}

describe("attribution: commits against registered ticket sessions (SPEC §5.5)", () => {
  test("a commit in a registered ticket session's workspace is attributed to it", () => {
    const result = attributeChanges(
      scan({
        roots: [{ dir: "/worktrees/seven", commits: [commit()], workingTree: null }],
      }),
      { sessions: [registered()] },
    );

    expect(result.rogue).toEqual([]);
    expect(result.attributed).toHaveLength(1);
    expect(result.attributed[0]!.coverage).toEqual({
      by: "session-workspace",
      sessionId: "sess-dispatch",
      ticket: "7",
    });
  });

  test("a commit naming a ticket a registered session claimed is attributed to it", () => {
    const result = attributeChanges(
      scan({
        roots: [
          {
            dir: "/repo",
            commits: [commit({ subject: "feat: widget (#7)" })],
            workingTree: null,
          },
        ],
      }),
      { sessions: [registered()] },
    );

    expect(result.rogue).toEqual([]);
    expect(result.attributed[0]!.coverage.by).toBe("registered-ticket-reference");
    expect(result.attributed[0]!.coverage.ticket).toBe("7");
  });

  test("a commit in a checkout no registered session owns is rogue", () => {
    const result = attributeChanges(scan(), { sessions: [registered()] });

    expect(result.attributed).toEqual([]);
    expect(result.rogue).toHaveLength(1);
    expect(result.rogue[0]!.dir).toBe("/repo");
    expect(result.rogue[0]!.commits.map((entry) => entry.subject)).toEqual([
      "add the frobnicator",
    ]);
    expect(result.rogue[0]!.referencedTickets).toEqual([]);
  });

  test("a rogue commit that names an UNCLAIMED ticket keeps it as a parent hint", () => {
    const result = attributeChanges(
      scan({
        roots: [
          {
            dir: "/repo",
            commits: [
              commit({ subject: "wire the widget", body: "part of #42, also #7x" }),
            ],
            workingTree: null,
          },
        ],
      }),
      { sessions: [] },
    );

    expect(result.rogue[0]!.referencedTickets).toEqual(["42"]);
  });

  test("registered sessions WITHOUT a ticket never attribute work away", () => {
    const result = attributeChanges(
      scan({
        roots: [{ dir: "/worktrees/grill", commits: [commit()], workingTree: null }],
      }),
      {
        sessions: [
          ticketless({ sessionId: "sess-grill", workspace: "/worktrees/grill" }),
        ],
      },
    );

    expect(result.rogue).toHaveLength(1);
    expect(result.rogue[0]!.dir).toBe("/worktrees/grill");
  });

  test("uncommitted work in an unowned checkout is rogue even with no commits", () => {
    const result = attributeChanges(
      scan({
        roots: [
          {
            dir: "/repo",
            commits: [],
            workingTree: { files: ["src/a.ts"], diff: "+const a = 1;" },
          },
        ],
      }),
      { sessions: [registered()] },
    );

    expect(result.rogue).toHaveLength(1);
    expect(result.rogue[0]!.workingTree?.files).toEqual(["src/a.ts"]);
  });

  test("a checkout with neither commits nor a working-tree delta yields nothing", () => {
    const result = attributeChanges(
      scan({ roots: [{ dir: "/repo", commits: [], workingTree: null }] }),
      { sessions: [] },
    );

    expect(result.rogue).toEqual([]);
    expect(result.attributed).toEqual([]);
  });

  test("workspace paths match regardless of trailing slashes", () => {
    const result = attributeChanges(
      scan({
        roots: [{ dir: "/worktrees/seven", commits: [commit()], workingTree: null }],
      }),
      { sessions: [registered({ workspace: "/worktrees/seven/" })] },
    );

    expect(result.rogue).toEqual([]);
  });

  test("sessions observed working in a rogue checkout ride along as evidence", () => {
    const result = attributeChanges(scan(), {
      sessions: [],
      sessionDirs: new Map([
        ["sess-rogue", "/repo"],
        ["sess-elsewhere", "/other"],
      ]),
    });

    expect(result.rogue[0]!.sessionIds).toEqual(["sess-rogue"]);
  });
});

describe("attribution: an unregistered session inside a ticket's worktree", () => {
  test("work is rogue when a session the registry never saw was running in that checkout", () => {
    const result = attributeChanges(
      scan({
        roots: [{ dir: "/worktrees/seven", commits: [commit()], workingTree: null }],
      }),
      {
        sessions: [registered()],
        sessionDirs: new Map([["sess-rogue", "/worktrees/seven"]]),
      },
    );

    expect(result.attributed).toEqual([]);
    expect(result.rogue).toHaveLength(1);
    expect(result.rogue[0]!.sessionIds).toEqual(["sess-rogue"]);
    // The worktree's ticket is the nearest plausible parent for that work.
    expect(result.rogue[0]!.sessionTickets).toEqual(["7"]);
  });

  test("the ticket session's OWN session running there keeps the work attributed", () => {
    const result = attributeChanges(
      scan({
        roots: [{ dir: "/worktrees/seven", commits: [commit()], workingTree: null }],
      }),
      {
        sessions: [registered()],
        sessionDirs: new Map([["sess-dispatch", "/worktrees/seven"]]),
      },
    );

    expect(result.rogue).toEqual([]);
    expect(result.attributed).toHaveLength(1);
  });

  test("a rogue checkout with no ticket session anywhere near it has no session ticket", () => {
    const result = attributeChanges(scan(), { sessions: [] });
    expect(result.rogue[0]!.sessionTickets).toEqual([]);
  });
});
