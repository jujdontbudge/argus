/**
 * The production spawner for deployed workers (#55).
 *
 * Two things it exists to guarantee, both of them SPEC lines rather than
 * conveniences:
 *
 * 1. **SPEC §1 item 7 — Argus never requires Anthropic API access.** Every
 *    worker runs in subscription mode, so the API-key variables are stripped
 *    from the child environment rather than merely left unset by the parent.
 *    `src/harness/subscription-mode.ts` strips the same names for the same
 *    reason on the test path; this is the production twin of that list.
 * 2. **The announcement channel.** A route whose CLI names its own session
 *    (codex) prints that name on stdout, and the deployment row cannot be
 *    written until it arrives. So stdout is scanned line by line as it
 *    streams, not read at exit — waiting for exit would mean registering a
 *    deployment after the whole session had already happened.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { DeployAgent } from "./routes.ts";

export interface WorkerExit {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export interface WorkerSpawnRequest {
  agent: DeployAgent;
  /** argv, already routed. `command[0]` is replaced by `executable`. */
  command: readonly string[];
  cwd: string;
  env: Record<string, string>;
  executable: string;
  /** Optional durable mirror of worker output and its terminal exit status. */
  logFile?: string;
  /** Route hook: returns the session id when a stdout line announces one. */
  announce?: (line: string) => string | null;
}

export interface WorkerProcess {
  /**
   * The id the CLI announced, or null when the process ended without one.
   * Resolves as soon as the announcing line is seen — never at exit.
   */
  announcedSessionId(): Promise<string | null>;
  exited: Promise<WorkerExit>;
  /** Only ever called on a process this primitive spawned (safety rule). */
  kill(): void;
  pid?: number;
}

export type WorkerSpawn = (request: WorkerSpawnRequest) => Promise<WorkerProcess>;

/**
 * SPEC §1 item 7: subscription mode only. `ANTHROPIC_API_KEY` and
 * `ANTHROPIC_AUTH_TOKEN` would silently route a worker through an API Johan's
 * plan does not include; `CLAUDE_CODE_OAUTH_TOKEN` is the credential #49
 * established this machine can never mint and must never need.
 */
export const STRIPPED_ENV = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
] as const;

export function subscriptionEnv(
  base: Readonly<Record<string, string | undefined>>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    if (value !== undefined) env[name] = value;
  }
  for (const name of STRIPPED_ENV) delete env[name];
  return env;
}

/** Split a growing buffer into whole lines; the remainder stays buffered. */
function drainLines(buffer: string): { lines: string[]; rest: string } {
  const parts = buffer.split("\n");
  const rest = parts.pop() ?? "";
  return { lines: parts, rest };
}

export const spawnWorker: WorkerSpawn = async (request) => {
  let logWrites = Promise.resolve();
  const mirror = (text: string): Promise<void> => {
    if (request.logFile === undefined || text === "") return Promise.resolve();
    logWrites = logWrites.then(() => appendFile(request.logFile!, text, "utf8"));
    return logWrites;
  };
  if (request.logFile !== undefined) {
    await mkdir(dirname(request.logFile), { recursive: true });
    await mirror(
      `[argus] starting ${request.agent} worker in ${request.cwd}\n` +
        `[argus] executable: ${request.executable}\n`,
    );
  }

  const child = Bun.spawn([request.executable, ...request.command.slice(1)], {
    cwd: request.cwd,
    env: request.env,
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });

  let announceResolve: (id: string | null) => void = () => {};
  const announced = new Promise<string | null>((resolve) => {
    announceResolve = resolve;
  });
  const announce = request.announce;
  if (announce === undefined) announceResolve(null);

  const collect = async (
    stream: ReadableStream<Uint8Array>,
    scan: boolean,
  ): Promise<string> => {
    const decoder = new TextDecoder();
    let text = "";
    let buffer = "";
    for await (const chunk of stream) {
      const decoded = decoder.decode(chunk, { stream: true });
      text += decoded;
      await mirror(decoded);
      if (!scan || announce === undefined) continue;
      buffer += decoded;
      const { lines, rest } = drainLines(buffer);
      buffer = rest;
      for (const line of lines) {
        const id = announce(line);
        if (id !== null) announceResolve(id);
      }
    }
    return text;
  };

  const exited = (async (): Promise<WorkerExit> => {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      collect(child.stdout as ReadableStream<Uint8Array>, true),
      collect(child.stderr as ReadableStream<Uint8Array>, false),
    ]);
    // A process that ended without announcing never will: unblock the waiter
    // with the honest answer rather than hanging the dispatcher forever.
    announceResolve(null);
    await mirror(`[argus] worker exited with code ${exitCode}\n`);
    await logWrites;
    return { exitCode, stderr, stdout };
  })();

  return {
    announcedSessionId: () => announced,
    exited,
    kill: () => child.kill(),
    pid: child.pid,
  };
};
