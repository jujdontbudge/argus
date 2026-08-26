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

/**
 * ADR-0001's stack, so these are this repo's own two gates — the same pair
 * every ticket in this build is asked to run before it claims to be done.
 */
export const DEFAULT_GATES: readonly Gate[] = [
  { command: ["bun", "x", "tsc", "--noEmit"], name: "typecheck" },
  { command: ["bun", "test"], name: "tests" },
];

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
  gates: readonly Gate[] = DEFAULT_GATES,
  run: GateRunner = runGateCommand,
): Promise<GateReport> {
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
