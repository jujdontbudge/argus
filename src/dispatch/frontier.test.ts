import { describe, expect, test } from "bun:test";
import { createFakeGh } from "../eyes/retro/fake-gh";
import { readFrontier } from "./frontier.ts";

/**
 * Ticket #56 — SPEC §7.3.1: "Hermes reads the frontier (open, unblocked,
 * unclaimed tickets) from GitHub."
 *
 * All three adjectives are load-bearing and each has its own way of being
 * wrong, so each gets its own test. The posture on anything the reader cannot
 * determine is FAIL CLOSED AND LOUD: a ticket whose blocked-ness is unknown is
 * not dispatched, because dispatching a blocked ticket spends a real session
 * doing work in the wrong order and there is no way to un-spend it.
 */
const REPO = "JohanSardar/argus";

describe("the frontier (open, unblocked, unclaimed)", () => {
  test("an open, unassigned, dependency-free ticket IS the frontier", async () => {
    const gh = createFakeGh({ repo: REPO });
    gh.seed({ number: 12, title: "Ship the widget", body: "Build it." });

    const frontier = await readFrontier({ cwd: "/repo", repo: REPO, run: gh.run });

    expect(frontier.tickets.map((ticket) => ticket.number)).toEqual(["12"]);
    expect(frontier.tickets[0]!.title).toBe("Ship the widget");
    expect(frontier.tickets[0]!.body).toBe("Build it.");
    expect(frontier.degraded).toEqual([]);
  });

  test("a CLOSED ticket is never in the frontier", async () => {
    const gh = createFakeGh({ repo: REPO });
    gh.seed({ number: 12, title: "Done", state: "closed" });

    const frontier = await readFrontier({ cwd: "/repo", repo: REPO, run: gh.run });

    expect(frontier.tickets).toEqual([]);
    // and the state filter is asked for at the API, not filtered after the fact
    const listed = gh.calls.find((call) => call[1] === "list")!;
    expect(listed).toContain("--state");
    expect(listed).toContain("open");
  });

  test("an ASSIGNED ticket is claimed, so it is excluded — never re-dispatched", async () => {
    const gh = createFakeGh({ repo: REPO });
    gh.seed({ number: 12, title: "Mine", assignees: ["someone-else"] });

    const frontier = await readFrontier({ cwd: "/repo", repo: REPO, run: gh.run });

    expect(frontier.tickets).toEqual([]);
    expect(frontier.excluded).toEqual([
      { detail: "assigned to someone-else", number: "12", reason: "claimed" },
    ]);
  });

  test("a ticket labeled blocked-on-human is excluded with that reason", async () => {
    const gh = createFakeGh({ repo: REPO });
    gh.seed({
      labels: ["argus:blocked-on-human"],
      number: 12,
      title: "Waiting on Johan",
    });

    const frontier = await readFrontier({ cwd: "/repo", repo: REPO, run: gh.run });

    expect(frontier.tickets).toEqual([]);
    expect(frontier.excluded).toContainEqual(
      expect.objectContaining({ number: "12", reason: "blocked-on-human" }),
    );
  });

  test("a newer owner comment auto-unpauses a blocked ticket and removes its label", async () => {
    let removed = false;
    const run = async (args: readonly string[], _cwd: string) => {
      if (args[0] === "issue" && args[1] === "list") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify([
            {
              assignees: [],
              body: "Need a decision.",
              labels: [{ name: "argus:blocked-on-human" }],
              number: 12,
              title: "Waiting on Johan",
            },
          ]),
        };
      }
      if (args[0] === "api" && args[1]?.includes("/timeline")) {
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify([
            {
              actor: { login: "argus-bot" },
              created_at: "2026-08-31T10:00:00Z",
              event: "labeled",
              label: { name: "argus:blocked-on-human" },
            },
            {
              created_at: "2026-08-31T11:00:00Z",
              event: "commented",
              user: { login: "JohanSardar" },
              body: "Please continue with option B.",
            },
          ]),
        };
      }
      if (args[0] === "issue" && args[1] === "edit") {
        removed = args.includes("--remove-label") && args.includes("argus:blocked-on-human");
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (args[0] === "api" && args[1]?.includes("/dependencies/blocked_by")) {
        return { exitCode: 0, stderr: "", stdout: "[]" };
      }
      if (args[0] === "api" && args[1]?.includes("/sub_issues")) {
        return { exitCode: 0, stderr: "", stdout: "[]" };
      }
      throw new Error(`unexpected gh call: ${args.join(" ")}`);
    };

    const frontier = await readFrontier({ cwd: "/repo", repo: REPO, run });

    expect(frontier.tickets.map((ticket) => ticket.number)).toEqual(["12"]);
    expect(frontier.excluded).toEqual([]);
    expect(removed).toBe(true);
  });

  test("a wayfinder:grilling ticket is excluded as a human decision regardless of other labels", async () => {
    const gh = createFakeGh({ repo: REPO });
    gh.seed({
      number: 42,
      title: "A decision only Johan can settle",
      labels: ["wayfinder:grilling", "agent:codex", "grilling"],
    });

    const frontier = await readFrontier({ cwd: "/repo", repo: REPO, run: gh.run });

    expect(frontier.tickets).toEqual([]);
    expect(frontier.excluded).toEqual([
      {
        detail: "wayfinder:grilling tickets require a human decision",
        number: "42",
        reason: "human-decision",
      },
    ]);
  });

  test("a ticket blocked by an OPEN dependency is excluded", async () => {
    const gh = createFakeGh({ repo: REPO });
    gh.seed({ number: 11, title: "blocker" });
    gh.seed({ number: 12, title: "blocked", blockedBy: [11] });

    const frontier = await readFrontier({ cwd: "/repo", repo: REPO, run: gh.run });

    expect(frontier.tickets.map((ticket) => ticket.number)).toEqual(["11"]);
    expect(frontier.excluded).toEqual([
      { detail: "blocked by #11", number: "12", reason: "blocked" },
    ]);
  });

  test("a ticket whose only dependency CLOSED is unblocked again", async () => {
    const gh = createFakeGh({ repo: REPO });
    gh.seed({ number: 11, title: "blocker", state: "closed" });
    gh.seed({ number: 12, title: "blocked", blockedBy: [11] });

    const frontier = await readFrontier({ cwd: "/repo", repo: REPO, run: gh.run });

    expect(frontier.tickets.map((ticket) => ticket.number)).toEqual(["12"]);
  });

  test("a parent with OPEN sub-issues is an epic, not work — excluded", async () => {
    const gh = createFakeGh({ repo: REPO });
    gh.seed({ number: 10, title: "epic" });
    gh.seed({ number: 11, title: "child", parent: 10 });

    const frontier = await readFrontier({ cwd: "/repo", repo: REPO, run: gh.run });

    expect(frontier.tickets.map((ticket) => ticket.number)).toEqual(["11"]);
    expect(frontier.excluded).toEqual([
      { detail: "1 open sub-issue (#11)", number: "10", reason: "has-open-sub-issues" },
    ]);
  });

  test("a parent whose sub-issues are all CLOSED is dispatchable work again", async () => {
    const gh = createFakeGh({ repo: REPO });
    gh.seed({ number: 10, title: "epic" });
    gh.seed({ number: 11, title: "child", parent: 10, state: "closed" });

    const frontier = await readFrontier({ cwd: "/repo", repo: REPO, run: gh.run });

    expect(frontier.tickets.map((ticket) => ticket.number)).toEqual(["10"]);
  });

  test("UNKNOWN blocked-ness excludes the ticket LOUDLY — it never falls through as unblocked", async () => {
    const gh = createFakeGh({ repo: REPO, failDependencies: "API rate limit exceeded" });
    gh.seed({ number: 12, title: "Ship the widget" });

    const frontier = await readFrontier({ cwd: "/repo", repo: REPO, run: gh.run });

    expect(frontier.tickets).toEqual([]);
    expect(frontier.excluded[0]!.reason).toBe("unknown-dependencies");
    expect(frontier.excluded[0]!.detail).toContain("API rate limit exceeded");
  });

  test("a failing issue list is an empty frontier plus a loud degradation, never a throw", async () => {
    const gh = createFakeGh({ repo: REPO, failList: "gh: not authenticated" });

    const frontier = await readFrontier({ cwd: "/repo", repo: REPO, run: gh.run });

    expect(frontier.tickets).toEqual([]);
    expect(frontier.degraded.join(" ")).toContain("not authenticated");
  });

  test("dependency reads are spent only on tickets that could still be dispatched", async () => {
    const gh = createFakeGh({ repo: REPO });
    gh.seed({ number: 12, title: "Mine", assignees: ["someone-else"] });

    await readFrontier({ cwd: "/repo", repo: REPO, run: gh.run });

    expect(gh.calls.some((call) => call[0] === "api")).toBe(false);
  });

  test("tickets come back in ticket order, so dispatch is deterministic", async () => {
    const gh = createFakeGh({ repo: REPO });
    gh.seed({ number: 30, title: "c" });
    gh.seed({ number: 12, title: "a" });
    gh.seed({ number: 21, title: "b" });

    const frontier = await readFrontier({ cwd: "/repo", repo: REPO, run: gh.run });

    expect(frontier.tickets.map((ticket) => ticket.number)).toEqual(["12", "21", "30"]);
  });
});
