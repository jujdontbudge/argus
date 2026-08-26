import { describe, expect, test } from "bun:test";
import { mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { NATIVE_CLAUDE } from "../harness/subscription-gate.ts";
import {
  claudeProjectDir,
  createClaudeCodeSource,
  Tailer,
  type MessageEvent,
  type TailEvent,
} from "../tailing";
import { classifierFromRegistry, loadRegistry, registryPaths } from "../provenance";
import { deployWorker } from "./index.ts";

/**
 * Ticket #55 — the primitive against REAL agent CLIs.
 *
 * The audit's central lesson is that bugs survived in this build because tests
 * called internals directly while production went through another door. So
 * both drives below call `deployWorker` itself, with the production spawner,
 * the production router and the production registry writer, and assert on
 * artefacts the AGENT wrote — a Claude transcript, a codex rollout file — not
 * on anything the test handed in.
 *
 * Both are gated, for different reasons and with different costs:
 *
 * - The Claude half spends a real subscription call (no token, real HOME,
 *   sandbox cwd — SPEC §1 item 7 and #49's mode). `ARGUS_LIVE_AGENTS=1` or
 *   `ARGUS_LIVE_CLAUDE_SUBSCRIPTION=1`.
 * - The codex half spends NOTHING: a scratch `CODEX_HOME` has no auth, so the
 *   run reaches a 401 and stops. What it proves happens entirely before the
 *   model is ever reached — the session id announcement, the registry row, and
 *   the rollout file's first user record — so an unauthenticated codex is a
 *   complete oracle for it. It still touches the network and takes ~20s, so it
 *   is gated too: `ARGUS_LIVE_CODEX_DEPLOY=1`.
 */
const LIVE_BUDGET_MS = 300_000;

const claudeGate =
  Bun.env.ARGUS_LIVE_AGENTS === "1" ||
  Bun.env.ARGUS_LIVE_CLAUDE_SUBSCRIPTION === "1";
const codexGate = Bun.env.ARGUS_LIVE_CODEX_DEPLOY === "1";

const DISPATCH =
  "You are working ticket #55. Reply with exactly the word ACKNOWLEDGED and " +
  "nothing else. Do not run any commands and do not write any files.";

async function sandboxRepo(prefix: string): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), prefix));
  await Bun.$`git -C ${repo} init --quiet`.quiet();
  await Bun.$`git -C ${repo} commit --quiet --allow-empty -m base`
    .env({
      ...process.env,
      GIT_AUTHOR_EMAIL: "deploy@invalid.example",
      GIT_AUTHOR_NAME: "Argus Deploy",
      GIT_COMMITTER_EMAIL: "deploy@invalid.example",
      GIT_COMMITTER_NAME: "Argus Deploy",
    })
    .quiet();
  return repo;
}

const isMessage = (event: TailEvent): event is MessageEvent => event.type === "message";

describe.skipIf(!claudeGate)(
  "deployWorker live (#55): a real Claude session, registered before it existed",
  () => {
    test(
      "the preassigned id IS the transcript's session id, and the dispatch is hermes",
      async () => {
        const repo = await sandboxRepo("argus-live-deploy-");
        let worktree: string | undefined;
        try {
          const result = await deployWorker(
            {
              agent: "claude",
              dispatchPrompt: DISPATCH,
              executable: NATIVE_CLAUDE,
              repo,
              ticket: "55",
            },
            { env: { ...Bun.env, HOME: homedir() } },
          );
          expect(result.status).toBe("deployed");
          if (result.status !== "deployed") return;
          worktree = result.deployment.worktree;

          const exit = await result.deployment.process.exited;
          expect({ code: exit.exitCode, tail: exit.stderr.slice(-300) }).toEqual({
            code: 0,
            tail: exit.stderr.slice(-300),
          });

          // THE §5 RULE 1 PROOF, end to end and in production code for the
          // first time: the row Argus fsynced BEFORE the process started names
          // the very session the agent then wrote a transcript for. Until #55
          // the harness could only append this row afterwards, from the id it
          // read back out of the transcript.
          const slug = claudeProjectDir(await realpath(worktree), join(homedir(), ".claude/projects"));
          const events = await new Tailer(createClaudeCodeSource({ dir: slug })).catchUp();
          // Printed, because a live drive's value is its evidence, not its
          // verdict — `bun test` shows this above the result.
          console.log(
            `argus #55 claude deploy: ${JSON.stringify({
              preassignedSessionId: result.deployment.sessionId,
              branch: result.deployment.branch,
              worktree,
              transcriptSessions: [...new Set(events.map((event) => event.sessionId))],
              registryRow: (await Bun.file(registryPaths(repo).sessionsFile).text()).trim(),
            })}`,
          );
          const sessions = new Set(events.map((event) => event.sessionId));
          expect([...sessions]).toContain(result.deployment.sessionId);

          const { classifier } = classifierFromRegistry(
            await loadRegistry(registryPaths(repo)),
          );
          const dispatch = events
            .filter(isMessage)
            .find((event) => event.role === "user" && event.text.includes("ticket #55"));
          expect(dispatch).toBeDefined();
          const { record } = classifier.handle(dispatch!);
          expect({ author: record?.author, via: record?.via, ticket: record?.ticket }).toEqual({
            author: "hermes",
            ticket: "55",
            via: "dispatch-prompt",
          });
          expect(
            events
              .filter(isMessage)
              .some((event) => event.role === "assistant" && event.text.includes("ACKNOWLEDGED")),
          ).toBe(true);
        } finally {
          // The worktree AND the `<repo>-worktrees` parent the primitive created.
      if (worktree) await rm(dirname(worktree), { force: true, recursive: true });
          await rm(repo, { force: true, recursive: true });
        }
      },
      LIVE_BUDGET_MS,
    );
  },
);

