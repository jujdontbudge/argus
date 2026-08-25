import { describe, expect, test } from "bun:test";
import type { StoredDigest } from "../digest/outputs";
import type { Attribution, RogueChanges } from "./attribution";
import type { GitCommit } from "./git";
import { buildSignals } from "./signal";

function commit(overrides: Partial<GitCommit> = {}): GitCommit {
  return {
    sha: "abc1234def5678",
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

function rogue(overrides: Partial<RogueChanges> = {}): RogueChanges {
  return {
    dir: "/repo",
    commits: [commit()],
    workingTree: null,
    sessionIds: [],
    referencedTickets: [],
    sessionTickets: [],
    ...overrides,
  };
}

function attribution(rogueChanges: RogueChanges[]): Attribution {
  return { rogue: rogueChanges, attributed: [] };
}

function digest(overrides: Partial<StoredDigest> = {}): StoredDigest {
  return {
    fileName: "adhoc-sess-rogue.md",
    sessionId: "sess-rogue",
    frontmatter: {
      agent: "claude",
      startedBy: "johan",
      status: "done",
      johanTouched: true,
    },
    body: "## 2026-08-24T12:00:00Z\n\nImplemented the frobnicator end to end.\n",
    ...overrides,
  };
}

describe("retro signals (SPEC §5.5: git signal + transcript signal)", () => {
  test("rogue git changes with no session make a git signal", () => {
    const signals = buildSignals({
      attribution: attribution([rogue({ referencedTickets: ["42"] })]),
      digests: [],
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]!.sources).toEqual(["git"]);
    expect(signals[0]!.dir).toBe("/repo");
    expect(signals[0]!.changes?.commits).toHaveLength(1);
    expect(signals[0]!.referencedTickets).toEqual(["42"]);
    expect(signals[0]!.id).toMatch(/^retro-[0-9a-f]{16}$/);
  });

  test("a TICKETLESS digest with no git changes makes a transcript signal", () => {
    const signals = buildSignals({ attribution: attribution([]), digests: [digest()] });

    expect(signals).toHaveLength(1);
    expect(signals[0]!.sources).toEqual(["transcript"]);
    expect(signals[0]!.changes).toBeNull();
    expect(signals[0]!.sessions.map((session) => session.sessionId)).toEqual([
      "sess-rogue",
    ]);
    expect(signals[0]!.sessions[0]!.narrative).toContain("Implemented the frobnicator");
  });

  test("a digest whose session claimed a ticket raises NO transcript signal", () => {
    const signals = buildSignals({
      attribution: attribution([]),
      digests: [
        digest({
          fileName: "7-sess-batch.md",
          sessionId: "sess-batch",
          frontmatter: {
            agent: "codex",
            ticket: "7",
            startedBy: "hermes",
            status: "running",
            johanTouched: false,
          },
        }),
      ],
    });

    expect(signals).toEqual([]);
  });

  test("git and transcript evidence for the same session merge into ONE signal", () => {
    const signals = buildSignals({
      attribution: attribution([rogue({ sessionIds: ["sess-rogue"] })]),
      digests: [digest()],
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]!.sources).toEqual(["git", "transcript"]);
    expect(signals[0]!.changes?.commits).toHaveLength(1);
    expect(signals[0]!.sessions[0]!.narrative).toContain("Implemented the frobnicator");
    expect(signals[0]!.sessions[0]!.agent).toBe("claude");
  });

  test("a session's cwd links its digest to rogue changes it never named", () => {
    const signals = buildSignals({
      attribution: attribution([rogue()]),
      digests: [digest()],
      sessionDirs: new Map([["sess-rogue", "/repo"]]),
    });

    expect(signals).toHaveLength(1);
    expect(signals[0]!.sources).toEqual(["git", "transcript"]);
  });

  test("the signal id is stable for identical work and changes when the work does", () => {
    const build = (changes: RogueChanges) =>
      buildSignals({ attribution: attribution([changes]), digests: [] })[0]!.id;

    expect(build(rogue())).toBe(build(rogue()));
    expect(build(rogue({ commits: [commit({ sha: "999" })] }))).not.toBe(build(rogue()));
    expect(
      build(rogue({ workingTree: { files: ["a.ts"], diff: "+a" }, commits: [] })),
    ).not.toBe(build(rogue()));
  });

  test("a registered ticket's worktree rides along as the parent hint", () => {
    const signals = buildSignals({
      attribution: attribution([rogue({ sessionTickets: ["7"] })]),
      digests: [],
    });
    expect(signals[0]!.sessionTickets).toEqual(["7"]);
  });

  test("no evidence at all produces no signals", () => {
    expect(buildSignals({ attribution: attribution([]), digests: [] })).toEqual([]);
  });
});
