/**
 * Ticket #49 — subscription mode: a real terminal Claude session, no token.
 *
 * SPEC §13's original isolation directive was REPO-level: the throwaway
 * sandbox repo and scratch tabs/worktrees only, never the production
 * dispatcher, live workers or real `~/argus`. #41 escalated it to PROCESS
 * level — scratch HOME plus scratch CLAUDE_CONFIG_DIR — and a scratch config
 * has no credentials by construction, so a `CLAUDE_CODE_OAUTH_TOKEN` became
 * mandatory. None was ever provisioned, so the Claude half of §13 never ran
 * and `src/tailing/claude-code.ts` never met a real Opus transcript.
 *
 * This module is the route that was always available: spawn Claude the way
 * every worker on this machine already runs — real HOME, subscription auth,
 * no token — with `cwd` pointed at the sandbox repo, so the transcript lands
 * in `~/.claude/projects/<sandbox-slug>/` under its own slug and touches no
 * other project's transcripts.
 *
 * WHY #41'S CREDENTIAL HAZARD DOES NOT APPLY. #41's risk was specific and
 * real: a COPIED `.credentials.json` inside a scratch config is a second copy
 * of a rotating credential, and refreshing it can revoke the one Johan's live
 * sessions are using. Nothing is copied here. A normal terminal session
 * refreshes on the same `~/.claude` path every one of Johan's live sessions
 * already uses, so there is no second copy and nothing to rotate out from
 * under anyone. This module never reads, copies or writes that file.
 *
 * WHAT IT COSTS. The blast radius is no longer OS-enforced: the session runs
 * under the real home and could in principle read it, it spends subscription
 * quota, and it shows up in Johan's session list. That is stated plainly in
 * SPEC §13 rather than buried. What stands in for the OS boundary is
 * `SandboxScope` — scripted scope, enforced and tested — plus a sandbox cwd
 * and a dispatch that only ever asks for benign scripted work.
 *
 * TWO MODES, NEVER BY OMISSION. This is a separate, explicitly named entry
 * point from `createIsolatedAgentSpawner`. That one refuses a HOME or
 * CLAUDE_CONFIG_DIR under the real home; this one REQUIRES the real home and
 * refuses a cwd outside the sandbox. Neither can be reached by forgetting an
 * argument, and no caller can drift from hermetic into subscription mode
 * without naming this function.
 */
import { homedir } from "node:os";

import type { AgentSpawnRequest, AgentSpawnResult, AgentSpawner } from "./index.ts";
import { SandboxScope } from "./sandbox-scope.ts";

export interface SubscriptionAgentSpawnerOptions {
  /** Override command resolution, chiefly to bypass local shell wrappers. */
  executables?: Partial<Record<"claude", string>>;
  /** The sandbox every subscription child is confined to. Not optional. */
  scope: SandboxScope;
}

/**
 * The environment variables a subscription child must NOT inherit.
 *
 * `CLAUDE_CONFIG_DIR` and `HOME` because a scratch config is the credential-
 * free state that made a token necessary; the three credential variables
 * because subscription auth is the point, and any of them would silently
 * change which provider — and whose quota — the session runs against.
 */
const STRIPPED = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CONFIG_DIR",
] as const;

export function createSubscriptionAgentSpawner(
  options: SubscriptionAgentSpawnerOptions,
): AgentSpawner {
  return {
    async spawn(request: AgentSpawnRequest): Promise<AgentSpawnResult> {
      if (request.agent !== "claude") {
        throw new Error(
          `subscription mode drives Claude only; ${request.agent} has its own isolated path`,
        );
      }
      // The safety property, first and by name. In this mode nothing else
      // keeps the session inside the sandbox — there is no OS boundary left.
      await options.scope.resolved(request.cwd, "subscription spawn cwd");

      const env: Record<string, string> = { ...request.env };
      for (const name of STRIPPED) delete env[name];
      // The real home, explicitly rather than by inheritance, so the child's
      // auth path is a decision this function made and can be asserted on.
      env.HOME = homedir();

      const executable = options.executables?.claude ?? request.command[0];
      if (executable === undefined) throw new Error("agent command is empty");
      const child = Bun.spawn([executable, ...request.command.slice(1)], {
        cwd: request.cwd,
        env,
        stderr: "pipe",
        stdin: "ignore",
        stdout: "pipe",
      });
      options.scope.adopt(child.pid);
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stderr, stdout };
    },
  };
}