describe.skipIf(!codexGate)(
  "deployWorker live (#55): a real codex session, registered before the prompt lands",
  () => {
    test(
      "the row is durable while the rollout file still has no user message",
      async () => {
        const repo = await sandboxRepo("argus-live-codex-");
        const codexHome = await mkdtemp(join(tmpdir(), "argus-codex-home-"));
        let worktree: string | undefined;
        try {
          const result = await deployWorker(
            { agent: "codex", dispatchPrompt: DISPATCH, repo, ticket: "55" },
            { env: { ...Bun.env, CODEX_HOME: codexHome } },
          );
          expect(result.status).toBe("deployed");
          if (result.status !== "deployed") return;
          worktree = result.deployment.worktree;

          // `deployWorker` has returned, so the row is fsynced. The prompt has
          // NOT reached the rollout file yet — measured at ~1.2s behind the
          // `thread.started` announcement this row was written from, and on
          // this run the rollout file did not exist at all yet. This is the
          // ordering claim for the announced route, on the real artefact:
          // whatever the transcript ends up saying, the registry said it
          // first.
          const registry = await loadRegistry(registryPaths(repo));
          expect(registry.sessions.map(({ sessionId }) => sessionId)).toEqual([
            result.deployment.sessionId,
          ]);
          console.log(
            `argus #55 codex deploy: ${JSON.stringify({
              announcedSessionId: result.deployment.sessionId,
              registryRow: (await Bun.file(registryPaths(repo).sessionsFile).text()).trim(),
            })}`,
          );
          const early = await findRollout(codexHome, result.deployment.sessionId);
          const earlyText = early === null ? "" : await Bun.file(early).text();
          expect({ hasPrompt: earlyText.includes(DISPATCH) }).toEqual({ hasPrompt: false });

          // …and once the session has run, the rollout exists, carries the
          // prompt, and carries the id the row was written under.
          await result.deployment.process.exited;
          const rollout = await findRollout(codexHome, result.deployment.sessionId);
          expect(rollout).not.toBeNull();
          console.log(`argus #55 codex rollout: ${rollout}`);
          const finished = await Bun.file(rollout!).text();
          expect(finished).toContain(DISPATCH);
          expect(finished).toContain(result.deployment.sessionId);
        } finally {
          // The worktree AND the `<repo>-worktrees` parent the primitive created.
      if (worktree) await rm(dirname(worktree), { force: true, recursive: true });
          await rm(codexHome, { force: true, recursive: true });
          await rm(repo, { force: true, recursive: true });
        }
      },
      LIVE_BUDGET_MS,
    );
  },
);

/** `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ts>-<session-id>.jsonl`. */
async function findRollout(codexHome: string, sessionId: string): Promise<string | null> {
  const root = join(codexHome, "sessions");
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(path);
      else if (entry.name.includes(sessionId)) return path;
    }
  }
  return null;
}
