import { describe, expect, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createBrainCap } from "../cap";
import { applyDigestUpdate } from "../digest/outputs";
import type { ProvenanceRecord } from "../../provenance";
import { registryPaths } from "../../provenance";
import { createFakeGh, type FakeGh } from "./fake-gh";
import { fixtureRetroBrain } from "./fixture-brain";
import { RetroEye, type RetroAudit, type RetroFiling } from "./retro";

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

const filedIssue = (gh: FakeGh) =>
  gh.issues.find((issue) => issue.labels.includes("retro"));

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
      eye.observeSession({ sessionId: "sess-rogue", cwd: place.repo });
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
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);

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
  }, 60_000);

  test("Johan's own ad hoc implementation files a retro too (§7.4)", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus" });
    try {
      const { eye } = await openEye(place, gh);
      await eye.prime();
      await place.commit("src/johan.ts", "export const mine = true;\n", "johan's own fix");
      await seedDigest(place.repo, "adhoc-sess-johan.md", "Johan implemented a fix.");
      eye.observeSession({ sessionId: "sess-johan", cwd: place.repo });
      await eye.ingest([johanSays("sess-johan", "I'll just do this one myself")]);

      const filings = await eye.scan();

      expect(filings).toHaveLength(1);
      expect(filedIssue(gh)!.body).toContain("I'll just do this one myself");
      expect(filedIssue(gh)!.state).toBe("closed");
    } finally {
      await place.cleanup();
    }
  }, 60_000);

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
  }, 60_000);
});

describe("the Retro eye degrades loudly, never silently (ADR-0001)", () => {
  test("tracker-less mode writes the retro into the session digest and says so", async () => {
    const place = await scratch();
    const gh = createFakeGh({ repo: "JohanSardar/argus", failView: "no git remotes" });
    try {
      const { eye, audits } = await openEye(place, gh);
      await eye.prime();
      await place.commit("src/rogue.ts", "export const rogue = 1;\n", "rogue work");
      await seedDigest(place.repo, "adhoc-sess-rogue.md", "Implemented something.");
      eye.observeSession({ sessionId: "sess-rogue", cwd: place.repo });
      await eye.ingest([johanSays("sess-rogue", "do the thing")]);

      const filings = await eye.scan();

      expect(filings).toHaveLength(1);
      expect(filings[0]!.outcome).toBe("digest-note");
      expect(gh.issues).toHaveLength(0);
      const digest = await Bun.file(
        join(place.repo, ".argus/sessions/adhoc-sess-rogue.md"),
      ).text();
      expect(digest).toContain("Retro: rogue work");
      expect(digest).toContain("do the thing");
      expect(audits.some((audit) => audit.type === "tracker-less")).toBe(true);
    } finally {
      await place.cleanup();
    }
  }, 60_000);

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
  }, 60_000);

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
      eye.observeSession({ sessionId: "sess-rogue", cwd: place.repo });

      const filings = await eye.scan();

      expect(filings[0]!.outcome).toBe("digest-note");
      expect(filings[0]!.reason).toContain("label 'retro' not found");
      expect(audits.some((audit) => audit.type === "retro-file-failed")).toBe(true);
      expect(
        await Bun.file(join(place.repo, ".argus/sessions/adhoc-sess-rogue.md")).text(),
      ).toContain("Retro: rogue work");
    } finally {
      await place.cleanup();
    }
  }, 60_000);

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
  }, 60_000);
});

describe("the Retro eye's state survives a restart", () => {
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
  }, 60_000);

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
  }, 60_000);
});
