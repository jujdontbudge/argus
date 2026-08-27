/**
 * The brain invocation seam (SPEC §5.1/§5.4; research #8): watcher judgment
 * comes from `codex exec` — small model, low effort, read-only, ephemeral,
 * user config ignored — with the verdict constrained by `--output-schema`
 * and parsed from `--json` JSONL stdout. Eyes talk to the `Brain` interface;
 * unit tests substitute a stub, and only the one live integration test runs
 * the real CLI.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface BrainRequest {
  prompt: string;
  /** JSON Schema constraining the final message (research: belt-and-suspenders). */
  schema: object;
  /** Repo the brain may read (`-C`); judgment context, never written to. */
  cwd: string;
  /** Daemon shutdown; aborts an in-flight child instead of waiting for its deadline. */
  signal?: AbortSignal;
  /** Per-evaluation override; defaults to the brain's attempt timeout. */
  attemptTimeoutMs?: number;
}

export interface BrainUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
}

export type BrainOutcome =
  | { ok: true; text: string; usage?: BrainUsage }
  | {
      ok: false;
      reason: "turn-failed" | "no-agent-message" | "nonzero-exit" | "spawn-error";
      detail: string;
    };

export interface Brain {
  evaluate(request: BrainRequest): Promise<BrainOutcome>;
}

export interface SpawnRequest {
  argv: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string | undefined>>;
  stdin: string;
  /** Aborts on either caller shutdown or the per-attempt deadline. */
  signal: AbortSignal;
}

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type SpawnFn = (request: SpawnRequest) => Promise<SpawnResult>;

export interface CodexBrainOptions {
  model: string;
  reasoningEffort: string;
  /** Injectable process runner; the default runs the real codex CLI. */
  spawn?: SpawnFn;
  binary?: string;
  /** Process environment; provider credentials are stripped before spawn. */
  env?: Readonly<Record<string, string | undefined>>;
  /** Maximum wall time for one `codex exec` attempt. */
  attemptTimeoutMs?: number;
}

/**
 * #8 measured ~5.3s/call and #113 measured a healthy live Retro scan at 8.1s.
 * Two minutes is ~23x / ~15x those baselines, while bounding the >2min tail
 * that exposed #114. A timeout is a retryable attempt failure, never a drop.
 */
export const DEFAULT_BRAIN_ATTEMPT_TIMEOUT_MS = 120_000;

/**
 * Parse `codex exec --json` JSONL stdout: the verdict is the last
 * `item.completed` agent_message; `turn.failed` overrides anything seen.
 * Non-JSON lines are tolerated — leaked noise must not crash an eye.
 */
export function parseCodexOutput(stdout: string): BrainOutcome {
  let text: string | null = null;
  let usage: BrainUsage | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    let event: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null) continue;
      event = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (event.type === "turn.failed") {
      return { ok: false, reason: "turn-failed", detail: JSON.stringify(event) };
    }
    if (event.type === "item.completed") {
      const item = event.item as Record<string, unknown> | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        text = item.text;
      }
    }
    if (event.type === "turn.completed") {
      const raw = event.usage as Record<string, unknown> | undefined;
      usage = {
        ...(typeof raw?.input_tokens === "number" && {
          inputTokens: raw.input_tokens,
        }),
        ...(typeof raw?.cached_input_tokens === "number" && {
          cachedInputTokens: raw.cached_input_tokens,
        }),
        ...(typeof raw?.output_tokens === "number" && {
          outputTokens: raw.output_tokens,
        }),
      };
    }
  }
  if (text === null) {
    return { ok: false, reason: "no-agent-message", detail: stdout.slice(0, 2_000) };
  }
  return { ok: true, text, ...(usage !== undefined && { usage }) };
}

