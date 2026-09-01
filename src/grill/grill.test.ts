import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { sendToWorker, type GitRun, type GitRunResult } from "../deploy";
import type { CmuxRun, CmuxRunResult } from "../events";
import { classifierFromRegistry, loadRegistry, registryPaths } from "../provenance";
import type { MessageEvent } from "../tailing";
import { fakeMachine, withFrontmatter } from "./machine.fixture.ts";
import { startGrill } from "./index.ts";

/**
 * Ticket #62 — SPEC §7.2, Johan's planning entry point.
 *
 *   1. Johan tells Hermes "grill X for repo R."
 *   2. Hermes registers the deployment, creates a cmux workspace in R, spawns
 *      Claude Code with the grill skill, and notifies Johan to attach.
 *   3. Johan answers in the terminal directly.
 *
 * Step 3 is what makes this different from every dispatch #55 and #56 built:
 * the session is a TERMINAL Johan types into, so it cannot be a headless child
 * of the CLI. It is launched by typing into a cmux workspace — and that puts
 * the whole flow one quoting bug away from the §5 poisoning failure, because a
 * prompt that lands in a shape the registry did not record hashes differently
 * and classifies as JOHAN.
 *
 * So the tests below assert the two orderings and the one classification:
 *
 * - the deployment row is durable BEFORE a single key is typed (§5 rule 1),
 *   observed from inside the delivery seam rather than after the fact;
 * - a workspace cmux does not resolve is never typed into, and when the grill
 *   cannot get one, NOTHING is written (#7's focused-workspace hazard, which
 *   once put a stray line into Johan's live session);
 * - the injected prompt classifies `hermes`/`dispatch-prompt`, and a line
 *   Johan actually types into the same session still classifies as his.
 *
 * Every cmux seam here is the PRODUCTION one (`createCmuxSend` over the
 * injected runner), so the resolve-guard under test is #7's, not a copy.
 */
/**
 * #97: the machine the routed skill is resolved against, described here rather
 * than read off the developer's real plugin cache — a test that reads
 * `~/.claude/plugins/installed_plugins.json` passes or fails for reasons that
 * have nothing to do with this repo. Every `startGrill` below is dispatched
 * against it.
 */
const MACHINE = await fakeMachine();

const SESSION = "11111111-2222-4333-8444-555555555555";
const TOPIC = "the retro eye's scope-drift question";

/** #95: the grill's tab goes in the workspace Argus is already running in. */
const GRILL_ENV = { ...process.env, CMUX_WORKSPACE_ID: "2D3B8B38-C9FC-46F4-A512-8F1157CE2E10" };

const ok = (stdout = ""): CmuxRunResult => ({ exitCode: 0, stderr: "", stdout });
const fail = (stderr: string): CmuxRunResult => ({ exitCode: 1, stderr, stdout: "" });

const ARGUS_WS = "2D3B8B38-C9FC-46F4-A512-8F1157CE2E10";
const DISPATCHER = "E0492BBB-0A3B-4393-B50B-75EB3439EB6C";
const GRILL = "AAAA1111-2222-4333-8444-555555555555";

/**
 * A cmux 0.62.2 with ONE workspace — Johan's, the one Argus is running in —
 * that hands out a TAB for the one create it is asked for (#95).
 *
 * `surfaceSets` replaces #62's `listings`, one-for-one: it is the same
 * "what does cmux say it has, on each successive read" dial, moved from
 * workspaces to surfaces because that is what Argus now creates. The default
 * has three entries for the same reason the old default did — the create's
 * before-read, its after-read, and the send guard's re-read.
 */
