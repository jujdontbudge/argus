import {
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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

const AGENTS_POINTER_BLOCK = `<!-- argus:begin -->
## Argus project memory and skills

- Read project-specific user context from \`.argus/memory/USER.md\`.
- Read durable project facts from \`.argus/memory/MEMORY.md\` and neighboring fact files.
- Use canonical per-repo skills from \`.argus/skills/\`.
- Search archived transcripts with \`argus search "<query>"\`.
<!-- argus:end -->`;

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

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function availableImportDirectory(
  source: string,
  destination: string,
): Promise<string> {
  for (let suffix = 1; ; suffix += 1) {
    const name = suffix === 1 ? "claude-imported" : `claude-imported-${suffix}`;
    if (
      !(await pathExists(join(source, name))) &&
      !(await pathExists(join(destination, name)))
    ) {
      return join(destination, name);
    }
  }
}

async function mergeDirectory(
  source: string,
  destination: string,
  importDirectory: string,
  relativePath: string[] = [],
): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourceEntry = join(source, entry.name);
    const destinationEntry = join(destination, entry.name);
    if (!(await pathExists(destinationEntry))) {
      await rename(sourceEntry, destinationEntry);
      continue;
    }

    const destinationMetadata = await lstat(destinationEntry);
    if (entry.isDirectory() && destinationMetadata.isDirectory()) {
      await mergeDirectory(sourceEntry, destinationEntry, importDirectory, [
        ...relativePath,
        entry.name,
      ]);
      await rm(sourceEntry, { recursive: true });
      continue;
    }

    const importedEntry = join(importDirectory, ...relativePath, entry.name);
    await mkdir(dirname(importedEntry), { recursive: true });
    await rename(sourceEntry, importedEntry);
  }
}

async function migrateClaudeMemory(
  repo: string,
  destination: string,
): Promise<void> {
  const home = process.env.HOME;
  const claudeConfig =
    process.env.CLAUDE_CONFIG_DIR ?? (home ? join(home, ".claude") : null);
  if (!claudeConfig) throw new Error("HOME is not set");

  const source = join(
    claudeConfig,
    "projects",
    repo.replaceAll("/", "-"),
    "memory",
  );
  try {
    const sourceMetadata = await lstat(source);
    if (sourceMetadata.isSymbolicLink()) {
      const target = resolve(dirname(source), await readlink(source));
      if (target === destination) return;
    }

    const importDirectory = await availableImportDirectory(source, destination);
    await mergeDirectory(source, destination, importDirectory);
    await rm(source, { recursive: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  await mkdir(dirname(source), { recursive: true });
  await symlink(destination, source);
}

async function ensureClaudeSkillsAdapter(repo: string): Promise<void> {
  const claudeDirectory = join(repo, ".claude");
  const adapter = join(claudeDirectory, "skills");
  await mkdir(claudeDirectory, { recursive: true });
  try {
    const metadata = await lstat(adapter);
    if (
      metadata.isSymbolicLink() &&
      (await readlink(adapter)) === "../.argus/skills"
    ) {
      return;
    }
    if (!metadata.isDirectory()) {
      throw new Error(`argus up: ${adapter} exists and is not a directory`);
    }
    const canonicalSkills = join(repo, ".argus", "skills");
    const importDirectory = await availableImportDirectory(
      adapter,
      canonicalSkills,
    );
    await mergeDirectory(adapter, canonicalSkills, importDirectory);
    await rm(adapter, { recursive: true });
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await symlink("../.argus/skills", adapter);
}

async function ensureAgentsPointer(repo: string): Promise<void> {
  const agentsPath = join(repo, "AGENTS.md");
  const file = Bun.file(agentsPath);
  const existing = (await file.exists()) ? await file.text() : "";
  const managedBlock = /<!-- argus:begin -->[\s\S]*?<!-- argus:end -->/g;
  let inserted = false;
  const refreshed = existing.replace(managedBlock, () => {
    if (inserted) return "";
    inserted = true;
    return AGENTS_POINTER_BLOCK;
  });
  const next = inserted
    ? refreshed
    : `${existing.trimEnd()}${existing.trim().length > 0 ? "\n\n" : ""}${AGENTS_POINTER_BLOCK}\n`;
  if (next !== existing) await Bun.write(agentsPath, next);
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
  await migrateClaudeMemory(repo, join(argusDirectory, "memory"));
  await ensureClaudeSkillsAdapter(repo);
  await ensureAgentsPointer(repo);
  await ensureIgnoreEntry(repo);

  console.log(`Argus converged ${repo}`);
  return 0;
}
