import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createBrainCap } from "../cap";
import { createCodexBrain } from "../brain";
import type { StuckAlert } from "../backpressure";
import { loadScaledMs } from "../test-budget";
import { applyDigestUpdate } from "../digest/outputs";
import type { ProvenanceRecord } from "../../provenance";
import { registryPaths } from "../../provenance";
import { createFakeGh, type FakeGh } from "./fake-gh";
import { fixtureRetroBrain } from "./fixture-brain";
import { RetroEye, type RetroAudit, type RetroFiling } from "./retro";

/**
 * Per-test budget. Every test here spawns `git` several times against its own
 * scratch repo, and subprocess spawn is what degrades worst on a saturated
 * machine: the slowest test measured 1.11s at load average 8-21 on ten cores,
 * and 60s — 54x that — still produced three hard timeouts in #36 and #38 when
 * the box was busy. 60s on an idle machine (unchanged, so no hang is hidden),
 * stretching to 300s in proportion to measured oversubscription. See
 * ../test-budget.ts for the numbers and the reasoning.
 */
const BUDGET_MS = loadScaledMs(60_000, 300_000);

/** A scratch repo the eye may watch; every test owns its own (§13 isolation). */
interface Scratch {
  repo: string;
  root: string;
  git(...args: string[]): Promise<string>;
  commit(path: string, contents: string, message: string): Promise<string>;
  cleanup(): Promise<void>;
}