function cmuxStub(
  overrides: {
    surfaceSets?: string[][];
    notify?: CmuxRunResult;
    onSend?: () => Promise<void> | void;
  } = {},
): { calls: string[][]; launches: string[]; run: CmuxRun } {
  const sets = overrides.surfaceSets ?? [
    [DISPATCHER],
    [DISPATCHER, GRILL],
    [DISPATCHER, GRILL],
  ];
  const calls: string[][] = [];
  const launches: string[] = [];
  let sent = "";
  let read = 0;
  const current = (): string[] => {
    const set = sets[Math.min(read, sets.length - 1)] ?? [];
    read += 1;
    return set;
  };
  const tree = (surfaces: string[]): string =>
    JSON.stringify({
      windows: [
        {
          workspaces: [
            {
              id: ARGUS_WS,
              panes: [
                {
                  ref: "pane:1",
                  surfaces: surfaces.map((id, index) => ({
                    id,
                    ref: `surface:${index + 1}`,
                  })),
                },
              ],
              ref: "workspace:1",
              title: "argus",
            },
          ],
        },
      ],
    });
  const run: CmuxRun = async (args) => {
    calls.push([...args]);
    if (args.includes("tree")) return ok(tree(current()));
    switch (args[0]) {
      case "list-workspaces":
        // Window-scoped on the real CLI, and on this machine it does NOT list
        // the workspace the dispatcher runs in. The guard's `tree` fallback
        // (#95) is what resolves it, so this answers as the real one does.
        return ok("");
      case "new-surface":
        return ok("");
      case "rename-tab":
        return ok("");
      case "send": {
        await overrides.onSend?.();
        sent = args.at(-1) ?? "";
        const encodedPath = sent.match(/printf %s '([^']+)' \| \/usr\/bin\/base64 -D/)?.[1];
        if (encodedPath !== undefined) {
          const launchFile = Buffer.from(encodedPath, "base64").toString("utf8");
          launches.push(await Bun.file(launchFile).text());
        }
        return ok("");
      }
      case "send-key": {
        const child = Bun.spawn(["/bin/zsh", "-c", sent], {
          stderr: "ignore",
          stdout: "ignore",
        });
        child.unref();
        return ok("");
      }
      case "notify":
        return overrides.notify ?? ok("");
      default:
        throw new Error(`unscripted cmux ${args.join(" ")}`);
    }
  };
  return { calls, launches, run };
}

/** A git that answers the one question a repo-checkout grill asks. */
function gitStub(): { args: string[][]; run: GitRun } {
  const args: string[][] = [];
  const run: GitRun = async (a): Promise<GitRunResult> => {
    args.push([...a]);
    return { exitCode: 0, stderr: "", stdout: "main\n" };
  };
  return { args, run };
}

async function sandboxRepo(): Promise<string> {
  return mkdtemp(join(tmpdir(), "argus-grill-"));
}

const landing = (text: string, ts: string): MessageEvent => ({
  candidate: true,
  file: "/transcript.jsonl",
  promptSource: "typed",
  role: "user",
  sessionId: SESSION,
  text,
  ts,
  type: "message",
});

/** Decode dynamic words from the one-line cmux transport for argv assertions. */
const decodedTransportValues = (line: string): string[] =>
  [...line.matchAll(/printf %s '([^']*)' \| \/usr\/bin\/base64 -D/g)].map((match) =>
    Buffer.from(match[1] ?? "", "base64").toString("utf8"),
  );

