import { mkdir } from "node:fs/promises";
import { join } from "node:path";

const ARGUS_DIRECTORIES = [
  "registry",
  "memory",
  "skills",
  "sessions",
  "events",
] as const;

const DEFAULT_CONFIG = `# Argus per-repo overrides. Uncomment only values that differ from defaults.
# brain:
#   model: gpt-5.6-luna
#   reasoning_effort: low
#   max_concurrency: 2
# reviewer:
#   quiet_window_seconds: 30
#   max_wait_seconds: 300
# digest:
#   quiet_window_seconds: 30
#   max_wait_seconds: 120
`;

interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

async function run(command: string[], cwd: string): Promise<CommandResult> {
  const child = Bun.spawn(command, {
    cwd,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

async function gitRoot(cwd: string): Promise<string | null> {
  const result = await run(["git", "rev-parse", "--show-toplevel"], cwd);
  return result.exitCode === 0 ? result.stdout.trim() : null;
}

async function ensureIgnoreEntry(repo: string): Promise<void> {
  const ignorePath = join(repo, ".gitignore");
  const file = Bun.file(ignorePath);
  const existing = (await file.exists()) ? await file.text() : "";
  const lines = existing.split(/\r?\n/);
  if (lines.includes(".argus/")) return;

  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  await Bun.write(ignorePath, `${existing}${separator}.argus/\n`);

  const added = await run(["git", "add", "--", ".gitignore"], repo);
  if (added.exitCode !== 0) throw new Error(added.stderr.trim());
  const committed = await run(
    ["git", "commit", "--quiet", "-m", "chore: ignore Argus state", "--", ".gitignore"],
    repo,
  );
  if (committed.exitCode !== 0) throw new Error(committed.stderr.trim());
}

export async function convergeUp(cwd = process.cwd()): Promise<number> {
  const repo = await gitRoot(cwd);
  if (!repo) {
    console.error("argus up: current directory is not inside a git repository");
    return 1;
  }

  const argusDirectory = join(repo, ".argus");
  await Promise.all(
    ARGUS_DIRECTORIES.map((directory) =>
      mkdir(join(argusDirectory, directory), { recursive: true }),
    ),
  );
  const config = Bun.file(join(argusDirectory, "config.yaml"));
  if (!(await config.exists())) await Bun.write(config, DEFAULT_CONFIG);
  await ensureIgnoreEntry(repo);

  console.log(`Argus converged ${repo}`);
  return 0;
}
