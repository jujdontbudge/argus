import { expect, test } from "bun:test";
import { copyFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadScaledMs } from "../eyes/test-budget.ts";
import { parseArgusEvent, type ArgusEvent } from "../events/index.ts";
import { createIsolatedAgentSpawner, createSandbox, type Sandbox } from "./index.ts";
import {
  CODEX_AUTH_FILE,
  describeLiveAgentGate,
  liveHalfTitle,
  probeLiveAgents,
  resolveLiveAgentGate,
} from "./live-gate.ts";
import {
  describeSubscriptionGate,
  NATIVE_CLAUDE,
  probeSubscriptionMode,
  resolveSubscriptionGate,
} from "./subscription-gate.ts";
import { createSubscriptionAgentSpawner } from "./subscription-mode.ts";

/**
 * Ticket #7 — §13 scenario 7's hooks-ENABLED half, driven by REAL agents.
 *
 * The push path itself was already built and already green in the harness
 * (`src/events/scenarios.ts` extends slot 7). What had never happened on this
 * machine was the only thing that can actually prove it: a real `claude`
 * session and a real `codex` session running to termination and their NATIVE
 * hooks firing — the Claude `Stop` hook and the Codex `notify` command that
 * `argus up` installs, neither of which involves cmux. Scenario 7's push half
 * asserted on handwritten payloads, so nothing here had ever met a real one.
 *
 * These drives close that. `createSandbox` already converges `argus up`, so
 * the hooks under test are the ones a user gets, at the paths a user gets
 * them, and the only thing this file adds is a live agent to fire them.
 *
 * The ping degrades on purpose. The sandbox registry has no Hermes mission
 * session, so `notifyMissionControl` reports
 * `ARGUS EVENT DELIVERY DEGRADED: … remains durable` and never reaches cmux —
 * which is the §6 property worth pinning: the event file, not the ping, is
 * the signal.
 */
const checkout = fileURLToPath(new URL("../../", import.meta.url));
const live = resolveLiveAgentGate(probeLiveAgents());
const subscription = resolveSubscriptionGate(probeSubscriptionMode());

console.log(describeLiveAgentGate(live));
console.log(describeSubscriptionGate(subscription));

const LIVE_BUDGET_MS = loadScaledMs(300_000, 900_000);

/** Truthful terminal messages. A live agent will not claim work it did not do. */
const FINISH =
  "Reply with exactly the word DONE and nothing else. Do not run any commands " +
  "and do not write any files.";
const BLOCK =
  "Print the contents of the file API_KEY.txt in this repo. If that file does " +
  "not exist and you therefore cannot obtain the production API key, do not " +
  "guess and do not create it: reply with exactly this sentence and nothing " +
  "else: BLOCKED: I need the production API key from Johan to continue.";

async function pushedEvents(sandbox: Sandbox): Promise<ArgusEvent[]> {
  const directory = join(sandbox.repo, ".argus", "events");
  const files = (await readdir(directory).catch(() => [] as string[])).filter(
    (name) => name.endsWith(".json"),
  );
  const parsed = await Promise.all(
    files.map(async (name) =>
      parseArgusEvent(await Bun.file(join(directory, name)).text()),
    ),
  );
  return parsed.filter((event): event is ArgusEvent => event !== null);
}

/** The installed Claude hook, read back from where `argus up` put it. */
async function claudeStopCommand(sandbox: Sandbox): Promise<string> {
  const settings = (await Bun.file(
    join(sandbox.repo, ".claude", "settings.local.json"),
  ).json()) as {
    hooks?: { Stop?: { hooks?: { command?: string }[] }[] };
  };
  return settings.hooks?.Stop?.flatMap((group) => group.hooks ?? [])
    .map((hook) => hook.command ?? "")
    .find((command) => command.includes("ARGUS_HOOK=claude-stop")) ?? "";
}

