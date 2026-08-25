import { expect, test } from "bun:test";
import { appendFile, copyFile, mkdir, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadScaledMs } from "../eyes/test-budget.ts";
import {
  classifierFromRegistry,
  loadRegistry,
  registryPaths,
  type ProvenanceRecord,
} from "../provenance/index.ts";
import {
  claudeProjectDir,
  createClaudeCodeSource,
  createCodexSource,
  Tailer,
  type MessageEvent,
  type SessionMetaEvent,
  type TailEvent,
} from "../tailing/index.ts";
import { createIsolatedAgentSpawner, createSandbox, type Sandbox } from "./index.ts";
import {
  CODEX_AUTH_FILE,
  describeLiveAgentGate,
  liveHalfTitle,
  LIVE_AGENT_GATE,
  probeLiveAgents,
  resolveLiveAgentGate,
} from "./live-gate.ts";

/**
 * Ticket #43 — the §13 live-agent drives, permanently inside `bun test`.
 *
 * SPEC §13 names Claude Opus 5 and Codex sol high as the two test agents, and
 * until now no scenario had ever run either: #36's drive is a script, kept out
 * of the suite so the default gate carries no subscription burn. That cost is
 * real — a drive nothing reminds you to run is a drive that rots (#46) — but
 * so is the burn, so neither "always" nor "never" is the answer.
 *
 * The answer is opt-in and LOUD. `ARGUS_LIVE_AGENTS=1` runs these; unset,
 * they skip, and the skip carries its reason in the test name rather than
 * vanishing from the transcript. Nothing here is reachable on the default
 * path: no credential is read, no agent process starts.
 *
 * Isolation is the harness sandbox — scratch HOME, CLAUDE_CONFIG_DIR,
 * CODEX_HOME, HERMES_HOME, XDG and ARGUS_REPOS_FILE, a throwaway git repo and
 * a throwaway worktree per agent — plus #41's refusal, which rejects any
 * HOME/CLAUDE_CONFIG_DIR under the real home before a process starts.
 */
const checkout = fileURLToPath(new URL("../../", import.meta.url));
const gate = resolveLiveAgentGate(probeLiveAgents());

// Always, both ways. `bun test` prints no name for a skipped test, so this
// line is the whole of a skip's visibility on the default path.
console.log(describeLiveAgentGate(gate));

/** One real round trip each. #36 measured four Codex calls at 79.5s total. */
const LIVE_BUDGET_MS = loadScaledMs(300_000, 900_000);
const SANDBOX_BUDGET_MS = loadScaledMs(90_000, 300_000);

/**
 * What Hermes would have logged before opening the session (§5 rule 1). The
 * row is appended after the fact because the harness, not Hermes, dispatches
 * here; the content is what Hermes writes.
 */