const defaultSpawn: SpawnFn = async (request) => {
  const child = Bun.spawn([...request.argv], {
    cwd: request.cwd,
    env: request.env,
    stdin: new TextEncoder().encode(request.stdin),
    stderr: "pipe",
    stdout: "pipe",
  });
  // A deadline must be a hard cap: SIGKILL also covers a wedged child that
  // cannot service SIGTERM, so the timeout cannot trade a stuck promise for
  // an orphaned `codex exec`.
  const kill = () => {
    if (child.exitCode === null) child.kill("SIGKILL");
  };
  if (request.signal.aborted) kill();
  else request.signal.addEventListener("abort", kill, { once: true });
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    request.signal.removeEventListener("abort", kill);
  }
};

function attemptFailure(
  timeoutSignal: AbortSignal,
  attemptTimeoutMs: number,
): Error {
  if (timeoutSignal.aborted) {
    return new Error(`brain attempt timed out after ${attemptTimeoutMs}ms`);
  }
  const error = new Error("brain attempt aborted by caller");
  error.name = "AbortError";
  return error;
}

async function waitForSpawn(
  spawned: Promise<SpawnResult>,
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
  attemptTimeoutMs: number,
): Promise<SpawnResult> {
  if (signal.aborted) throw attemptFailure(timeoutSignal, attemptTimeoutMs);
  return await new Promise<SpawnResult>((resolve, reject) => {
    const onAbort = () => reject(attemptFailure(timeoutSignal, attemptTimeoutMs));
    signal.addEventListener("abort", onAbort, { once: true });
    void spawned.then(
      (result) => {
        signal.removeEventListener("abort", onAbort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/** The researched lean invocation (docs/research/watcher-brains-codex-exec.md). */
export function createCodexBrain(options: CodexBrainOptions): Brain {
  const spawn = options.spawn ?? defaultSpawn;
  const binary = options.binary ?? "codex";
  const env = { ...(options.env ?? process.env) };
  // SPEC §1 items 7 and 8: watcher inference spends the ChatGPT
  // subscription through `codex exec`. An inherited provider credential must
  // never silently turn the exact same command into metered API access.
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return {
    async evaluate(request) {
      const attemptTimeoutMs =
        request.attemptTimeoutMs ??
        options.attemptTimeoutMs ??
        DEFAULT_BRAIN_ATTEMPT_TIMEOUT_MS;
      const timeoutSignal = AbortSignal.timeout(attemptTimeoutMs);
      const signal =
        request.signal === undefined
          ? timeoutSignal
          : AbortSignal.any([request.signal, timeoutSignal]);
      const schemaDirectory = await mkdtemp(join(tmpdir(), "argus-brain-"));
      const schemaFile = join(schemaDirectory, "output-schema.json");
      try {
        await Bun.write(schemaFile, JSON.stringify(request.schema));
        let result: SpawnResult;
        try {
          result = await waitForSpawn(
            spawn({
              argv: [
                binary,
                "exec",
                "--ignore-user-config",
                "-m",
                options.model,
                "-c",
                `model_reasoning_effort=${options.reasoningEffort}`,
                "-s",
                "read-only",
                "--ephemeral",
                "-C",
                request.cwd,
                "--skip-git-repo-check",
                "-c",
                "project_doc_max_bytes=0",
                "--output-schema",
                schemaFile,
                "--json",
                "-",
              ],
              cwd: request.cwd,
              env,
              stdin: request.prompt,
              signal,
            }),
            signal,
            timeoutSignal,
            attemptTimeoutMs,
          );
        } catch (error) {
          return {
            ok: false,
            reason: "spawn-error",
            detail: error instanceof Error ? error.message : String(error),
          };
        }
        if (result.exitCode !== 0) {
          return {
            ok: false,
            reason: "nonzero-exit",
            detail: `exit ${result.exitCode}: ${result.stderr.slice(0, 2_000)}`,
          };
        }
        return parseCodexOutput(result.stdout);
      } finally {
        await rm(schemaDirectory, { force: true, recursive: true });
      }
    },
  };
}
