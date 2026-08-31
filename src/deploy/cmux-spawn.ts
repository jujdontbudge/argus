/**
 * Launch a deployed worker in the cmux surface Argus opened for it (#122).
 *
 * Unlike `spawnWorker`, this process is owned by the surface's shell rather
 * than by the dispatcher. Output is tee'd to a durable file: that gives Johan
 * a live terminal, while Argus can still observe Codex's `thread.started` line
 * and the real exit status without guessing from an empty tab.
 */
import { mkdir, open, readFile, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { findWorkspace, readCmuxInventory, runCmux, type CmuxRun } from "../events";
import { decodedShellWord } from "./cmux-command.ts";
import { STRIPPED_ENV, type WorkerExit, type WorkerProcess, type WorkerSpawn } from "./spawn.ts";

export interface CmuxWorkerSpawnOptions {
  cmux?: CmuxRun;
  /** Deterministic only in tests; random in production. */
  exitToken?: string;
  /** Fresh short ref revalidated by createCmuxSend immediately before input. */
  inputSurface: string;
  /** Fresh cmux terminals can take seconds before their login shell executes input. */
  readinessTimeoutMs?: number;
  /** Bounded PID handshake; configurable only to keep failure tests fast. */
  startupTimeoutMs?: number;
  /** Let cmux register a fresh terminal before the shell-readiness probe. */
  settleDelayMs?: number;
  /** Durable UUID used for identity, logs, and teardown. */
  surface: string;
  workspace: string;
}

function workerCommand(
  request: Parameters<WorkerSpawn>[0],
  exitToken: string,
): string {
  if (request.logFile === undefined) {
    throw new Error("a cmux worker requires a durable log file");
  }
  const unset = STRIPPED_ENV.flatMap((name) => ["-u", name]);
  const command = ["env", ...unset, request.executable, ...request.command.slice(1)]
    .map(decodedShellWord)
    .join(" ");
  const pidMarker = `[argus-pid:${exitToken}]`;
  const marker = `[argus-exit:${exitToken}]`;
  const body = [
    `print -r -- ${decodedShellWord(pidMarker)} "$$" >> ${decodedShellWord(request.logFile)}`,
    `cd ${decodedShellWord(request.cwd)} || exit $?`,
    "setopt pipefail",
    `${command} 2>&1 | tee -a ${decodedShellWord(request.logFile)}`,
    "worker_status=${pipestatus[1]}",
    `print -r -- "" | tee -a ${decodedShellWord(request.logFile)}`,
    `print -r -- ${decodedShellWord(marker)} "$worker_status" | tee -a ${decodedShellWord(request.logFile)}`,
    'exit "$worker_status"',
  ].join("; ");
  return `${body}\n`;
}

async function text(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function waitFor<T>(
  read: () => Promise<T | undefined>,
  timeout?: { description: string; ms: number },
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (value !== undefined) return value;
    if (timeout !== undefined && Date.now() - started >= timeout.ms) {
      throw new Error(`timed out waiting for ${timeout.description} after ${timeout.ms}ms`);
    }
    await Bun.sleep(50);
  }
}

export function createCmuxWorkerSpawn(options: CmuxWorkerSpawnOptions): WorkerSpawn {
  const cmux = options.cmux ?? runCmux;
  return async (request): Promise<WorkerProcess> => {
    if (request.logFile === undefined) {
      throw new Error("a cmux worker requires a durable log file");
    }
    const exitToken = options.exitToken ?? crypto.randomUUID();
    const marker = `[argus-exit:${exitToken}]`;
    await mkdir(dirname(request.logFile), { recursive: true });
    const file = await open(request.logFile, "wx", 0o600);
    await file.writeFile(
      `[argus] starting ${request.agent} worker in cmux surface ${options.surface}\n` +
        `[argus] executable: ${request.executable}\n`,
      "utf8",
    );
    await file.sync();
    await file.close();

    const launchFile = `${request.logFile}.launch-${exitToken}.zsh`;
    const launchHandle = await open(launchFile, "wx", 0o600);
    try {
      await launchHandle.writeFile(workerCommand(request, exitToken), "utf8");
      await launchHandle.sync();
    } finally {
      await launchHandle.close();
    }

    const pidMarker = `[argus-pid:${exitToken}]`;
    const pidLine = new RegExp(
      `^${pidMarker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (\\d+)$`,
      "m",
    );
    const exitLine = new RegExp(`^${marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (-?\\d+)$`, "m");
    const readinessDirectory = `${launchFile}.ready`;
    const pid = await (async () => {
      try {
        await Bun.sleep(options.settleDelayMs ?? 1_000);
        const readiness = await cmux([
          "send",
          "--surface",
          options.inputSurface,
          "--",
          ` /bin/mkdir ${decodedShellWord(readinessDirectory)}\n`,
        ]);
        if (readiness.exitCode !== 0) {
          throw new Error(
            readiness.stderr.trim() || `cmux would not probe shell readiness in ${options.surface}`,
          );
        }
        await waitFor(
          async () => ((await directoryExists(readinessDirectory)) ? true : undefined),
          {
            description: `cmux shell in surface ${options.surface} readiness`,
            ms: options.readinessTimeoutMs ?? 15_000,
          },
        );
        const inventory = await readCmuxInventory(cmux);
        const workspace = inventory === null ? undefined : findWorkspace(inventory, options.workspace);
        const surface = workspace?.surfaces.find(({ ref }) => ref === options.inputSurface);
        if (surface?.id !== options.surface) {
          throw new Error(
            `cmux surface identity changed before launch: ${options.inputSurface} no longer maps to ${options.surface}`,
          );
        }
        const launched = await cmux([
          "send",
          "--surface",
          options.inputSurface,
          "--",
          `/bin/zsh ${decodedShellWord(launchFile)}\n`,
        ]);
        if (launched.exitCode !== 0) {
          throw new Error(
            launched.stderr.trim() || `cmux would not launch the worker in ${options.surface}`,
          );
        }
        return await waitFor<number>(
          async () => {
            const output = await text(request.logFile!);
            const match = output.match(pidLine);
            if (match === null) return undefined;
            const parsed = Number(match[1]);
            return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
          },
          {
            description: `cmux worker pid in ${request.logFile}`,
            ms: options.startupTimeoutMs ?? 5_000,
          },
        );
      } finally {
        await rm(launchFile, { force: true });
        await rm(readinessDirectory, { force: true, recursive: true });
      }
    })();
    const exited = waitFor<WorkerExit>(async () => {
      const output = await text(request.logFile!);
      const match = output.match(exitLine);
      if (match === null) return undefined;
      return { exitCode: Number(match[1]), stderr: "", stdout: output };
    });
    const announced = waitFor<string | null>(async () => {
      const output = await text(request.logFile!);
      for (const line of output.split("\n")) {
        const id = request.announce?.(line) ?? null;
        if (id !== null) return id;
      }
      return exitLine.test(output) ? null : undefined;
    });

    return {
      announcedSessionId: () => announced,
      exited,
      kill: () => {
        // The surface UUID came from `openWorkerTab`'s resolved inventory. The
        // central cmux argument guard refuses non-UUID state-changing targets.
        void cmux(["send-key", "--surface", options.surface, "--", "ctrl+c"]);
      },
      pid,
    };
  };
}