async function scratch(): Promise<Scratch> {
  const root = await mkdtemp(join(tmpdir(), "argus-retro-eye-"));
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  const git = async (...args: string[]): Promise<string> => {
    const child = Bun.spawn(
      [
        "git",
        "-c",
        "user.name=Johan Sardar",
        "-c",
        "user.email=johansardar77@gmail.com",
        "-c",
        "commit.gpgsign=false",
        ...args,
      ],
      { cwd: repo, stderr: "pipe", stdout: "pipe" },
    );
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    if (exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
    return stdout;
  };
  await git("init", "--quiet");
  await git("commit", "--quiet", "--allow-empty", "-m", "seed");
  return {
    repo,
    root,
    git,
    async commit(path, contents, message) {
      await mkdir(dirname(join(repo, path)), { recursive: true });
      await writeFile(join(repo, path), contents);
      await git("add", path);
      await git("commit", "--quiet", "-m", message);
      return (await git("rev-parse", "HEAD")).trim();
    },
    cleanup: () => rm(root, { force: true, recursive: true }),
  };
}

interface Harness {
  eye: RetroEye;
  audits: RetroAudit[];
  reopen(): Promise<RetroEye>;
}

async function openEye(
  place: Scratch,
  gh: FakeGh,
  overrides: { now?: () => number } = {},
): Promise<Harness> {
  const audits: RetroAudit[] = [];
  const options = {
    repo: place.repo,
    brain: fixtureRetroBrain(),
    cap: createBrainCap({
      directory: join(place.root, "brain-slots"),
      maxConcurrency: 2,
      pollMs: 1,
    }),
    cadence: { quietWindowSeconds: 60, maxWaitSeconds: 600 },
    gh: gh.run,
    now: overrides.now ?? (() => 0),
    sleep: async () => {},
    onAudit: (audit: RetroAudit) => {
      audits.push(audit);
    },
  };
  return {
    eye: await RetroEye.open(options),
    audits,
    reopen: () => RetroEye.open(options),
  };
}

function johanSays(sessionId: string, text: string): ProvenanceRecord {
  return {
    sessionId,
    author: "johan",
    via: "unregistered-session",
    registered: false,
    startedBy: "johan",
    johanTouched: true,
    ts: "2026-08-24T12:00:00Z",
    text,
    event: {
      type: "message",
      sessionId,
      role: "user",
      text,
      ts: "2026-08-24T12:00:00Z",
      uuid: `uuid-${sessionId}`,
      candidate: true,
      file: `/transcripts/${sessionId}.jsonl`,
    },
  };
}

async function registerSession(
  repo: string,
  row: Record<string, unknown>,
): Promise<void> {
  const paths = registryPaths(repo);
  await mkdir(join(repo, ".argus/registry"), { recursive: true });
  await appendFile(paths.sessionsFile, `${JSON.stringify(row)}\n`);
}

async function seedDigest(
  repo: string,
  fileName: string,
  narrative: string,
): Promise<void> {
  await applyDigestUpdate(
    join(repo, ".argus/sessions"),
    fileName,
    { agent: "claude", startedBy: "johan" },
    { status: "done", narrative: { ts: "2026-08-24T12:10:00Z", text: narrative } },
  );
}


/** Run git in any checkout (the worktree tests need more than the repo). */
async function gitIn(cwd: string, ...args: string[]): Promise<void> {
  const child = Bun.spawn(
    [
      "git",
      "-c",
      "user.name=Johan Sardar",
      "-c",
      "user.email=johansardar77@gmail.com",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    { cwd, stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stderr] = await Promise.all([
    child.exited,
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
}

const filedIssue = (gh: FakeGh) =>
  gh.issues.find((issue) => issue.labels.includes("retro"));

describe("the Retro watcher's production tick path", () => {
  test("watcher shutdown interrupts a hung brain and releases its cap slot", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    const controller = new AbortController();
    const cap = createBrainCap({
      directory: join(place.root, "brain-slots"),
      maxConcurrency: 1,
      pollMs: 1,
    });
    let started!: () => void;
    const spawnStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    try {
      const eye = await RetroEye.open({
        repo: place.repo,
        brain: createCodexBrain({
          attemptTimeoutMs: 100,
          model: "gpt-5.6-luna",
          reasoningEffort: "low",
          spawn: async () => {
            started();
            return await new Promise(() => {});
          },
        }),
        cap,
        cadence: { quietWindowSeconds: 60, maxWaitSeconds: 600 },
        gh: gh.run,
        signal: controller.signal,
        sleep: async () => {},
      });
      await eye.prime();
      await place.commit(
        "src/hung.ts",
        "export const hung = true;\n",
        "implementation whose brain hangs",
      );

      const scan = eye.scan();
      await spawnStarted;
      controller.abort();
      const observed = await Promise.race([
        scan.then(
          () => "resolved" as const,
          (error: unknown) => error,
        ),
        Bun.sleep(20).then(() => "test-watchdog" as const),
      ]);
      if (observed === "test-watchdog") await scan.catch(() => {});

      expect(observed).not.toBe("test-watchdog");
      expect(observed).toBeInstanceOf(Error);
      expect((observed as Error).name).toBe("AbortError");
      const release = await Promise.race([
        cap.acquire(),
        Bun.sleep(20).then(() => "cap-watchdog" as const),
      ]);
      expect(release).not.toBe("cap-watchdog");
      if (typeof release === "function") await release();
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("timed-out brains alert, retry without dropping work, and return to the RSS boundary", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    const slots = join(place.root, "brain-slots");
    const cap = createBrainCap({ directory: slots, maxConcurrency: 1, pollMs: 1 });
    const fixture = fixtureRetroBrain();
    const alerts: StuckAlert[] = [];
    const failures: string[] = [];
    let attempts = 0;
    let now = 0;
    let rssCeilingChecks = 0;
    try {
      const brain = createCodexBrain({
        attemptTimeoutMs: 20,
        model: "gpt-5.6-luna",
        reasoningEffort: "low",
        spawn: async (request) => {
          attempts += 1;
          if (attempts <= 2) return await new Promise(() => {});
          const outcome = await fixture.evaluate({
            prompt: request.stdin,
            schema: {},
            cwd: place.repo,
          });
          if (!outcome.ok) throw new Error(outcome.detail);
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              type: "item.completed",
              item: { type: "agent_message", text: outcome.text },
            }),
            stderr: "",
          };
        },
      });
      const eye = await RetroEye.open({
        repo: place.repo,
        brain,
        cap,
        cadence: { quietWindowSeconds: 60, maxWaitSeconds: 600 },
        gh: gh.run,
        now: () => now,
        // One failed-attempt backoff crosses the real 15-minute alert bar
        // without making this test wait on wall time.
        sleep: async () => {
          now += 15 * 60_000 + 1;
        },
        onAlert: (alert) => {
          alerts.push(alert);
        },
        onFailure: ({ lastError }) => {
          failures.push(lastError);
        },
      });
      await eye.prime();
      await place.commit(
        "src/survives.ts",
        "export const survives = true;\n",
        "implementation survives a hung brain",
      );

      // src/watch.ts checks RSS immediately after each awaited tick. This
      // counter pins that a previously hung tick settles back at that boundary.
      const watcherTick = async (): Promise<RetroFiling[]> => {
        const filings = await eye.scan();
        rssCeilingChecks += 1;
        return filings;
      };
      const filings = await watcherTick();

      expect(attempts).toBe(3);
      expect(failures).toHaveLength(2);
      expect(failures.every((failure) => failure.includes("timed out after 20ms"))).toBe(
        true,
      );
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        type: "eye-stuck",
        eye: "retro",
        attempts: 2,
        stuckForMs: 15 * 60_000 + 1,
      });
      expect(filings).toHaveLength(1);
      expect(rssCeilingChecks).toBe(1);
      expect(await readdir(slots)).toEqual([]);
      const release = await cap.acquire();
      await release();

      expect(await watcherTick()).toEqual([]);
      expect(rssCeilingChecks).toBe(2);
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("startup priming preserves work that lands before the first scheduled tick", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    let now = 0;
    try {
      const { eye } = await openEye(place, gh, { now: () => now });
      await eye.ingest([johanSays("sess-johan", "Please keep the ticket record complete.")]);
      await place.commit("src/startup.ts", "export const startup = true;\n", "startup work");

      now = 60_000;
      const filings = await eye.tick();

      expect(filings.map((filing) => filing.title)).toEqual(["Retro: startup work"]);
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("git-only work is scanned on an independent periodic cadence", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    let now = 0;
    try {
      const { eye } = await openEye(place, gh, { now: () => now });
      await place.commit("src/git-only.ts", "export const gitOnly = true;\n", "git-only work");

      now = 600_000;
      const filings = await eye.tick();

      expect(filings.map((filing) => filing.title)).toEqual(["Retro: git-only work"]);
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("an observed session survives restart before production tick files its work", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    let now = 0;
    const prompt = "Please add the restart-safe worker without a ticket.";
    try {
      const harness = await openEye(place, gh, { now: () => now });
      await harness.eye.observeSession({ sessionId: "sess-restart", cwd: place.repo });

      const restarted = await harness.reopen();
      await restarted.ingest([johanSays("sess-restart", prompt)]);
      await place.commit(
        "src/restart-safe.ts",
        "export const restartSafe = true;\n",
        "restart-safe work",
      );

      now = 60_000;
      expect(await restarted.tick()).toHaveLength(1);
      expect(filedIssue(gh)!.body).toContain(prompt);
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);
});

describe("the Retro eye files closed retro sub-issues (SPEC §5.5)", () => {
  test("rogue commits become a closed, retro-labeled sub-issue of the nearest parent", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    gh.seed({ number: 15, title: "Ship the widget pipeline" });
    try {
      const { eye } = await openEye(place, gh);
      await eye.prime();
      await place.commit(
        "src/frobnicator.ts",
        "export const frobnicate = () => {};\n",
        "add the frobnicator",
      );
      await seedDigest(
        place.repo,
        "adhoc-sess-rogue.md",
        "Implemented the frobnicator end to end.",
      );
      await eye.observeSession({ sessionId: "sess-rogue", cwd: place.repo });
      await eye.ingest([
        johanSays("sess-rogue", "just add a frobnicator, don't bother with a ticket"),
      ]);

      const filings = await eye.scan();

      expect(filings).toHaveLength(1);
      expect(filings[0]!.outcome).toBe("filed");
      const issue = filedIssue(gh)!;
      expect(issue.title).toBe("Retro: add the frobnicator");
      expect(issue.state).toBe("closed");
      expect(issue.closeReason).toBe("completed");
      expect(issue.parent).toBe(15);
      expect(issue.body).toContain("just add a frobnicator, don't bother with a ticket");
      expect(issue.body).toContain("+export const frobnicate = () => {};");
      expect(issue.body).toContain("Implemented the frobnicator end to end.");
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("work a registered ticket session did files NOTHING", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    try {
      const { eye } = await openEye(place, gh);
      await eye.prime();
      await registerSession(place.repo, {
        ts: "2026-08-24T11:00:00Z",
        sessionId: "sess-dispatch",
        dispatchPrompt: "Implement ticket #7.",
        agent: "codex",
        ticket: "7",
        workspace: place.repo,
      });
      await place.commit("src/widget.ts", "export const widget = 1;\n", "widget work");

      expect(await eye.scan()).toEqual([]);
      expect(gh.issues).toHaveLength(0);
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("the same rogue work is never filed twice", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    try {
      const { eye } = await openEye(place, gh);
      await eye.prime();
      await place.commit("src/a.ts", "export const a = 1;\n", "add a");

      const first = await eye.scan();
      const second = await eye.scan();

      expect(first).toHaveLength(1);
      expect(second).toEqual([]);
      expect(gh.issues.filter((issue) => issue.labels.includes("retro"))).toHaveLength(1);
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("with no plausible parent the retro is filed at root level, still closed", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    try {
      const { eye } = await openEye(place, gh);
      await eye.prime();
      await place.commit("src/stray.ts", "export const stray = 1;\n", "stray edit");

      const filings = await eye.scan();

      expect(filings[0]!.parent).toBeNull();
      expect(filings[0]!.parentRule).toBe("root-level");
      expect(filedIssue(gh)!.parent).toBeNull();
      expect(filedIssue(gh)!.state).toBe("closed");
      expect(gh.calls.some((call) => call.at(1)?.includes("sub_issues"))).toBe(false);
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("Johan's own ad hoc implementation files a retro too (§7.4)", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    try {
      const { eye } = await openEye(place, gh);
      await eye.prime();
      await place.commit("src/johan.ts", "export const mine = true;\n", "johan's own fix");
      await seedDigest(place.repo, "adhoc-sess-johan.md", "Johan implemented a fix.");
      await eye.observeSession({ sessionId: "sess-johan", cwd: place.repo });
      await eye.ingest([johanSays("sess-johan", "I'll just do this one myself")]);

      const filings = await eye.scan();

      expect(filings).toHaveLength(1);
      expect(filedIssue(gh)!.body).toContain("I'll just do this one myself");
      expect(filedIssue(gh)!.state).toBe("closed");
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("a session that only planned files no retro", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    try {
      const { eye } = await openEye(place, gh);
      await eye.prime();
      await seedDigest(
        place.repo,
        "adhoc-sess-plan.md",
        "A planning conversation: no code was written.",
      );

      expect(await eye.scan()).toEqual([]);
      expect(gh.issues).toHaveLength(0);
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);
});

describe("the Retro eye degrades loudly, never silently (ADR-0001)", () => {
  test("tracker-less mode writes a separate bounded note and leaves the digest untouched", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus", failView: "no git remotes" });
    try {
      const { eye, audits } = await openEye(place, gh);
      await eye.prime();
      await place.commit("src/rogue.ts", "export const rogue = 1;\n", "rogue work");
      await seedDigest(place.repo, "adhoc-sess-rogue.md", "Implemented something.");
      await eye.observeSession({ sessionId: "sess-rogue", cwd: place.repo });
      await eye.ingest([johanSays("sess-rogue", "do the thing")]);
      const digestPath = join(place.repo, ".argus/sessions/adhoc-sess-rogue.md");
      const before = await Bun.file(digestPath).text();

      const filings = await eye.scan();

      expect(filings).toHaveLength(1);
      expect(filings[0]!.outcome).toBe("digest-note");
      expect(gh.issues).toHaveLength(0);
      expect(await Bun.file(digestPath).text()).toBe(before);
      const note = await Bun.file(
        join(
          place.repo,
          ".argus/eyes/retro/unfiled",
          `${filings[0]!.signalId}.md`,
        ),
      ).text();
      expect(note).toContain("Retro: rogue work");
      expect(note).toContain("do the thing");
      expect(audits.some((audit) => audit.type === "tracker-less")).toBe(true);
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("a rogue checkout with no digest still leaves an unfiled retro on disk", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus", failView: "no git remotes" });
    try {
      const { eye } = await openEye(place, gh);
      await eye.prime();
      await place.commit("src/rogue.ts", "export const rogue = 1;\n", "orphan work");

      const filings = await eye.scan();

      expect(filings[0]!.outcome).toBe("digest-note");
      const note = await Bun.file(
        join(place.repo, ".argus/eyes/retro/unfiled", `${filings[0]!.signalId}.md`),
      ).text();
      expect(note).toContain("Retro: orphan work");
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("a gh failure keeps the record and audits it — the eye never crashes", async () => {
    const place = await scratch();
    const gh = createFakeGh({
      repo: "JohanSardar/argus",
      failCreate: "label 'retro' not found",
    });
    try {
      const { eye, audits } = await openEye(place, gh);
      await eye.prime();
      await place.commit("src/rogue.ts", "export const rogue = 1;\n", "rogue work");
      await seedDigest(place.repo, "adhoc-sess-rogue.md", "Implemented something.");
      await eye.observeSession({ sessionId: "sess-rogue", cwd: place.repo });
      const digestPath = join(place.repo, ".argus/sessions/adhoc-sess-rogue.md");
      const before = await Bun.file(digestPath).text();

      const filings = await eye.scan();

      expect(filings[0]!.outcome).toBe("digest-note");
      expect(filings[0]!.reason).toContain("label 'retro' not found");
      expect(audits.some((audit) => audit.type === "retro-file-failed")).toBe(true);
      expect(await Bun.file(digestPath).text()).toBe(before);
      const note = await Bun.file(
        join(
          place.repo,
          ".argus/eyes/retro/unfiled",
          `${filings[0]!.signalId}.md`,
        ),
      ).text();
      expect(note).toContain("Retro: rogue work");
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("an unlinkable sub-issue still files the retro, loudly unlinked", async () => {
    const place = await scratch();
    const gh = createFakeGh({
      repo: "JohanSardar/argus",
      failLink: "sub-issues API unavailable",
    });
    gh.seed({ number: 15, title: "Ship the widget pipeline" });
    try {
      const { eye, audits } = await openEye(place, gh);
      await eye.prime();
      await place.commit("src/rogue.ts", "export const rogue = 1;\n", "rogue work");

      const filings = await eye.scan();

      expect(filings[0]!.outcome).toBe("filed");
      expect(filedIssue(gh)!.state).toBe("closed");
      expect(audits.some((audit) => audit.type === "retro-unlinked")).toBe(true);
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);
});

describe("the Retro eye's state survives a restart", () => {
  test("concurrent state persists on one file both complete", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    try {
      const harness = await openEye(place, gh);

      await Promise.all([
        harness.eye.observeSession({ sessionId: "sess-one", cwd: place.repo }),
        harness.eye.observeSession({ sessionId: "sess-two", cwd: place.repo }),
      ]);

      const restarted = await harness.reopen();
      await Promise.all([
        restarted.observeSession({ sessionId: "sess-three", cwd: place.repo }),
        restarted.observeSession({ sessionId: "sess-four", cwd: place.repo }),
      ]);
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("the git cursor and the filed set are persisted", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    try {
      const harness = await openEye(place, gh);
      await harness.eye.prime();
      await place.commit("src/a.ts", "export const a = 1;\n", "add a");
      const first: RetroFiling[] = await harness.eye.scan();
      expect(first).toHaveLength(1);

      const restarted = await harness.reopen();
      expect(await restarted.scan()).toEqual([]);

      await place.commit("src/b.ts", "export const b = 1;\n", "add b");
      expect(await restarted.scan()).toHaveLength(1);
      expect(gh.issues.filter((issue) => issue.labels.includes("retro"))).toHaveLength(2);
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("priming a fresh repo never retros the history that predates the eye", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    try {
      await place.commit("src/old.ts", "export const old = 1;\n", "ancient history");
      const { eye } = await openEye(place, gh);
      await eye.prime();

      expect(await eye.scan()).toEqual([]);
      expect(gh.issues).toHaveLength(0);
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);
});

describe("the working tree is a cursor too, not a standing accusation", () => {
  test("a tree already dirty when the eye starts is never retro'd", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    try {
      // What `argus up` leaves behind: scaffolding nobody has committed yet.
      await mkdir(join(place.repo, "docs/agents"), { recursive: true });
      await writeFile(join(place.repo, "docs/agents/issue-tracker.md"), "# Tracker\n");
      await writeFile(join(place.repo, "AGENTS.md"), "# Agents\n");

      const { eye } = await openEye(place, gh);
      await eye.prime();

      expect(await eye.scan()).toEqual([]);
      expect(gh.issues).toHaveLength(0);
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("uncommitted work that appears AFTER priming files a retro", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    try {
      await writeFile(join(place.repo, "already-here.md"), "# Notes\n");
      const { eye } = await openEye(place, gh);
      await eye.prime();
      await mkdir(join(place.repo, "src"), { recursive: true });
      await writeFile(join(place.repo, "src/wip.ts"), "export const wip = 1;\n");

      const filings = await eye.scan();

      expect(filings).toHaveLength(1);
      expect(filedIssue(gh)!.body).toContain("src/wip.ts");
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("the same unchanged dirty tree is not reported twice", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    try {
      const { eye } = await openEye(place, gh);
      await eye.prime();
      await mkdir(join(place.repo, "src"), { recursive: true });
      await writeFile(join(place.repo, "src/wip.ts"), "export const wip = 1;\n");

      expect(await eye.scan()).toHaveLength(1);
      expect(await eye.scan()).toEqual([]);
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);
});

describe("rogue work in a worktree belongs to the parent repo (§7.3)", () => {
  test("a commit made in a linked worktree files a retro against the parent tracker", async () => {
    const place = await scratch();
    const worktree = join(place.root, "worktrees/rogue");
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    try {
      await place.git("worktree", "add", "--quiet", "-b", "build/rogue", worktree);
      const { eye } = await openEye(place, gh);
      await eye.prime();

      await mkdir(join(worktree, "src"), { recursive: true });
      await writeFile(join(worktree, "src/rogue.ts"), "export const rogue = 1;\n");
      await gitIn(worktree, "add", "src/rogue.ts");
      await gitIn(worktree, "commit", "--quiet", "-m", "worktree rogue work");

      // The eye watches the PARENT repo; it must still see the worktree work.
      const filings = await eye.scan();

      expect(filings).toHaveLength(1);
      expect(filedIssue(gh)!.title).toBe("Retro: worktree rogue work");
      // gh ran against the parent repo tracker, from the parent checkout.
      expect(gh.cwds.every((cwd) => cwd === place.repo)).toBe(true);
      expect(filedIssue(gh)!.body).toContain("worktree of");
      expect(filedIssue(gh)!.body).toContain("src/rogue.ts");
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);
});

describe("a first scan primes instead of accusing the whole repo", () => {
  test("scanning before prime() anchors the cursor and files nothing", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    try {
      await place.commit("src/old.ts", "export const old = 1;\n", "ancient history");
      const { eye } = await openEye(place, gh);

      // No prime() call: the watcher loop just starts ticking.
      expect(await eye.scan()).toEqual([]);
      expect(gh.issues).toHaveLength(0);

      await place.commit("src/new.ts", "export const fresh = 1;\n", "new work");
      expect(await eye.scan()).toHaveLength(1);
      expect(filedIssue(gh)!.title).toBe("Retro: new work");
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);
});

describe("two eyes in one process never share state", () => {
  test("startup priming keeps each repo's cursor independent", async () => {
    const first = await scratch();
    const second = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    try {
      const one = (await openEye(first, gh)).eye;
      const two = (await openEye(second, gh)).eye;

      await first.commit("src/a.ts", "export const a = 1;\n", "first repo work");
      await second.commit("src/b.ts", "export const b = 1;\n", "second repo work");

      expect((await two.scan()).map((filing) => filing.title)).toEqual([
        "Retro: second repo work",
      ]);
      expect((await one.scan()).map((filing) => filing.title)).toEqual(["Retro: first repo work"]);
    } finally {
      await first.cleanup();
      await second.cleanup();
    }
  }, BUDGET_MS);
});

const SCOPE_SEVEN =
  "Build the widget renderer and its cache.\n" +
  "The pipeline must stream, and the renderer needs a fixture test.";
const SCOPE_NINE =
  "Retries, timeouts and error paths for src/fetch-helper.ts.\n" +
  "The retry loop needs a fixture test for the 429 path.";

async function registerTicketSession(
  repo: string,
  sessionId: string,
  ticket: string,
  workspace: string,
): Promise<void> {
  await registerSession(repo, {
    ts: "2026-08-25T09:00:00Z",
    sessionId,
    dispatchPrompt: `You are a BUILD worker for ticket #${ticket}.`,
    agent: "codex",
    ticket,
    workspace,
  });
}

describe("in-ticket scope drift (SPEC §14, #38)", () => {
  test("out-of-scope work in a REGISTERED ticket session files under that ticket", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    gh.seed({ number: 7, title: "Ship the widget pipeline", body: SCOPE_SEVEN });
    try {
      const { eye } = await openEye(place, gh);
      await eye.prime();
      await registerTicketSession(place.repo, "sess-seven", "7", place.repo);
      await place.commit(
        "src/billing/stripe-webhooks.ts",
        "export const onStripeEvent = () => {};\n",
        "feat: add stripe billing webhooks",
      );

      const filings = await eye.scan();

      expect(filings).toHaveLength(1);
      expect(filings[0]!.kind).toBe("scope-drift");
      expect(filings[0]!.outcome).toBe("filed");
      expect(filings[0]!.parent).toBe("7");
      const issue = filedIssue(gh)!;
      expect(issue.parent).toBe(7);
      expect(issue.state).toBe("closed");
      expect(issue.title).toContain("out of scope for #7");
      expect(issue.body).toContain("#7 Ship the widget pipeline");
      expect(issue.body).toContain("> Build the widget renderer and its cache.");
      expect(issue.body).toContain("stripe-webhooks");
      expect(issue.body).toContain("sess-seven");
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("an IN-SCOPE refactor in a registered ticket session files NOTHING", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    gh.seed({ number: 9, title: "Harden the fetch helper", body: SCOPE_NINE });
    try {
      const { eye } = await openEye(place, gh);
      await eye.prime();
      await registerTicketSession(place.repo, "sess-nine", "9", place.repo);
      await place.commit(
        "src/fetch-helper.ts",
        "export const fetchWithRetry = () => {};\n",
        "refactor: extract the retry loop from the fetch helper",
      );

      expect(await eye.scan()).toEqual([]);
      expect(gh.issues.filter((issue) => issue.labels.includes("retro"))).toHaveLength(0);
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("a one-line ticket body states too little scope to judge — silence, not a guess", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    gh.seed({ number: 7, title: "Ship the widget pipeline", body: "Do the pipeline." });
    try {
      const { eye } = await openEye(place, gh);
      await eye.prime();
      await registerTicketSession(place.repo, "sess-seven", "7", place.repo);
      await place.commit(
        "src/billing/stripe-webhooks.ts",
        "export const onStripeEvent = () => {};\n",
        "feat: add stripe billing webhooks",
      );

      expect(await eye.scan()).toEqual([]);
      expect(gh.issues.filter((issue) => issue.labels.includes("retro"))).toHaveLength(0);
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("a ticket CLOSED mid-session is still judged, and still files", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    gh.seed({
      number: 7,
      title: "Ship the widget pipeline",
      body: SCOPE_SEVEN,
      state: "closed",
    });
    try {
      const { eye } = await openEye(place, gh);
      await eye.prime();
      await registerTicketSession(place.repo, "sess-seven", "7", place.repo);
      await place.commit(
        "src/billing/stripe-webhooks.ts",
        "export const onStripeEvent = () => {};\n",
        "feat: add stripe billing webhooks",
      );

      const filings = await eye.scan();

      expect(filings).toHaveLength(1);
      expect(filings[0]!.parent).toBe("7");
      expect(filedIssue(gh)!.parent).toBe(7);
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("the same drift is never filed twice", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    gh.seed({ number: 7, title: "Ship the widget pipeline", body: SCOPE_SEVEN });
    try {
      const { eye } = await openEye(place, gh);
      await eye.prime();
      await registerTicketSession(place.repo, "sess-seven", "7", place.repo);
      await place.commit(
        "src/billing/stripe-webhooks.ts",
        "export const onStripeEvent = () => {};\n",
        "feat: add stripe billing webhooks",
      );

      expect(await eye.scan()).toHaveLength(1);
      expect(await eye.scan()).toEqual([]);
      expect(gh.issues.filter((issue) => issue.labels.includes("retro"))).toHaveLength(1);
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("work in the ticket's own WORKTREE is judged against the parent repo's ticket", async () => {
    const place = await scratch();
    const worktree = join(place.root, "worktrees/seven");
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    gh.seed({ number: 7, title: "Ship the widget pipeline", body: SCOPE_SEVEN });
    try {
      await place.git("worktree", "add", "--quiet", "-b", "build/seven", worktree);
      const { eye } = await openEye(place, gh);
      await eye.prime();
      await registerTicketSession(place.repo, "sess-seven", "7", worktree);

      await mkdir(join(worktree, "src/billing"), { recursive: true });
      await writeFile(
        join(worktree, "src/billing/stripe-webhooks.ts"),
        "export const onStripeEvent = () => {};\n",
      );
      await gitIn(worktree, "add", "src/billing/stripe-webhooks.ts");
      await gitIn(worktree, "commit", "--quiet", "-m", "feat: add stripe billing webhooks");

      const filings = await eye.scan();

      expect(filings).toHaveLength(1);
      expect(filings[0]!.parent).toBe("7");
      // Filed against the PARENT repo's tracker, from the parent checkout.
      expect(gh.cwds.every((cwd) => cwd === place.repo)).toBe(true);
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);
});

describe("scope drift never takes the eye down (ADR-0001)", () => {
  test("a broken brain is reported and the pass moves on — no retry storm", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    gh.seed({ number: 7, title: "Ship the widget pipeline", body: SCOPE_SEVEN });
    try {
      const audits: RetroAudit[] = [];
      let brainCalls = 0;
      const eye = await RetroEye.open({
        repo: place.repo,
        brain: {
          // The #35 failure shape: a bare `exit 1` with empty stderr.
          evaluate: async () => {
            brainCalls += 1;
            return {
              ok: false as const,
              reason: "nonzero-exit" as const,
              detail: "exit 1: ",
            };
          },
        },
        cap: createBrainCap({
          directory: join(place.root, "brain-slots"),
          maxConcurrency: 2,
          pollMs: 1,
        }),
        cadence: { quietWindowSeconds: 60, maxWaitSeconds: 600 },
        gh: gh.run,
        now: () => 0,
        sleep: async () => {},
        onAudit: (audit) => {
          audits.push(audit);
        },
      });
      await eye.prime();
      await registerTicketSession(place.repo, "sess-seven", "7", place.repo);
      await place.commit(
        "src/billing/stripe-webhooks.ts",
        "export const onStripeEvent = () => {};\n",
        "feat: add stripe billing webhooks",
      );

      expect(await eye.scan()).toEqual([]);
      expect(brainCalls).toBe(1);
      expect(
        audits.some(
          (audit) => audit.type === "scope-drift-not-filed" && audit.ticket === "7",
        ),
      ).toBe(true);
      expect(gh.issues.filter((issue) => issue.labels.includes("retro"))).toHaveLength(0);
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("a schema miss is reported once, not retried forever", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    gh.seed({ number: 7, title: "Ship the widget pipeline", body: SCOPE_SEVEN });
    try {
      const audits: RetroAudit[] = [];
      let brainCalls = 0;
      const eye = await RetroEye.open({
        repo: place.repo,
        brain: {
          evaluate: async () => {
            brainCalls += 1;
            return { ok: true as const, text: '{"drifts":[{"nope":1}]}' };
          },
        },
        cap: createBrainCap({
          directory: join(place.root, "brain-slots"),
          maxConcurrency: 2,
          pollMs: 1,
        }),
        cadence: { quietWindowSeconds: 60, maxWaitSeconds: 600 },
        gh: gh.run,
        now: () => 0,
        sleep: async () => {},
        onAudit: (audit) => {
          audits.push(audit);
        },
      });
      await eye.prime();
      await registerTicketSession(place.repo, "sess-seven", "7", place.repo);
      await place.commit(
        "src/billing/stripe-webhooks.ts",
        "export const onStripeEvent = () => {};\n",
        "feat: add stripe billing webhooks",
      );

      expect(await eye.scan()).toEqual([]);
      expect(brainCalls).toBe(1);
      expect(
        audits.some(
          (audit) =>
            audit.type === "scope-drift-not-filed" && audit.reason.includes("schema"),
        ),
      ).toBe(true);
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("a brain that THROWS is caught too — the scan returns, the eye lives", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    gh.seed({ number: 7, title: "Ship the widget pipeline", body: SCOPE_SEVEN });
    try {
      const audits: RetroAudit[] = [];
      const eye = await RetroEye.open({
        repo: place.repo,
        brain: {
          evaluate: async () => {
            throw new Error("codex vanished mid-flight");
          },
        },
        cap: createBrainCap({
          directory: join(place.root, "brain-slots"),
          maxConcurrency: 2,
          pollMs: 1,
        }),
        cadence: { quietWindowSeconds: 60, maxWaitSeconds: 600 },
        gh: gh.run,
        now: () => 0,
        sleep: async () => {},
        onAudit: (audit) => {
          audits.push(audit);
        },
      });
      await eye.prime();
      await registerTicketSession(place.repo, "sess-seven", "7", place.repo);
      await place.commit(
        "src/billing/stripe-webhooks.ts",
        "export const onStripeEvent = () => {};\n",
        "feat: add stripe billing webhooks",
      );

      expect(await eye.scan()).toEqual([]);
      expect(
        audits.some(
          (audit) =>
            audit.type === "scope-drift-not-filed" &&
            audit.reason.includes("codex vanished mid-flight"),
        ),
      ).toBe(true);
      // The slot it took is released, or the next scan would hang forever.
      expect(await eye.scan()).toEqual([]);
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("a gh failure keeps the drift record separate from its source digest", async () => {
    const place = await scratch();
    const gh = createFakeGh({
      repo: "JohanSardar/argus",
      failCreate: "label 'retro' not found",
    });
    gh.seed({ number: 7, title: "Ship the widget pipeline", body: SCOPE_SEVEN });
    try {
      const { eye, audits } = await openEye(place, gh);
      await eye.prime();
      await registerTicketSession(place.repo, "sess-seven", "7", place.repo);
      await seedDigest(place.repo, "7-sess-seven.md", "Working ticket seven.");
      const digestPath = join(place.repo, ".argus/sessions/7-sess-seven.md");
      const before = await Bun.file(digestPath).text();
      await place.commit(
        "src/billing/stripe-webhooks.ts",
        "export const onStripeEvent = () => {};\n",
        "feat: add stripe billing webhooks",
      );

      const filings = await eye.scan();

      expect(filings).toHaveLength(1);
      expect(filings[0]!.outcome).toBe("digest-note");
      expect(audits.some((audit) => audit.type === "retro-file-failed")).toBe(true);
      expect(await Bun.file(digestPath).text()).toBe(before);
      const note = await Bun.file(
        join(
          place.repo,
          ".argus/eyes/retro/unfiled",
          `${filings[0]!.signalId}.md`,
        ),
      ).text();
      expect(note).toContain("out of scope for #7");
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);

  test("tracker-less mode cannot read a stated scope, so it asks nothing", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus", failView: "no git remotes" });
    try {
      const { eye, audits } = await openEye(place, gh);
      await eye.prime();
      await registerTicketSession(place.repo, "sess-seven", "7", place.repo);
      await place.commit(
        "src/billing/stripe-webhooks.ts",
        "export const onStripeEvent = () => {};\n",
        "feat: add stripe billing webhooks",
      );

      expect(await eye.scan()).toEqual([]);
      expect(
        audits.some(
          (audit) =>
            audit.type === "scope-drift-not-filed" && audit.reason.includes("tracker"),
        ),
      ).toBe(true);
    } finally {
      await place.cleanup();
    }
  }, BUDGET_MS);
});