describe("startGrill (#62): SPEC §7.2, registered before a key is typed", () => {
  test("the deployment row is durable before the launch line is typed", async () => {
    const repo = await sandboxRepo();
    try {
      let registryAtSend = "";
      const cmux = cmuxStub({
        onSend: async () => {
          const file = Bun.file(registryPaths(repo).sessionsFile);
          registryAtSend = (await file.exists()) ? await file.text() : "";
        },
      });
      const git = gitStub();
      const result = await startGrill(
        { repo, ticket: "62", topic: TOPIC },
        {
          cmux: cmux.run,
          env: GRILL_ENV,
          git: git.run,
          manifestFile: MACHINE.manifest,
          newSessionId: () => SESSION,
          now: () => new Date("2026-08-26T09:00:00.000Z"),
        },
      );

      expect(result.status).toBe("started");
      if (result.status !== "started") return;
      // #95: Johan's OWN workspace, because the grill no longer gets one of
      // its own. The handle that identifies the session is the surface.
      expect(result.workspace).toBe(ARGUS_WS);
      expect(result.sessionId).toBe(SESSION);

      // THE ORDERING PROOF, taken by another reader at the instant the launch
      // line went out. Swap register and type, and this is the empty string.
      const row = JSON.parse(registryAtSend.trim()) as Record<string, unknown>;
      expect(row.sessionId).toBe(SESSION);
      expect(row.workspace).toBe(ARGUS_WS);
      // #95: and the SURFACE, durable in the same row. Teardown reads the tab
      // handle back out of the registry — a row with a workspace and no
      // surface is a tab nothing can ever close, which is the leak itself.
      expect(row.surface).toBe(GRILL);
      expect(row.dispatchPrompt).toBe(result.prompt);
      expect(row.agent).toBe("claude");
      // §7.5: planning and grilling sessions are exempt from implementation-
      // scope enforcement, but remain registered to their owning ticket.
      expect(row.ticket).toBe("62");

      // §7.2 (as amended by #95) says a tab "in R" — the repo itself. A grill produces
      // a spec and tickets, and on a worktree branch nobody merges that output
      // is stranded, so no worktree is created.
      expect(git.args.some((a) => a[0] === "worktree")).toBe(false);

      const typed = cmux.calls.find((a) => a[0] === "send")?.at(-1) ?? "";
      const transported = decodedTransportValues(cmux.launches[0] ?? "");
      expect(transported).toContain("--session-id");
      expect(transported).toContain(SESSION);
      expect(typed.split("\n")).toHaveLength(1);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("the injected prompt classifies hermes/dispatch-prompt, never johan", async () => {
    const repo = await sandboxRepo();
    try {
      const cmux = cmuxStub();
      const result = await startGrill(
        { repo, ticket: "62", topic: TOPIC },
        {
          cmux: cmux.run,
          env: GRILL_ENV,
          git: gitStub().run,
          manifestFile: MACHINE.manifest,
          newSessionId: () => SESSION,
          now: () => new Date("2026-08-26T09:00:00.000Z"),
        },
      );
      expect(result.status).toBe("started");
      if (result.status !== "started") return;

      const { classifier } = classifierFromRegistry(
        await loadRegistry(registryPaths(repo)),
      );
      const injected = classifier.handle(
        landing(result.prompt, "2026-08-26T09:00:03.000Z"),
      );
      expect({
        author: injected.record?.author,
        via: injected.record?.via,
      }).toEqual({ author: "hermes", via: "dispatch-prompt" });
      expect(injected.record?.johanTouched).toBe(false);

      // The control: the classifier is not simply calling everything Hermes.
      // Johan answering in the terminal — §7.2 step 3 — is still Johan.
      const answered = classifier.handle(
        landing("no, keep the retro eye out of it", "2026-08-26T09:04:00.000Z"),
      );
      expect({
        author: answered.record?.author,
        via: answered.record?.via,
      }).toEqual({ author: "johan", via: "takeover" });
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("a follow-up into the grill session classifies hermes/registry-send", async () => {
    const repo = await sandboxRepo();
    try {
      const cmux = cmuxStub();
      const started = await startGrill(
        { repo, ticket: "62", topic: TOPIC },
        { cmux: cmux.run, env: GRILL_ENV, git: gitStub().run, manifestFile: MACHINE.manifest,
          newSessionId: () => SESSION },
      );
      expect(started.status).toBe("started");

      const nudge = "one more: what happens when two grills run in the same repo";
      const sent = await sendToWorker(
        { now: () => new Date("2026-08-26T10:00:00.000Z"), repo, sessionId: SESSION, text: nudge },
        { resolve: async () => ({ ok: true }), send: async () => ({ ok: true }) },
      );
      expect(sent.status).toBe("sent");

      const { classifier } = classifierFromRegistry(
        await loadRegistry(registryPaths(repo)),
      );
      const record = classifier.handle(
        landing(nudge, "2026-08-26T10:00:02.000Z"),
      ).record;
      expect({ author: record?.author, via: record?.via }).toEqual({
        author: "hermes",
        via: "registry-send",
      });
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("the launch line is typed but NOT logged as a send", async () => {
    const repo = await sandboxRepo();
    try {
      const cmux = cmuxStub();
      await startGrill(
        { repo, ticket: "62", topic: TOPIC },
        { cmux: cmux.run, env: GRILL_ENV, git: gitStub().run, manifestFile: MACHINE.manifest,
          newSessionId: () => SESSION },
      );
      // It is a SHELL command line, not a prompt into a session. Logging it
      // would put a Hermes attribution in the matcher's window that no
      // transcript can ever match (`send-expired`), and if Johan later typed
      // those same words they would stop being his — the exact phantom
      // `sendToWorker` refuses to create.
      expect((await loadRegistry(registryPaths(repo))).sends).toEqual([]);
      expect(cmux.calls.filter((a) => a[0] === "send")).toHaveLength(1);
      expect(cmux.calls.filter((a) => a[0] === "send-key")).toHaveLength(1);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("a tab cmux will not resolve is refused with nothing written", async () => {
    const repo = await sandboxRepo();
    try {
      // 0.62.2's `new-surface` prints no ref either, so the handle is
      // discovered from cmux's own inventory. Here the inventory does not
      // grow: guessing would type the grill launch line into whatever Johan is
      // looking at (#7), and it is a shell command, so it would RUN there.
      const cmux = cmuxStub({ surfaceSets: [[DISPATCHER], [DISPATCHER]] });
      const result = await startGrill(
        { repo, ticket: "62", topic: TOPIC },
        { cmux: cmux.run, env: GRILL_ENV, git: gitStub().run, manifestFile: MACHINE.manifest,
          newSessionId: () => SESSION },
      );
      expect(result.status).toBe("refused");
      expect(cmux.calls.some((a) => a[0] === "send")).toBe(false);
      expect((await loadRegistry(registryPaths(repo))).sessions).toEqual([]);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("a ref that stops resolving between create and launch types nothing", async () => {
    const repo = await sandboxRepo();
    try {
      // Created and discovered, then gone by the time the guard re-asks.
      const cmux = cmuxStub({
        surfaceSets: [[DISPATCHER], [DISPATCHER, GRILL], [DISPATCHER]],
      });
      const result = await startGrill(
        { repo, ticket: "62", topic: TOPIC },
        { cmux: cmux.run, env: GRILL_ENV, git: gitStub().run, manifestFile: MACHINE.manifest,
          newSessionId: () => SESSION },
      );
      expect(result.status).toBe("failed");
      if (result.status === "failed") {
        expect(result.reason).toContain("does not resolve");
        // Loud, not tidied away: the row was already durable, and #55's rule
        // is that a row is never retracted. The classifier's own
        // `dispatch-expired` audit is the answer to a prompt that never lands.
        expect(result.sessionId).toBe(SESSION);
      }
      expect(cmux.calls.some((a) => a[0] === "send-key")).toBe(false);
      expect((await loadRegistry(registryPaths(repo))).sessions).toHaveLength(1);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("cmux hooks are never invoked; 0.62.2 has no installer and still grills", async () => {
    const repo = await sandboxRepo();
    try {
      const cmux = cmuxStub();
      const guarded: CmuxRun = async (args) => {
        // This machine is permanently on 0.62.2, where `cmux hooks setup` does
        // not exist. Anything that reached for it would not degrade — it would
        // throw here, exactly as the real CLI would fail.
        if (args[0] === "hooks") throw new Error("cmux 0.62.2 has no `hooks` command");
        return cmux.run(args);
      };
      const result = await startGrill(
        { repo, ticket: "62", topic: TOPIC },
        { cmux: guarded, env: GRILL_ENV, git: gitStub().run, manifestFile: MACHINE.manifest,
          newSessionId: () => SESSION },
      );
      expect(result.status).toBe("started");
      expect(cmux.calls.some((a) => a[0] === "hooks")).toBe(false);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("a failed attach notification degrades loudly; the grill still ran", async () => {
    const repo = await sandboxRepo();
    try {
      const cmux = cmuxStub({ notify: fail("notification centre is not available") });
      const result = await startGrill(
        { repo, ticket: "62", topic: TOPIC },
        { cmux: cmux.run, env: GRILL_ENV, git: gitStub().run, manifestFile: MACHINE.manifest,
          newSessionId: () => SESSION },
      );
      expect(result.status).toBe("started");
      if (result.status !== "started") return;
      expect(result.notified).toBe(false);
      expect(result.degraded.join(" ")).toContain("notification centre");
      // The session is live and attachable whatever the notifier did, so the
      // command still has to say where it is.
      // #95: the tab, not the workspace. The workspace is Johan's own and he
      // may already be looking at it; the surface is what names the session.
      expect(result.attach).toContain(GRILL);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("the prompt carries the routed skill, the topic and the no-implementation rule", async () => {
    const repo = await sandboxRepo();
    try {
      const result = await startGrill(
        { repo, ticket: "62", topic: TOPIC },
        { cmux: cmuxStub().run, env: GRILL_ENV, git: gitStub().run, manifestFile: MACHINE.manifest,
          newSessionId: () => SESSION },
      );
      expect(result.status).toBe("started");
      if (result.status !== "started") return;
      expect(result.skill).toBe("pocock-plus:grilling");
      expect(result.prompt).toContain("pocock-plus:grilling");
      expect(result.prompt).toContain(TOPIC);
      expect(result.prompt).toMatch(/planning session/i);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  /**
   * #97 — THE DISPATCH-TIME REFUSAL, and the failure it replaces.
   *
   * The mode resolves. It resolved for the whole time the bug shipped. What it
   * cannot do is be INVOKED: a skill carrying both `disable-model-invocation:
   * true` and `user-invocable: false` is reachable by neither the model nor a
   * `/<id>` command, and `claude` offers no third way. Before this, the grill
   * opened a tab, wrote a durable row, typed a launch line and started a real
   * session that read a first sentence it could not honour — and then did
   * something adjacent, which is the whole of #97.
   *
   * So the check runs FIRST, ahead of the tab and ahead of the row, and the
   * assertion is that NOTHING happened: no cmux call at all, and no registry.
   */
  test("a mode no session could invoke is refused before a tab or a row exists", async () => {
    const repo = await sandboxRepo();
    const dead = await fakeMachine(
      withFrontmatter("to-spec", { modelOnly: true, slashOnly: true }),
    );
    try {
      const cmux = cmuxStub();
      const result = await startGrill(
        { mode: "spec", repo, ticket: "62", topic: TOPIC },
        {
          cmux: cmux.run,
          env: GRILL_ENV,
          git: gitStub().run,
          manifestFile: dead.manifest,
          newSessionId: () => SESSION,
        },
      );

      expect(result.status).toBe("refused");
      if (result.status !== "refused") return;
      // Named, because "grill refused" is unactionable: the operator has to be
      // able to go and read the frontmatter this is about.
      expect(result.reason).toContain("grill mode 'spec'");
      expect(result.reason).toContain("pocock-plus:to-spec");
      expect(result.reason).toContain("disable-model-invocation: true");
      expect(result.reason).toContain("user-invocable: false");
      expect(result.reason).toContain("nothing was registered and no cmux tab was opened");

      // Nothing was started, which is the point: not a tab, not a row, not a
      // keystroke. #55's rule is that a row is never retracted, so the only
      // safe place to refuse is before one exists.
      expect(cmux.calls).toEqual([]);
      expect((await loadRegistry(registryPaths(repo))).sessions).toEqual([]);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  /** The same mode on a machine where it is merely slash-only still runs. */
  test("a slash-only mode is dispatched, and the launch line carries /<id>", async () => {
    const repo = await sandboxRepo();
    const slash = await fakeMachine(withFrontmatter("to-spec", { slashOnly: true }));
    try {
      const cmux = cmuxStub();
      const result = await startGrill(
        { mode: "spec", repo, ticket: "62", topic: TOPIC },
        {
          cmux: cmux.run,
          env: GRILL_ENV,
          git: gitStub().run,
          manifestFile: slash.manifest,
          newSessionId: () => SESSION,
        },
      );

      expect(result.status).toBe("started");
      if (result.status !== "started") return;
      expect(result.prompt).toStartWith("/pocock-plus:to-spec\n");
      expect(result.prompt).not.toContain("Use the pocock-plus:to-spec skill");
      // And it reaches the terminal in that shape: the registry's copy and the
      // typed copy are the same string, so the §5 dispatch match still holds.
      const typed = cmux.calls.find((a) => a[0] === "send")?.at(-1) ?? "";
      expect(decodedTransportValues(cmux.launches[0] ?? "")).toContain(result.prompt);
      expect(typed.split("\n")).toHaveLength(1);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });
});
