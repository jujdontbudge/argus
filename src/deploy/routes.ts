/**
 * Agent routing (SPEC §7.3.2: "fresh session ... dispatch to the routed
 * agent"), and the one thing that genuinely differs between the two agents
 * Argus deploys: WHO CHOOSES THE SESSION ID.
 *
 * SPEC §5 rule 1 is an ordering requirement — the deployment is recorded
 * before the session starts — and the registry keys a deployment by the
 * session id the transcript will carry. So the ordering Argus can promise is
 * bounded by whether the CLI lets Argus name the session:
 *
 * - **claude 2.1.246 does.** `claude --session-id <uuid>` fixes the id of the
 *   session it is about to open, so Argus picks the id, fsyncs the row, and
 *   only then starts the process. Strict rule 1, and provable from outside.
 *
 * - **codex-cli 0.149.1 does not.** It mints its own UUIDv7 at session
 *   creation and has no flag to preassign one. Measured on this machine
 *   rather than assumed (a scratch `CODEX_HOME`, no auth, so the run cost
 *   nothing and got a 401 before any model call):
 *     - `codex exec --json <prompt>` prints
 *       `{"type":"thread.started","thread_id":"01a03c64-…"}` on stdout as its
 *       FIRST line, before `turn.started`;
 *     - the rollout file's user-message record (`ordinal: 8`) was written
 *       ~1.2s AFTER that announcement;
 *     - `codex exec --json -` (prompt on stdin) reads stdin to EOF before it
 *       creates a session at all — it printed `No prompt provided via stdin`
 *       while a writer still held the pipe open — so a session id cannot be
 *       obtained before handing over the prompt.
 *   The announcement is therefore the earliest identity that exists, and the
 *   primitive registers on it: spawn, wait for `thread.started`, fsync the
 *   row, and only then let the deployment be observed by anything. That is
 *   strictly weaker than the preassigned route and it is labelled so — the
 *   window is the CLI's, not Argus's, and it is a ~1s head start on a
 *   transcript nothing reads until an eye tails it. A route that never
 *   announces is a failure, never a guess: see `deployWorker`.
 */
export type DeployAgent = "claude" | "codex";

export type SessionIdMode =
  /** Argus names the session; the row is durable before the process starts. */
  | "preassigned"
  /** The CLI names the session and says so; the row follows the announcement. */
  | "announced";

export interface RouteCommandInput {
  dispatchPrompt: string;
  extraArgs?: readonly string[];
  model?: string;
  /** The id Argus preassigned, for `preassigned` routes only. */
  sessionId?: string;
}

export interface AgentRoute {
  agent: DeployAgent;
  /** Executable name, overridable so a caller can bypass a shell wrapper. */
  executable: string;
  sessionIdMode: SessionIdMode;
  command(input: RouteCommandInput): string[];
  /** For `announced` routes: pull the session id out of one stdout line. */
  announce?(line: string): string | null;
}

/**
 * Headless by default, and deliberately so. SPEC §3 puts workers in cmux
 * workspaces, but cmux on this machine is 0.62.2 forever and a workspace is
 * optional context (#7) — so the dispatch itself must not need one. A headless
 * `claude -p` dispatch is also the shape #50 proved classifies correctly:
 * `promptSource: "sdk"` is a candidate, and the prompt lands
 * `hermes`/`dispatch-prompt`. An interactive-in-cmux variant is the §7.2 grill
 * flow's business (#56 / the grill ticket), and it composes by passing
 * `extraArgs` plus a resolved workspace.
 */
export const CLAUDE_ROUTE: AgentRoute = {
  agent: "claude",
  command: ({ dispatchPrompt, extraArgs = [], model, sessionId }) => [
    "claude",
    "--session-id",
    sessionId ?? "",
    "--model",
    model ?? "claude-opus-5",
    // Johan's standing directive for a DEPLOYED claude worker: Opus, max
    // effort. Named here rather than left to the CLI default because the
    // default follows whatever the human last set interactively, and an AFK
    // worker has no human to notice it running shallow. This is the deploy
    // route only — the watcher brains (`src/eyes/config.ts`) stay on
    // luna at low effort, which #54 settled and #88 does not touch.
    "--effort",
    "max",
    ...extraArgs,
    "-p",
    dispatchPrompt,
  ],
  executable: "claude",
  sessionIdMode: "preassigned",
};

const THREAD_STARTED = /"type"\s*:\s*"thread\.started"/;

