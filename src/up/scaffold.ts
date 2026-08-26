/**
 * The repo-local half of setup (#67).
 *
 * `argus init` is exactly this module; `argus up` is this module followed by
 * machine convergence (hooks, supervisor, tracker, Honcho/Hermes bindings).
 * The split is the product answer to the audit's "`init` does not exist": one
 * command writes files a human can read and a repo can commit, and it reaches
 * nothing outside the repo — no network, no `~/.codex`, no `~/.hermes`, no
 * launchd. Both are convergers, so running either twice changes nothing.
 */

import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readlink,
  rename,
  rm,
  symlink,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ARGUS_DIRECTORIES = [
  "registry",
  "memory",
  "skills",
  "sessions",
  "events",
] as const;

export const DEFAULT_CONFIG = `# Argus per-repo overrides. Uncomment only values that differ from defaults.
# honcho:
#   url: http://localhost:8000
# brain:
#   model: gpt-5.6-luna
#   reasoning_effort: low
#   max_concurrency: 2
# reviewer:
#   brain:
#     model: gpt-5.6-luna
#     reasoning_effort: low
#   quiet_window_seconds: 30
#   max_wait_seconds: 300
# digest:
#   brain:
#     model: gpt-5.6-luna
#     reasoning_effort: low
#   quiet_window_seconds: 30
#   max_wait_seconds: 120
# retro:
#   brain:
#     model: gpt-5.6-luna
#     reasoning_effort: low
#   quiet_window_seconds: 60
#   max_wait_seconds: 600
# dispatch:
#   max_concurrency: 3
`;

const AGENTS_POINTER_BLOCK = `<!-- argus:begin -->
## Argus project memory and skills

- Read project-specific user context from \`.argus/memory/USER.md\`.
- Read durable project facts from \`.argus/memory/MEMORY.md\` and neighboring fact files.
- Use canonical per-repo skills from \`.argus/skills/\`.
- Search archived transcripts with \`argus search "<query>"\`.
<!-- argus:end -->`;

const MATT_POINTER_BLOCK = `<!-- matt-pocock:begin -->
## Agent skills

### Issue tracker

Issues live in GitHub when a GitHub remote is configured. See \`docs/agents/issue-tracker.md\`.

### Triage labels

Use the canonical Matt Pocock triage vocabulary. See \`docs/agents/triage-labels.md\`.

### Domain docs

This is a single-context repository. See \`docs/agents/domain.md\`.
<!-- matt-pocock:end -->`;

/**
 * Seeds for the pair `AGENTS.md` points every agent at (#67).
 *
 * The audit found `up` writing pointers to files it never created. These
 * headers are byte-for-byte the ones `src/eyes/reviewer/outputs.ts` assumes
 * when it appends, so the first real finding extends the seeded store instead
 * of starting a second one beside it.
 */
const MEMORY_SEEDS = {
  "MEMORY.md": `# Memory index

Durable project facts for this repository — one line per fact file in this
directory, written by the Reviewer watcher and retired by the curator. Facts
land here whoever discovered them. Safe to edit by hand.
`,
  "USER.md": `# USER.md

Registry-verified, Johan-authored context for this repository: preferences,
standing directives, how he wants work done here. Only provenance-verified
Johan messages reach this file. Safe to edit by hand.
`,
} as const;

const ORCHESTRATOR_SKILL_SOURCE = fileURLToPath(
  new URL("../../skills/argus-orchestrator/SKILL.md", import.meta.url),
);

/** Repo-relative paths Argus writes that belong in version control. */
export const INTEGRATION_PATHS = [".gitignore", "AGENTS.md", "docs/agents"] as const;

