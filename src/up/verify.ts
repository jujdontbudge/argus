/**
 * Verify the wiring, do not narrate it (#67).
 *
 * The audit's complaint was that setup "substitutes static docs for real
 * Matt-wiring verification": `up` wrote `docs/agents/*.md` and a pointer block
 * and then printed as though the wiring were proven. Writing a pointer proves
 * nothing. These checks READ BACK what setup wrote — through the adapters an
 * agent would actually use — and every one of them can fail.
 */

import { lstat, readdir, readlink, realpath, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { VERIFIED_HERMES_CLI_VERSION } from "../tailing/hermes-compat.ts";

export interface WiringCheck {
  detail: string;
  name: string;
  ok: boolean;
  warning?: boolean;
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}

/** Skill directories holding a SKILL.md, i.e. what a reader would find. */
async function canonicalSkills(skillsDirectory: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(skillsDirectory, { withFileTypes: true });
  } catch (error) {
    if (missing(error)) return found;
    throw error;
  }
  for (const entry of entries) {
    const path = join(skillsDirectory, entry.name);
    try {
      if (!(await stat(path)).isDirectory()) continue;
    } catch (error) {
      if (missing(error)) continue;
      throw error;
    }
    if (await exists(join(path, "SKILL.md"))) found.push(entry.name);
  }
  return found.sort();
}

/**
 * Prove Claude Code can read the canonical store: resolve the adapter link and
 * then read a real SKILL.md THROUGH it, comparing bytes with the canonical
 * file. A dangling or shadowing `.claude/skills` fails here rather than at
 * 3am inside an agent that quietly found no skills.
 */
async function checkClaudeSkillsAdapter(repo: string): Promise<WiringCheck> {
  const name = "claude skills adapter";
  const adapter = join(repo, ".claude", "skills");
  const canonical = join(repo, ".argus", "skills");
  if (!(await exists(adapter))) {
    return { detail: `${adapter} is missing`, name, ok: false };
  }
  const metadata = await lstat(adapter);
  if (metadata.isDirectory()) {
    const existing = await canonicalSkills(adapter);
    const orchestrator = join(canonical, "argus-orchestrator", "SKILL.md");
    if (!(await exists(orchestrator))) {
      return { detail: `${orchestrator} is missing`, name, ok: false };
    }
    return {
      detail: `${existing.length} existing Claude skill${existing.length === 1 ? "" : "s"} preserved; Argus orchestrator readable`,
      name,
      ok: true,
    };
  }
  if (!metadata.isSymbolicLink()) {
    return { detail: `${adapter} is neither a directory nor an Argus adapter`, name, ok: false };
  }
  const target = resolve(repo, ".claude", await readlink(adapter));
  if (!(await exists(target)) || (await realpath(target)) !== (await realpath(canonical))) {
    return { detail: `.claude/skills points at ${target}`, name, ok: false };
  }

  const skills = await canonicalSkills(canonical);
  if (skills.length === 0) {
    return { detail: "resolves; 0 canonical skills to read yet", name, ok: true };
  }
  const probe = skills[0]!;
  const throughAdapter = Bun.file(join(adapter, probe, "SKILL.md"));
  const canonicalFile = Bun.file(join(canonical, probe, "SKILL.md"));
  if (!(await throughAdapter.exists())) {
    return { detail: `${probe}/SKILL.md is not readable through the adapter`, name, ok: false };
  }
  if ((await throughAdapter.text()) !== (await canonicalFile.text())) {
    return { detail: `${probe}/SKILL.md differs when read through the adapter`, name, ok: false };
  }
  return {
    detail: `${skills.length} canonical skill${skills.length === 1 ? "" : "s"} readable through .claude/skills`,
    name,
    ok: true,
  };
}

async function expectedSkillDirectories(repo: string): Promise<string[]> {
  const adapter = join(repo, ".claude", "skills");
  const metadata = await lstat(adapter);
  return metadata.isDirectory()
    ? [adapter, join(repo, ".argus", "skills")]
    : [join(repo, ".argus", "skills")];
}

