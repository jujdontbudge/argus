/**
 * Ticket #47 — provisioning and driving a Hermes profile of our own.
 *
 * This is the method #23's worker ran by hand, and the reason its evidence did
 * not survive: it lived in one worktree and died with it. Everything here is
 * the same sequence, written down.
 *
 *   1. a harness sandbox — scratch HOME, scratch HERMES_HOME, throwaway repo
 *   2. `argus up`'s OWN profile binding, against that scratch root, so what
 *      gets driven is the directory Argus really creates and not one invented
 *      for the test
 *   3. a provider declared on a dead loopback port, which is what lets a
 *      credential-free drive get past Hermes's "no inference provider
 *      configured" refusal and persist a turn (research §7)
 *   4. one real `hermes chat -q`, with an environment stripped of anything it
 *      could authenticate with
 *
 * Kept apart from `hermes-live-gate.ts` on purpose: that module is pure so its
 * every state is testable, and this one spawns a real CLI.
 */
import { constants, Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  convergeAgentBindings,
  type HonchoClient,
  type HonchoPeerInput,
  type HonchoWorkspaceInput,
} from "../up/bindings.ts";
import { createSandbox, type Sandbox } from "./index.ts";
import {
  hermesDriveEnv,
  offlineProviderConfig,
  OFFLINE_PROVIDER,
} from "./hermes-live-gate.ts";

/** The prompt the drive sends. Its text is what the tail is checked against. */
export const DRIVE_PROMPT =
  "Ticket #47 scratch drive. Reply with exactly the word ACKNOWLEDGED.";

/**
 * Local convergence has to complete for the profile to exist, and Honcho is
 * not what this ticket verifies — so the seam gets a double rather than a
 * network call. #28 already covers the real client.
 */
const NO_HONCHO: HonchoClient = {
  ensurePeer: async (_workspace: string, _input: HonchoPeerInput) => "created",
  ensureWorkspace: async (_input: HonchoWorkspaceInput) => "created",
};

export interface ScratchDrive {
  /** `hermes --version`'s first line, or null if it could not be read. */
  cli: string | null;
  exitCode: number;
  /** The root a `TranscriptSource` is pointed at: `<scratch>/profiles/…`. */
  hermesRoot: string;
  /** The profile directory, which is also the drive's `HERMES_HOME`. */
  profile: string;
  /** null when a `state.db` was provisioned; otherwise why it was not. */
  provisioningFailure: string | null;
  /** `state.db`'s `schema_version`, or null if there is no `state.db`. */
  schemaVersion: number | null;
  stateDb: string;
  /** Everything the CLI said, trimmed. Quoted into the skip when it fails. */
  transcript: string;
  teardown(): Promise<void>;
}

/** Read one integer out of a `state.db` without ever opening it for writing. */
function schemaVersionOf(stateDb: string): number | null {
  let db: Database | undefined;
  try {
    db = new Database(
      `${pathToFileURL(stateDb).href}?mode=ro&immutable=0`,
      constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
    );
    const row = db
      .query<{ version: number }, []>("SELECT version FROM schema_version")
      .get();
    return row?.version ?? null;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

async function hermesVersion(env: Record<string, string>): Promise<string | null> {
  try {
    const child = Bun.spawn(["hermes", "--version"], {
      env,
      stderr: "pipe",
      stdout: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    if (exitCode !== 0) return null;
    return stdout.split("\n")[0]?.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Run a child, and kill it rather than let it hang the suite.
 *
 * The budget here is a hang detector, not a performance assertion — a drive
 * that is killed reports as "provisioned nothing", which is a loud skip naming
 * the timeout, not a silent one.
 */
async function runBounded(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  budgetMs: number,
): Promise<{ exitCode: number; output: string }> {
  const child = Bun.spawn(command, { cwd, env, stderr: "pipe", stdout: "pipe" });
  const killer = setTimeout(() => child.kill(), budgetMs);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, output: `${stdout}\n${stderr}`.trim() };
  } finally {
    clearTimeout(killer);
  }
}

export interface ScratchDriveOptions {
  /** This checkout, which the sandbox clones its scaffolding from. */
  checkout: string;
  driveBudgetMs: number;
}

/**
 * Provision a Hermes profile under a scratch `HERMES_HOME` and drive it once.
 *
 * Never touches the real `~/.hermes`: `HERMES_HOME` is the scratch profile and
 * `HOME` is the sandbox's, so the global root Hermes also consults is scratch
 * too. The only thing read out of the real home is Hermes's own installed
 * code, which is what "the INSTALLED Hermes" means.
 */
export async function driveScratchProfile(
  options: ScratchDriveOptions,
): Promise<ScratchDrive> {
  let sandbox: Sandbox | undefined;
  const teardown = async () => {
    await sandbox?.teardown();
  };
  try {
    sandbox = await createSandbox({ checkout: options.checkout });
    const hermesRoot = sandbox.env.HERMES_HOME!;
    const report = await convergeAgentBindings({
      hermesRoot,
      honcho: NO_HONCHO,
      honchoUrl: "http://127.0.0.1:1",
      repo: sandbox.repo,
    });
    // `argus up` reports the profile by NAME; the path it lives at is the
    // discovery contract `createHermesSource` walks.
    const profile = join(hermesRoot, "profiles", report.profile);

    // Appended, not written over: what `argus up` converged into this file —
    // raised memory limits, curator disabled — is part of what a real Argus
    // profile is, and the drive should meet the same file a deployment makes.
    const configPath = join(profile, "config.yaml");
    const converged = existsSync(configPath)
      ? await readFile(configPath, "utf8")
      : "";
    await writeFile(configPath, `${converged}${offlineProviderConfig()}`);

    const env = hermesDriveEnv(sandbox.env, {
      hermesHome: profile,
      home: sandbox.env.HOME!,
    });
    const { exitCode, output } = await runBounded(
      [
        "hermes",
        "chat",
        "-q",
        DRIVE_PROMPT,
        "-Q",
        "--provider",
        OFFLINE_PROVIDER,
        "-m",
        "gpt-4o-mini",
      ],
      sandbox.repo,
      env,
      options.driveBudgetMs,
    );

    const stateDb = join(profile, "state.db");
    const transcript = output.slice(-600);
    return {
      cli: await hermesVersion(env),
      exitCode,
      hermesRoot,
      profile,
      provisioningFailure: existsSync(stateDb)
        ? null
        : `hermes exited ${exitCode} and left no state.db — ${transcript || "it said nothing"}`,
      schemaVersion: existsSync(stateDb) ? schemaVersionOf(stateDb) : null,
      stateDb,
      teardown,
      transcript,
    };
  } catch (error) {
    // Never a throw. This runs at module load, where a throw takes the whole
    // file down as an unhandled error and the three distinguished skips are
    // never printed at all — the silent disappearance this ticket exists to
    // end, wearing a different hat. The paths below are empty because nothing
    // reads them: they are only reachable once `provisioningFailure` is null.
    return {
      cli: null,
      exitCode: -1,
      hermesRoot: "",
      profile: "",
      provisioningFailure: `the drive failed before Hermes ran: ${
        error instanceof Error ? error.message : String(error)
      }`,
      schemaVersion: null,
      stateDb: "",
      teardown,
      transcript: "",
    };
  }
}