export interface CommandResult {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export async function run(command: string[], cwd: string): Promise<CommandResult> {
  try {
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
  } catch (error) {
    return {
      exitCode: 127,
      stderr: error instanceof Error ? error.message : String(error),
      stdout: "",
    };
  }
}

function parseGitHubRemote(url: string): string | null {
  const normalized = url.trim().replace(/\/$/, "").replace(/\.git$/, "");
  const match = normalized.match(/github\.com(?::|\/)([^/]+)\/([^/]+)$/i);
  return match?.[1] && match[2] ? `${match[1]}/${match[2]}` : null;
}

/** The repo's GitHub `owner/name`, read from git config alone — no network. */
export async function githubRepo(repo: string): Promise<string | null> {
  const remotes = await run(["git", "remote"], repo);
  if (remotes.exitCode !== 0) return null;
  for (const remote of remotes.stdout.split(/\r?\n/).filter(Boolean)) {
    const url = await run(["git", "remote", "get-url", remote], repo);
    if (url.exitCode !== 0) continue;
    const parsed = parseGitHubRemote(url.stdout);
    if (parsed) return parsed;
  }
  return null;
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
    if (metadata.isSymbolicLink()) {
      const target = await readlink(adapter);
      if (target === "../.argus/skills") return;
      // Someone else owns this link. Refusing loudly beats silently
      // redirecting a reader away from a store they chose.
      throw new Error(
        `argus init: .claude/skills already points at ${target}; refusing to replace it`,
      );
    }
    if (!metadata.isDirectory()) {
      throw new Error(`argus init: ${adapter} exists and is not a directory`);
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

async function writeIfMissing(path: string, contents: string): Promise<void> {
  if (await Bun.file(path).exists()) return;
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, contents);
}

/**
 * Seed `USER.md`/`MEMORY.md` only when there is nothing to lose.
 *
 * "Missing or whitespace-only" is the gate, deliberately narrow: a converger
 * that re-seeded would overwrite the Reviewer's work and Johan's own edits on
 * the second run, which is the one nobody watches.
 */
async function seedMemoryFiles(memoryDirectory: string): Promise<string[]> {
  const seeded: string[] = [];
  for (const [name, contents] of Object.entries(MEMORY_SEEDS)) {
    const path = join(memoryDirectory, name);
    const file = Bun.file(path);
    if ((await file.exists()) && (await file.text()).trim().length > 0) continue;
    await Bun.write(path, contents);
    seeded.push(name);
  }
  return seeded;
}

/**
 * Fork the bundled orchestrator procedure into the repo's canonical store.
 *
 * The copy is deliberately seed-only. Once present, the repo's skill may be
 * edited by a human or the learning loop, and a later `argus up` must not
 * replace that local fork with newer bundled bytes without a merge.
 */
async function seedOrchestratorSkill(skillsDirectory: string): Promise<void> {
  const destination = join(
    skillsDirectory,
    "argus-orchestrator",
    "SKILL.md",
  );
  if (await pathExists(destination)) return;
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(ORCHESTRATOR_SKILL_SOURCE, destination);
}

/**
 * Everything Argus generates that must NOT be committed.
 *
 * `.claude/skills` is a symlink into the ignored canonical store and `init`
 * recreates it; `.claude/settings.local.json` holds this machine's absolute
 * bun and script paths, so committing it would hand another machine hooks
 * that cannot run. Ignoring them is what leaves the audit's "`.claude/`
 * untracked and unexplained" with nothing left to explain.
 */
const IGNORED = [".argus/", ".claude/skills", ".claude/settings.local.json"] as const;

async function ensureIgnoreEntry(repo: string): Promise<void> {
  const ignorePath = join(repo, ".gitignore");
  const file = Bun.file(ignorePath);
  const existing = (await file.exists()) ? await file.text() : "";
  const lines = existing.split(/\r?\n/);
  const missing = IGNORED.filter((entry) => !lines.includes(entry));
  if (missing.length === 0) return;
  const separator = existing.length === 0 || existing.endsWith("\n") ? "" : "\n";
  await Bun.write(
    ignorePath,
    `${existing}${separator}${missing.join("\n")}\n`,
  );
}

/**
 * The Matt Pocock agent-docs wiring: written once, then verified rather than
 * re-asserted. `verifyWiring` is what proves the pointers resolve (#67).
 */
async function ensureMattWiring(
  repo: string,
  remoteRepo: string | null,
): Promise<void> {
  const docs = join(repo, "docs", "agents");
  await writeIfMissing(
    join(docs, "issue-tracker.md"),
    `# Issue tracker: GitHub\n\n${
      remoteRepo
        ? `Issues for this repository live at GitHub repository \`${remoteRepo}\`.`
        : "No GitHub remote is configured yet; Argus runs in tracker-less mode until one is added."
    } Use \`gh\` for issue and label operations.\n\nPull requests as a request surface: no.\n`,
  );
  await writeIfMissing(
    join(docs, "triage-labels.md"),
    `# Triage labels\n\n| Role | Tracker label |\n| --- | --- |\n| needs-triage | needs-triage |\n| needs-info | needs-info |\n| ready-for-agent | ready-for-agent |\n| ready-for-human | ready-for-human |\n| wontfix | wontfix |\n`,
  );
  await writeIfMissing(
    join(docs, "domain.md"),
    `# Domain docs\n\nThis is a single-context repository. Read \`CONTEXT.md\` when present and relevant ADRs under \`docs/adr/\` before changing their domain.\n`,
  );

  const agentsPath = join(repo, "AGENTS.md");
  const existing = await Bun.file(agentsPath).text();
  const marker = /<!-- matt-pocock:begin -->[\s\S]*?<!-- matt-pocock:end -->/g;
  const withoutBlocks = existing.replace(marker, "").trimEnd();
  const next = `${withoutBlocks}\n\n${MATT_POINTER_BLOCK}\n`;
  if (next !== existing) await Bun.write(agentsPath, next);
}

export interface ScaffoldReport {
  /** Memory files this run created, so the CLI can say so once and only once. */
  seededMemory: string[];
}

/**
 * Converge every repo-local artefact. Idempotent by construction: each step
 * either matches what is already there or rewrites it to the same bytes.
 */
export async function scaffoldRepo(repo: string): Promise<ScaffoldReport> {
  const argusDirectory = join(repo, ".argus");
  await Promise.all(
    ARGUS_DIRECTORIES.map((directory) =>
      mkdir(join(argusDirectory, directory), { recursive: true }),
    ),
  );
  const config = Bun.file(join(argusDirectory, "config.yaml"));
  if (!(await config.exists())) await Bun.write(config, DEFAULT_CONFIG);

  const memoryDirectory = join(argusDirectory, "memory");
  // Migration first: a store moved in from Claude is real memory, and seeding
  // ahead of it would create the files it is about to be merged against.
  await migrateClaudeMemory(repo, memoryDirectory);
  const seededMemory = await seedMemoryFiles(memoryDirectory);

  await seedOrchestratorSkill(join(argusDirectory, "skills"));
  await ensureClaudeSkillsAdapter(repo);
  await ensureAgentsPointer(repo);
  await ensureMattWiring(repo, await githubRepo(repo));
  await ensureIgnoreEntry(repo);
  return { seededMemory };
}

/** Integration paths that differ from HEAD, repo-relative and sorted. */
export async function pendingIntegrationPaths(repo: string): Promise<string[]> {
  const status = await run(
    ["git", "status", "--porcelain", "--", ...INTEGRATION_PATHS],
    repo,
  );
  if (status.exitCode !== 0) throw new Error(status.stderr.trim());
  const pending = new Set<string>();
  for (const line of status.stdout.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const path = line.slice(3).replace(/^"|"$/g, "");
    const top = INTEGRATION_PATHS.find(
      (candidate) => path === candidate || path.startsWith(`${candidate}/`),
    );
    if (top) pending.add(top);
  }
  return [...pending].sort(
    (left, right) => INTEGRATION_PATHS.indexOf(left as never) - INTEGRATION_PATHS.indexOf(right as never),
  );
}

/**
 * Say what to commit, or commit exactly what was asked for — never both, never
 * silently.
 *
 * The audit's sharpest finding was a surprise `.gitignore`-only commit made on
 * a user's behalf. The answer is not a better-chosen file set: it is that the
 * default commits nothing and prints the command, and `--commit` commits the
 * whole integration set (as it stands in the working tree) in one labelled
 * commit. Both outcomes are printed, so neither is a surprise.
 */
export async function reportCommitState(
  repo: string,
  command: "init" | "up",
  commit: boolean,
): Promise<void> {
  const pending = await pendingIntegrationPaths(repo);
  if (pending.length === 0) {
    console.log("Integration files: already committed (nothing to add)");
    return;
  }

  const list = pending.join(", ");
  if (!commit) {
    console.log(`Committed nothing. Argus never commits for you by default.`);
    console.log(`  Integration files not yet in git: ${list}`);
    console.log(`  git add -- ${pending.join(" ")}`);
    console.log(`  git commit -m "chore: adopt Argus"`);
    console.log(`  (or re-run \`argus ${command} --commit\` to let Argus do exactly that)`);
    return;
  }

  const added = await run(["git", "add", "--", ...pending], repo);
  if (added.exitCode !== 0) throw new Error(added.stderr.trim());
  const committed = await run(
    ["git", "commit", "--quiet", "-m", "chore: adopt Argus", "--", ...pending],
    repo,
  );
  if (committed.exitCode !== 0) throw new Error(committed.stderr.trim());
  console.log(`Committed ${list} as "chore: adopt Argus"`);
}