/**
 * #104 finding 1: the sandbox posture a deployed Codex worker gets, SET BY
 * ARGUS rather than inherited from whatever `$CODEX_HOME/config.toml` happens
 * to say.
 *
 * The bug this closes was invisible here by construction. `codex exec` defaults
 * to a READ-ONLY sandbox, and Argus passed nothing — so a deployed worker could
 * read the worktree and not write it. Johan's personal config says
 * `sandbox_mode = "danger-full-access"`, so every drive run under his ambient
 * config appeared to work while an adopted repo on a clean machine — the actual
 * target of `argus init`/`argus up` — got silent `blocked-on-human` events and
 * zero lines of code (#82 finding 1, re-measured unfixed by #99).
 *
 * Reproduced against codex-cli 0.149.1 with a scratch `CODEX_HOME` carrying
 * model + effort and deliberately no `sandbox_mode`. The exact argv this route
 * built before this change left the file untouched, `xxd` of it having
 * succeeded — the worker could read and not write:
 *
 *     ERROR codex_core::tools::router: error=patch rejected: writing is
 *     blocked by read-only sandbox; rejected by user approval settings
 *   agent_message: "Unable to overwrite `target.txt`: the workspace is
 *     read-only, and write access cannot be requested in this session."
 *
 * The same prompt under the same scratch home with the posture below wrote the
 * file. WHAT IS GRANTED, and the reason each stops at where it does:
 *
 * - `sandbox_mode=workspace-write` — the worker's whole job is to edit the
 *   worktree it was given and commit to that branch, so it gets write access to
 *   that worktree and nothing wider. Not `danger-full-access`: that is Johan's
 *   personal setting for an attended session, and an unattended worker holding
 *   it can write anywhere on the machine.
 * - `sandbox_workspace_write.network_access=false` — pinned off, not left to
 *   the default. `defaultDispatchPrompt` tells the worker "do not merge, do not
 *   push, and do not close the ticket — the dispatcher owns ticket state", so a
 *   worker has no legitimate remote call to make. Dependencies are not a
 *   counter-example: `installWorktreeDependencies` runs `bun install
 *   --frozen-lockfile` in the worktree BEFORE the worker spawns, so the graph
 *   is already materialised by Argus outside the worker's sandbox.
 * - `approval_policy=never` — no human is attached to a `codex exec` dispatch.
 *   An escalation prompt in a headless session is a hang, not a safeguard, and
 *   inheriting an `on-request` policy from a machine config would produce one.
 *   Escalations fail the command instead, which an eye can see.
 *
 * Set as `-c` overrides so they beat the config file: the failure mode being
 * fixed is precisely a machine whose config disagrees with what Argus needs.
 *
 * TWO things hide this on a developed machine, not one, and the second was
 * found while re-verifying (#104 second pass). The first is the obvious one:
 * `sandbox_mode = "danger-full-access"` in `~/.codex/config.toml`. The second
 * is per-project trust — `codex` records `[projects."<path>"] trust_level =
 * "trusted"` in config.toml for a directory it has been trusted in once, and a
 * trusted project silently starts `codex exec` at `workspace-write` even with
 * no `sandbox_mode` anywhere. Measured: identical pre-fix argv, same scratch
 * home, same prompt — untrusted project `read-only` and the write rejected;
 * with only that `trust_level` stanza added, `workspace-write` and the write
 * succeeded. So a repo Argus has been driven in by hand looks fine and a
 * freshly adopted one does not, which is the same trap one layer down. Pinning
 * the posture in argv is what makes the two machines behave alike.
 *
 * Argus already knew to do this on the READ side and had simply never done it
 * on the WRITE side: `createCodexBrain` (src/eyes/brain.ts) passes
 * `--ignore-user-config` and `-s read-only`, pinning a watcher brain to
 * read-only no matter what the machine says. The deployed worker — the one
 * process here whose entire purpose is to write — was the one inheriting.
 *
 * What this deliberately does NOT copy from the brain is `--ignore-user-config`.
 * `argus up` installs the `# argus:notify` hook into `$CODEX_HOME/config.toml`
 * (#103 owns how that block is delimited), and that hook is how a worker's
 * end-of-session and blocked-on-human events reach Argus at all. Ignoring the
 * user config would take the posture and throw away the push path with it, so
 * the config is read and the three keys that matter are overridden on top.
 */
export const CODEX_SANDBOX_POSTURE: readonly string[] = [
  "-c",
  "sandbox_mode=workspace-write",
  "-c",
  "sandbox_workspace_write.network_access=false",
  "-c",
  "approval_policy=never",
] as const;

export const CODEX_ROUTE: AgentRoute = {
  agent: "codex",
  announce: (line) => {
    if (!THREAD_STARTED.test(line)) return null;
    try {
      const parsed = JSON.parse(line) as { thread_id?: unknown; type?: unknown };
      if (parsed.type !== "thread.started") return null;
      return typeof parsed.thread_id === "string" && parsed.thread_id !== ""
        ? parsed.thread_id
        : null;
    } catch {
      return null;
    }
  },
  command: ({ dispatchPrompt, extraArgs = [], model }) => [
    "codex",
    "exec",
    "--json",
    // SPEC §2: "Codex | ChatGPT subscription, `gpt-5.6-sol`, high reasoning
    // effort." Before #88 nothing was routed here, so the effort was never
    // spent one way or the other; codex is now the default implementer and
    // the SPEC's stated effort has to be on the command line.
    "-c",
    "model_reasoning_effort=high",
    // #104: the posture is Argus's, not the machine's. See CODEX_SANDBOX_POSTURE.
    ...CODEX_SANDBOX_POSTURE,
    ...(model === undefined ? [] : ["-m", model]),
    ...extraArgs,
    dispatchPrompt,
  ],
  executable: "codex",
  sessionIdMode: "announced",
};

export const ROUTES: Readonly<Record<DeployAgent, AgentRoute>> = {
  claude: CLAUDE_ROUTE,
  codex: CODEX_ROUTE,
};
