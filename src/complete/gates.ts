/**
 * The gates (ticket #57; SPEC §7.3.4: "On green (tests pass, review clean)").
 *
 * A GATE IS ONLY A GATE IF IT CAN REFUSE. The whole value of this module is
 * the exit code it is willing to believe: a non-zero one stops the merge, and
 * nothing downstream may reinterpret that. So there is no "warn" outcome, no
 * retry-until-green, and no allowance for a gate whose command could not be
 * run at all — a gate that did not execute is a gate that did not pass.
 *
 * Gates run IN THE TICKET'S WORKTREE, never in the repo root. The worktree is
 * the only place the ticket's code exists before the merge; running them in
 * the root would test main and call it the ticket's evidence.
 *
 * They run in order and STOP at the first failure. The report is what the
 * ticket comment quotes, and the first red gate is the one a human needs;
 * spending minutes on the rest to say "also red" helps nobody.
 */
export interface Gate {
  name: string;
  command: readonly string[];
}

export type GateResolution =
  | { status: "resolved"; source: string; gates: readonly Gate[] }
  | { status: "error"; reason: string };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function configuredGateResolution(
  repo: string,
  config: unknown,
): GateResolution | null {
  if (!record(config) || !("completion" in config)) return null;
  const completion = config.completion;
  const prefix = `${repo}/.argus/config.yaml completion.gates`;
  if (!record(completion) || !("gates" in completion)) {
    return {
      reason: `${prefix} must be a non-empty list of { name, command } entries`,
      status: "error",
    };
  }
  if (!Array.isArray(completion.gates)) {
    return { reason: `${prefix} must be a list`, status: "error" };
  }
  if (completion.gates.length === 0) {
    return {
      reason:
        `${prefix} cannot be empty; configure at least one gate such as ` +
        "{ name: tests, command: [python3, -m, unittest] }",
      status: "error",
    };
  }

  const gates: Gate[] = [];
  for (const [index, candidate] of completion.gates.entries()) {
    const entry = `${prefix}[${index}]`;
    if (!record(candidate)) {
      return { reason: `${entry} must be an object`, status: "error" };
    }
    if (typeof candidate.name !== "string" || candidate.name.trim() === "") {
      return { reason: `${entry}.name must be a non-empty string`, status: "error" };
    }
    if (
      !Array.isArray(candidate.command) ||
      candidate.command.length === 0 ||
      !candidate.command.every(
        (part) => typeof part === "string" && part.trim().length > 0,
      )
    ) {
      return {
        reason: `${entry}.command must be a non-empty argv list of strings`,
        status: "error",
      };
    }
    gates.push({ command: candidate.command, name: candidate.name.trim() });
  }

  return {
    gates,
    source: ".argus/config.yaml completion.gates",
    status: "resolved",
  };
}

async function rootFileExists(root: string, name: string): Promise<boolean> {
  return Bun.file(`${root}/${name}`).exists();
}

/** Resolve gates from repository-owned configuration or authoritative root manifests. */
export async function resolveRepositoryGates(
  repo: string,
  worktree: string,
  detectRoot = true,
): Promise<GateResolution> {
  const configFile = Bun.file(`${repo}/.argus/config.yaml`);
  if (await configFile.exists()) {
    let config: unknown;
    try {
      config = Bun.YAML.parse(await configFile.text());
    } catch (error) {
      return {
        reason:
          `${repo}/.argus/config.yaml must be valid YAML before completion gates ` +
          `can run: ${error instanceof Error ? error.message : String(error)}`,
        status: "error",
      };
    }
    if (config !== null && config !== undefined && !record(config)) {
      return {
        reason: `${repo}/.argus/config.yaml root must be a map`,
        status: "error",
      };
    }
    const configured = configuredGateResolution(repo, config);
    if (configured !== null) return configured;
  }

  if (!detectRoot) {
    return {
      gates: [],
      source: "no repository-configured additional gates",
      status: "resolved",
    };
  }

  const packageFile = Bun.file(`${worktree}/package.json`);
  if (
    (await packageFile.exists()) &&
    (await rootFileExists(worktree, "tsconfig.json")) &&
    ((await rootFileExists(worktree, "bun.lock")) ||
      (await rootFileExists(worktree, "bun.lockb")))
  ) {
    let manifest: unknown;
    try {
      manifest = JSON.parse(await packageFile.text());
    } catch (error) {
      return {
        reason:
          `root package.json at ${worktree}/package.json must be valid JSON before gates ` +
          `can be detected: ${error instanceof Error ? error.message : String(error)}`,
        status: "error",
      };
    }
    const scripts = record(manifest) && record(manifest.scripts)
      ? manifest.scripts
      : undefined;
    if (
      typeof scripts?.typecheck === "string" &&
      scripts.typecheck.trim() !== "" &&
      typeof scripts.test === "string" &&
      scripts.test.trim() !== ""
    ) {
      return {
        gates: [
          { command: ["bun", "run", "typecheck"], name: "typecheck" },
          { command: ["bun", "run", "test"], name: "tests" },
        ],
        source: "root Bun package scripts with tsconfig.json and lockfile",
        status: "resolved",
      };
    }
  }

  return {
    reason:
      `no completion gates are configured for ${repo}, and the ticket worktree ` +
      "has no supported authoritative root manifest; add completion.gates to " +
      `${repo}/.argus/config.yaml, with each gate providing a name and command argv`,
    status: "error",
  };
}

export interface GateResult {
  name: string;
  command: readonly string[];
  exitCode: number;
  passed: boolean;
  /** Tail of the combined output — enough to act on, bounded for a comment. */
  output: string;
}

export type GateRunner = (
  command: readonly string[],
  cwd: string,
) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const MAX_OUTPUT_CHARACTERS = 4_000;

export const runGateCommand: GateRunner = async (command, cwd) => {
  try {
    const child = Bun.spawn([...command], { cwd, stderr: "pipe", stdout: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stderr, stdout };
  } catch (error) {
    // Unrunnable is not passable.
    return {
      exitCode: 127,
      stderr: error instanceof Error ? error.message : String(error),
      stdout: "",
    };
  }
};

function tail(stdout: string, stderr: string): string {
  const combined = `${stdout}${stdout.endsWith("\n") || stdout === "" ? "" : "\n"}${stderr}`.trim();
  return combined.length <= MAX_OUTPUT_CHARACTERS
    ? combined
    : combined.slice(-MAX_OUTPUT_CHARACTERS);
}

export interface GateReport {
  passed: boolean;
  results: GateResult[];
  /** The first gate that refused, or null when every gate passed. */
  failure: GateResult | null;
}

export async function runGates(
  worktree: string,
  gates: readonly Gate[],
  run: GateRunner = runGateCommand,
): Promise<GateReport> {
  if (gates.length === 0) {
    throw new Error("at least one completion gate is required");
  }
  const results: GateResult[] = [];
  for (const gate of gates) {
    const outcome = await run(gate.command, worktree);
    const result: GateResult = {
      command: gate.command,
      exitCode: outcome.exitCode,
      name: gate.name,
      output: tail(outcome.stdout, outcome.stderr),
      passed: outcome.exitCode === 0,
    };
    results.push(result);
    if (!result.passed) return { failure: result, passed: false, results };
  }
  return { failure: null, passed: true, results };
}