const POINTER = /`([^`\s]+\/|[^`\s]+\.md)`/g;
const MANAGED_BLOCKS = [
  /<!-- argus:begin -->[\s\S]*?<!-- argus:end -->/g,
  /<!-- matt-pocock:begin -->[\s\S]*?<!-- matt-pocock:end -->/g,
];

/** Every repo-relative path the managed AGENTS.md blocks tell agents to read. */
export function agentsPointers(agents: string): string[] {
  const pointers = new Set<string>();
  for (const block of MANAGED_BLOCKS) {
    for (const match of agents.matchAll(block)) {
      for (const [, pointer] of match[0].matchAll(POINTER)) {
        if (pointer && !pointer.startsWith("/") && !pointer.startsWith("~")) {
          pointers.add(pointer.replace(/\/$/, ""));
        }
      }
    }
  }
  return [...pointers];
}

/**
 * Every pointer in the managed blocks must resolve to something on disk. This
 * is the check the seeded `USER.md`/`MEMORY.md` exist for: before #67 this
 * would have failed on a fresh repo, which is precisely the audit's finding.
 */
async function checkAgentsPointers(repo: string): Promise<WiringCheck> {
  const name = "AGENTS.md pointers";
  const agentsFile = Bun.file(join(repo, "AGENTS.md"));
  if (!(await agentsFile.exists())) {
    return { detail: "AGENTS.md is missing", name, ok: false };
  }
  const pointers = agentsPointers(await agentsFile.text());
  const dangling: string[] = [];
  for (const pointer of pointers) {
    if (!(await exists(join(repo, pointer)))) dangling.push(pointer);
  }
  if (dangling.length > 0) {
    return {
      detail: `${dangling.length}/${pointers.length} dangling: ${dangling.join(", ")}`,
      name,
      ok: false,
    };
  }
  return {
    detail: `${pointers.length}/${pointers.length} resolve`,
    name,
    ok: true,
  };
}

/**
 * SPEC §8.1: when Hermes works an Argus repo its memory flush must land in
 * that repo's `.argus/memory/`, never the global store. `up` writes the link;
 * this reads it back.
 */
async function checkHermesMemoryBinding(
  repo: string,
  hermesRoot: string,
  profile: string,
): Promise<WiringCheck> {
  const name = "Hermes memory binding";
  const memories = join(hermesRoot, "profiles", profile, "memories");
  if (!(await exists(memories))) {
    return { detail: `${memories} is missing`, name, ok: false };
  }
  const canonical = join(repo, ".argus", "memory");
  if ((await realpath(memories)) !== (await realpath(canonical))) {
    return {
      detail: `profile memories resolves to ${await realpath(memories)}`,
      name,
      ok: false,
    };
  }
  return { detail: "profile memories -> .argus/memory", name, ok: true };
}

/** SPEC §8.2: the repo's one skills store must be a Hermes reader source. */
async function checkHermesSkillsBinding(
  repo: string,
  hermesRoot: string,
  profile: string,
): Promise<WiringCheck> {
  const name = "Hermes skills binding";
  const configPath = join(hermesRoot, "profiles", profile, "config.yaml");
  const configFile = Bun.file(configPath);
  if (!(await configFile.exists())) {
    return { detail: `${configPath} is missing`, name, ok: false };
  }
  const parsed = Bun.YAML.parse(await configFile.text()) as {
    skills?: { external_dirs?: unknown };
  } | null;
  const configured = parsed?.skills?.external_dirs;
  const directories =
    typeof configured === "string"
      ? [configured]
      : Array.isArray(configured)
        ? configured.filter((value): value is string => typeof value === "string")
        : [];
  const expected = await expectedSkillDirectories(repo);
  const omitted = expected.filter((directory) => !directories.includes(directory));
  if (omitted.length > 0) {
    return {
      detail: `profile skills.external_dirs omits ${omitted.join(", ")}`,
      name,
      ok: false,
    };
  }
  return {
    detail:
      expected.length === 1
        ? "profile skills.external_dirs includes .argus/skills"
        : "profile skills.external_dirs includes .claude/skills and .argus/skills",
    name,
    ok: true,
  };
}

export interface WiringOptions {
  /** Set only by `argus up`, which is the half that writes the binding. */
  hermes?: { profile: string; root: string; cli?: string };
}

/**
 * Compare the executable `argus up` will actually run with #126's verified
 * pin. This is deliberately warning-only: an unknown Hermes is degraded
 * operation, not a reason to stop the repo's other eyes from starting. The
 * trailing ` · upstream <hash>` is excluded because it identifies the remote
 * repository tip, not the installed Hermes version.
 */
async function checkHermesCompatibility(cli = "hermes"): Promise<WiringCheck> {
  const name = "Hermes compatibility";
  try {
    const child = Bun.spawn([cli, "--version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    const firstLine = stdout.split("\n")[0]?.trim();
    const reported = firstLine?.split(" · ")[0]?.trim();
    if (exitCode !== 0 || !reported) {
      return {
        detail: "WARN: never verified against this install (hermes --version unavailable)",
        name,
        ok: true,
        warning: true,
      };
    }
    if (reported !== VERIFIED_HERMES_CLI_VERSION) {
      return {
        detail: `WARN: installed ${reported}; verified against ${VERIFIED_HERMES_CLI_VERSION}`,
        name,
        ok: true,
        warning: true,
      };
    }
    return { detail: `installed version matches ${VERIFIED_HERMES_CLI_VERSION}`, name, ok: true };
  } catch {
    return {
      detail: "WARN: never verified against this install (hermes CLI missing)",
      name,
      ok: true,
      warning: true,
    };
  }
}

export async function verifyWiring(
  repo: string,
  options: WiringOptions = {},
): Promise<WiringCheck[]> {
  const checks = [
    await checkClaudeSkillsAdapter(repo),
    await checkAgentsPointers(repo),
  ];
  if (options.hermes) {
    checks.push(
      await checkHermesMemoryBinding(repo, options.hermes.root, options.hermes.profile),
      await checkHermesSkillsBinding(repo, options.hermes.root, options.hermes.profile),
      await checkHermesCompatibility(options.hermes.cli),
    );
  }
  return checks;
}

/** Print the report. Returns true when every check passed. */
export function printWiring(checks: WiringCheck[]): boolean {
  let ok = true;
  for (const check of checks) {
    if (check.ok && !check.warning) {
      console.log(`wiring: ${check.name} OK (${check.detail})`);
      continue;
    }
    if (check.warning) {
      console.error(`HERMES DEGRADED: ${check.name} — ${check.detail}`);
      continue;
    }
    ok = false;
    console.error(`WIRING DEGRADED: ${check.name} — ${check.detail}`);
  }
  return ok;
}
