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
    ...extraArgs,
    "-p",
    dispatchPrompt,
  ],
  executable: "claude",
  sessionIdMode: "preassigned",
};

const THREAD_STARTED = /"type"\s*:\s*"thread\.started"/;

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
