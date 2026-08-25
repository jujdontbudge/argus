import { describe, expect, test } from "bun:test";
import { createFakeGh } from "./fake-gh";
import { detectTracker } from "./gh";

describe("tracker detection (ADR-0001 loud degradation)", () => {
  test("a reachable GitHub repo yields a tracker named owner/name", async () => {
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    const tracker = await detectTracker("/repo", gh.run);
    expect(tracker?.repo).toBe("JohanSardar/argus");
  });

  test("gh failing (no remote, no auth, no network) yields NO tracker, never a throw", async () => {
    const tracker = await detectTracker("/repo", async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "no git remotes found",
    }));
    expect(tracker).toBeNull();
  });
});

describe("filing a retro (SPEC §5.5: closed, retro-labeled, sub-issue of the parent)", () => {
  test("files through create → sub_issues link → close, in that order", async () => {
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    gh.seed({ number: 15, title: "Ship the widget pipeline" });
    const tracker = (await detectTracker("/repo", gh.run))!;

    const filed = await tracker.fileRetro({
      title: "Retro: frobnicator implemented without a ticket",
      body: "## Prompts\n\nmake the frobnicator\n\n## Diff\n\n+frobnicate",
      parent: "15",
    });

    expect(filed.ok).toBe(true);
    if (!filed.ok) return;
    expect(filed.parent).toBe("15");
    expect(filed.linked).toBe(true);
    expect(filed.closed).toBe(true);

    const issue = gh.issues.find((entry) => entry.number === filed.number)!;
    expect(issue.title).toBe("Retro: frobnicator implemented without a ticket");
    expect(issue.labels).toContain("retro");
    expect(issue.state).toBe("closed");
    expect(issue.parent).toBe(15);
    expect(issue.body).toContain("make the frobnicator");

    const verbs = gh.calls.map((call) => call.slice(0, 2).join(" "));
    expect(verbs).toEqual([
      "repo view",
      "issue create",
      `api repos/JohanSardar/argus/issues/${filed.number}`,
      "api repos/JohanSardar/argus/issues/15/sub_issues",
      "issue close",
    ]);
  });

  test("the sub-issue link uses the GitHub sub_issues API with the issue's DB id", async () => {
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    gh.seed({ number: 15, title: "parent" });
    const tracker = (await detectTracker("/repo", gh.run))!;

    const filed = await tracker.fileRetro({ title: "Retro: x", body: "b", parent: "15" });
    if (!filed.ok) throw new Error("expected the retro to file");
    const child = gh.issues.find((entry) => entry.number === filed.number)!;

    const link = gh.calls.find((call) => call.at(1)?.endsWith("/sub_issues"))!;
    expect(link).toEqual([
      "api",
      "repos/JohanSardar/argus/issues/15/sub_issues",
      "-F",
      `sub_issue_id=${child.id}`,
    ]);
    expect(String(child.id)).not.toBe(child.number); // the DB id is not the number
  });

  test("a root-level retro (no plausible parent) is created and closed, never linked", async () => {
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    const tracker = (await detectTracker("/repo", gh.run))!;

    const filed = await tracker.fileRetro({
      title: "Retro: stray edit",
      body: "body",
      parent: null,
    });

    expect(filed.ok).toBe(true);
    if (!filed.ok) return;
    expect(filed.parent).toBeNull();
    expect(filed.linked).toBe(false);
    expect(gh.issues.find((entry) => entry.number === filed.number)!.state).toBe("closed");
    expect(gh.calls.some((call) => call.at(1)?.includes("sub_issues"))).toBe(false);
  });

  test("the retro is closed as completed — the work it records already happened", async () => {
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    const tracker = (await detectTracker("/repo", gh.run))!;
    await tracker.fileRetro({ title: "Retro: x", body: "b", parent: null });
    expect(gh.calls.at(-1)).toContain("--reason");
    expect(gh.calls.at(-1)).toContain("completed");
  });

  test("a failing gh create degrades LOUDLY — a failure result, never a throw", async () => {
    const gh = createFakeGh({ repo: "JohanSardar/argus", failCreate: "label 'retro' not found" });
    const tracker = (await detectTracker("/repo", gh.run))!;

    const filed = await tracker.fileRetro({ title: "Retro: x", body: "b", parent: null });

    expect(filed.ok).toBe(false);
    if (filed.ok) return;
    expect(filed.reason).toContain("label 'retro' not found");
  });

  test("a failing sub-issue link still leaves the retro filed and closed, loudly unlinked", async () => {
    const gh = createFakeGh({ repo: "JohanSardar/argus", failLink: "sub-issues unavailable" });
    gh.seed({ number: 15, title: "parent" });
    const tracker = (await detectTracker("/repo", gh.run))!;

    const filed = await tracker.fileRetro({ title: "Retro: x", body: "b", parent: "15" });

    expect(filed.ok).toBe(true);
    if (!filed.ok) return;
    expect(filed.linked).toBe(false);
    expect(filed.linkError).toContain("sub-issues unavailable");
    expect(gh.issues.find((entry) => entry.number === filed.number)!.state).toBe("closed");
  });

  test("open tickets are listed as retro parent candidates", async () => {
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    gh.seed({ number: 15, title: "Ship the widget pipeline", body: "src/widget/" });
    gh.seed({ number: 16, title: "Closed thing", state: "closed" });
    const tracker = (await detectTracker("/repo", gh.run))!;

    const tickets = await tracker.openTickets();

    expect(tickets.map((ticket) => ticket.number)).toEqual(["15"]);
    expect(tickets[0]!.title).toBe("Ship the widget pipeline");
  });
});

describe("the fake gh never reaches GitHub", () => {
  test("every call is recorded and answered from in-memory state", async () => {
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    const tracker = (await detectTracker("/repo", gh.run))!;
    await tracker.fileRetro({ title: "Retro: x", body: "b", parent: null });
    expect(gh.calls.length).toBeGreaterThan(0);
    expect(gh.issues).toHaveLength(1);
  });
});

describe("reading a ticket's stated scope (#38 scope drift)", () => {
  test("the title and body come back through the same gh seam the filer uses", async () => {
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    gh.seed({
      number: 7,
      title: "Ship the widget pipeline",
      body: "Build the renderer.\nStream the pipeline.",
    });
    const tracker = (await detectTracker("/repo", gh.run))!;

    const scope = await tracker.readTicket("7");

    expect(scope).toEqual({
      number: "7",
      title: "Ship the widget pipeline",
      body: "Build the renderer.\nStream the pipeline.",
      state: "open",
    });
    expect(gh.calls.some((call) => call[0] === "issue" && call[1] === "view")).toBe(true);
  });

  test("a ticket CLOSED mid-session still reads — judge it, do not crash", async () => {
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    gh.seed({ number: 7, title: "Done already", body: "Body.", state: "closed" });
    const tracker = (await detectTracker("/repo", gh.run))!;

    expect((await tracker.readTicket("7"))?.state).toBe("closed");
  });

  test("a ticket gh cannot read is null, never a throw and never a guess", async () => {
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    const tracker = (await detectTracker("/repo", gh.run))!;

    expect(await tracker.readTicket("404")).toBeNull();
    expect(await tracker.readTicket("not-a-number")).toBeNull();
  });
});