async function registerDispatch(
  sandbox: Sandbox,
  agent: "claude" | "codex",
  sessionId: string,
  dispatchPrompt: string,
  workspace: string,
): Promise<void> {
  await appendFile(
    registryPaths(sandbox.repo).sessionsFile,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      sessionId,
      agent,
      ticket: "43",
      dispatchPrompt,
      workspace,
    })}\n`,
  );
}

async function classify(sandbox: Sandbox, events: TailEvent[]) {
  const { classifier } = classifierFromRegistry(
    await loadRegistry(registryPaths(sandbox.repo)),
  );
  const records: ProvenanceRecord[] = [];
  for (const event of events) {
    const { record } = classifier.handle(event);
    if (record) records.push(record);
  }
  return records;
}

/** Every `*.jsonl` under a root, newest last by name. */
async function transcripts(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".jsonl")) found.push(path);
    }
  };
  await walk(root);
  return found.sort();
}

const DISPATCH =
  "You are working ticket #43. Reply with exactly the word ACKNOWLEDGED and " +
  "nothing else. Do not run any commands and do not write any files.";

test(
  "the Claude half is isolated already — only the subscription call is unrun",
  async () => {
    const sandbox = await createSandbox({ checkout });

    try {
      const worktree = await sandbox.createWorktree("live-claude-isolation");
      const spawner = createIsolatedAgentSpawner({
        executables: { claude: "/must-not-run" },
      });

      // The refusal that fires is the one that proves the other did NOT: #41
      // rejects a real-home HOME/CLAUDE_CONFIG_DIR *before* the token is even
      // considered, so reaching the token message means this sandbox env is
      // already outside the real home. The day a token is provisioned, the
      // only untested thing left in that drive is the API call itself.
      expect(
        spawner.spawn({
          agent: "claude",
          command: ["claude", "-p", "must not run", "--model", "claude-opus-5"],
          cwd: worktree,
          env: sandbox.env,
          tab: `argus-test-${sandbox.id}-claude`,
        }),
      ).rejects.toThrow("needs a provisioned CLAUDE_CODE_OAUTH_TOKEN");
    } finally {
      await sandbox.teardown();
    }
  },
  SANDBOX_BUDGET_MS,
);

test("the default gate is closed, and both drives say so in their names", () => {
  // The wiring pin for this file. If a drive below is ever registered with a
  // bare `test(`, or titled with a constant, this is what notices.
  if (Bun.env[LIVE_AGENT_GATE] === "1") {
    expect(gate.enabled).toBe(true);
    return;
  }
  expect(gate.enabled).toBe(false);
  expect(liveHalfTitle("x", gate.claude)).toStartWith("x — SKIPPED: ");
  expect(liveHalfTitle("x", gate.codex)).toStartWith("x — SKIPPED: ");
});

test.skipIf(gate.codex.status !== "run")(
  liveHalfTitle(
    "§13 live drive: a real Codex sol high session through the harness seam",
    gate.codex,
  ),
  async () => {
    const sandbox = await createSandbox({ checkout });
    const codexHome = join(sandbox.root, "state", "codex-live");

    try {
      await mkdir(codexHome, { recursive: true });
      // The single production touchpoint SPEC §13 permits, and a copy: the
      // live session authenticates without ever writing to the real CODEX_HOME.
      await copyFile(CODEX_AUTH_FILE, join(codexHome, "auth.json"));
      const worktree = await sandbox.createWorktree("live-codex");

      const result = await createIsolatedAgentSpawner({}).spawn({
        agent: "codex",
        command: [
          "codex",
          "exec",
          "-c",
          "model_reasoning_effort=high",
          "--cd",
          worktree,
          // Stricter than the acceptance script's workspace-write: this drive
          // asserts on the transcript, so the agent needs no write at all.
          "--sandbox",
          "read-only",
          DISPATCH,
        ],
        cwd: worktree,
        env: { ...sandbox.env, CODEX_HOME: codexHome },
        tab: `argus-test-${sandbox.id}-codex`,
      });

      // stderr is compared to itself so a non-zero exit prints the CLI's own
      // complaint in the diff — the house idiom from all-scenarios.test.ts.
      expect({ exitCode: result.exitCode, stderr: result.stderr?.slice(-400) })
        .toEqual({ exitCode: 0, stderr: result.stderr?.slice(-400) });

      const rollouts = await transcripts(join(codexHome, "sessions"));
      expect(rollouts.length).toBeGreaterThan(0);
      const events = await new Tailer(createCodexSource({ codexHome })).catchUp();
      const messages = events.filter(
        (event): event is MessageEvent => event.type === "message",
      );
      const dispatched = messages.find((message) =>
        message.text.includes("ticket #43"),
      );
      expect(dispatched).toBeDefined();

      await registerDispatch(
        sandbox,
        "codex",
        dispatched!.sessionId,
        DISPATCH,
        worktree,
      );
      const records = await classify(sandbox, events);

      // §13.4 — the dispatch prompt is Hermes's, not Johan's.
      expect(
        records.some(
          (record) =>
            record.event.sessionId === dispatched!.sessionId &&
            record.via === "dispatch-prompt" &&
            record.author === "hermes",
        ),
      ).toBe(true);

      // §13.4, and the class that broke on first live contact in #36: a real
      // CLI injects its own user-role preamble, and none of it is Johan.
      expect(
        records
          .filter((record) => record.author === "johan")
          .map((record) => record.event.text.slice(0, 120)),
      ).toEqual([]);

      // §7.3 / #22 — a worktree cwd maps to the parent sandbox repo. Compared
      // through realpath: on macOS the sandbox lives under /var, which is a
      // symlink, and the child resolves its own cwd to /private/var.
      const metas = events.filter(
        (event): event is SessionMetaEvent => event.type === "session-meta",
      );
      const [realRepo, realWorktree] = await Promise.all([
        realpath(sandbox.repo),
        realpath(worktree),
      ]);
      expect(
        metas
          .filter((meta) => meta.sessionId === dispatched!.sessionId)
          .map(({ cwd, repo }) => ({ cwd, repo })),
      ).toContainEqual({ cwd: realWorktree, repo: realRepo });
    } finally {
      await sandbox.teardown();
    }
  },
  LIVE_BUDGET_MS,
);

test.skipIf(gate.claude.status !== "run")(
  liveHalfTitle(
    "§13 live drive: a real Claude Opus 5 session through the harness seam",
    gate.claude,
  ),
  async () => {
    const sandbox = await createSandbox({ checkout });

    try {
      const worktree = await sandbox.createWorktree("live-claude");
      const projects = join(sandbox.env.CLAUDE_CONFIG_DIR!, "projects");

      const result = await createIsolatedAgentSpawner({
        // Read here and nowhere else. The spawner injects it into the child
        // env only; nothing in this file logs, compares or persists it.
        claudeOauthToken: Bun.env.CLAUDE_CODE_OAUTH_TOKEN,
      }).spawn({
        agent: "claude",
        command: ["claude", "-p", DISPATCH, "--model", "claude-opus-5"],
        cwd: worktree,
        env: sandbox.env,
        tab: `argus-test-${sandbox.id}-claude`,
      });

      expect({ exitCode: result.exitCode, stderr: result.stderr?.slice(-400) })
        .toEqual({ exitCode: 0, stderr: result.stderr?.slice(-400) });

      // Located by search rather than by derivation, so a wrong slug fails the
      // NEXT assertion by name instead of failing this one as "no transcript".
      const written = await transcripts(projects);
      expect(written.length).toBeGreaterThan(0);
      expect(written.map((file) => join(file, "..")).sort()).toContain(
        claudeProjectDir(await realpath(worktree), projects),
      );

      const events = await new Tailer(
        createClaudeCodeSource({
          dir: claudeProjectDir(await realpath(worktree), projects),
        }),
      ).catchUp();
      const dispatched = events.find(
        (event): event is MessageEvent =>
          event.type === "message" && event.text.includes("ticket #43"),
      );
      expect(dispatched).toBeDefined();

      await registerDispatch(
        sandbox,
        "claude",
        dispatched!.sessionId,
        DISPATCH,
        worktree,
      );
      const records = await classify(sandbox, events);

      expect(
        records.some(
          (record) =>
            record.event.sessionId === dispatched!.sessionId &&
            record.via === "dispatch-prompt" &&
            record.author === "hermes",
        ),
      ).toBe(true);
      expect(
        records
          .filter((record) => record.author === "johan")
          .map((record) => record.event.text.slice(0, 120)),
      ).toEqual([]);
    } finally {
      await sandbox.teardown();
    }
  },
  LIVE_BUDGET_MS,
);