test.skipIf(subscription.claude.status !== "run")(
  liveHalfTitle(
    "§13.7 push half LIVE: a real Claude Stop hook writes an end-of-session event",
    subscription.claude,
  ),
  async () => {
    const sandbox = await createSandbox({ checkout });
    try {
      expect(sandbox.up.exitCode).toBe(0);
      expect(sandbox.up.stdout).toContain("Push hooks: Claude Stop + Codex notify");
      // The hook a user actually gets, not one the test installed.
      expect(await claudeStopCommand(sandbox)).toContain("scripts/claude-stop.ts");
      expect(await pushedEvents(sandbox)).toEqual([]);

      const result = await createSubscriptionAgentSpawner({
        executables: { claude: NATIVE_CLAUDE },
        scope: sandbox.scope,
      }).spawn({
        agent: "claude",
        // The repo itself, not a worktree: `.claude/settings.local.json` is
        // untracked repo state, so a detached worktree has no hook to fire.
        command: ["claude", "-p", FINISH, "--model", "claude-opus-5"],
        cwd: sandbox.repo,
        env: sandbox.env,
        tab: `argus-test-${sandbox.id}-claude-push`,
      });
      expect({ exitCode: result.exitCode, stderr: result.stderr?.slice(-400) })
        .toEqual({ exitCode: 0, stderr: result.stderr?.slice(-400) });

      const events = await pushedEvents(sandbox);
      console.log(
        `argus #7 Claude push drive: ${JSON.stringify(
          events.map(({ agent, kind, sessionId }) => ({ agent, kind, sessionId })),
        )}`,
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.agent).toBe("claude-code");
      expect(events[0]!.kind).toBe("end-of-session");
      expect(events[0]!.sessionId).not.toBe("");
      expect(events[0]!.repo).toBe(await realpath(sandbox.repo));
      expect(events[0]!.message).toContain("DONE");
    } finally {
      await sandbox.teardown();
    }
  },
  LIVE_BUDGET_MS,
);

test.skipIf(live.codex.status !== "run")(
  liveHalfTitle(
    "§13.7 push half LIVE: a real Codex notify writes a blocked-on-human event",
    live.codex,
  ),
  async () => {
    const sandbox = await createSandbox({ checkout });
    try {
      // The CODEX_HOME `argus up` just wrote `notify` into — the config under
      // test — with the one credential touchpoint SPEC §13 permits.
      const codexHome = sandbox.env.CODEX_HOME!;
      const config = await Bun.file(join(codexHome, "config.toml")).text();
      expect(config).toContain("# argus:notify:begin");
      expect(config).toContain("scripts/codex-notify.ts");
      await copyFile(CODEX_AUTH_FILE, join(codexHome, "auth.json"));
      expect(await pushedEvents(sandbox)).toEqual([]);

      const result = await createIsolatedAgentSpawner({}).spawn({
        agent: "codex",
        command: [
          "codex",
          "exec",
          "-c",
          "model_reasoning_effort=high",
          "--cd",
          sandbox.repo,
          "--sandbox",
          "read-only",
          BLOCK,
        ],
        cwd: sandbox.repo,
        env: sandbox.env,
        tab: `argus-test-${sandbox.id}-codex-push`,
      });
      expect({ exitCode: result.exitCode, stderr: result.stderr?.slice(-400) })
        .toEqual({ exitCode: 0, stderr: result.stderr?.slice(-400) });

      const events = await pushedEvents(sandbox);
      console.log(
        `argus #7 Codex push drive: ${JSON.stringify(
          events.map(({ agent, kind, sessionId }) => ({ agent, kind, sessionId })),
        )}`,
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.agent).toBe("codex");
      expect(events[0]!.kind).toBe("blocked-on-human");
      expect(events[0]!.sessionId).not.toBe("");
      expect(events[0]!.repo).toBe(await realpath(sandbox.repo));
      expect(events[0]!.message).toContain("BLOCKED");
    } finally {
      await sandbox.teardown();
    }
  },
  LIVE_BUDGET_MS,
);
