/**
 * Verify the wiring, do not narrate it (#67).
 *
 * The audit's complaint was that setup "substitutes static docs for real
 * Matt-wiring verification": `up` wrote `docs/agents/*.md` and a pointer block
 * and then printed as though the wiring were proven. Writing a pointer proves
 * nothing. These checks READ BACK what setup wrote — through the adapters an
 * agent would actually use — and every one of them can fail.
 */

import { lstat, readdir, readlink, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";

export interface WiringCheck {
  detail: string;
  name: string;
  ok: boolean;
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
    if (!entry.isDirectory()) continue;
    if (await exists(join(skillsDirectory, entry.name, "SKILL.md"))) {
      found.push(entry.name);
    }
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
  if (!metadata.isSymbolicLink()) {
    return { detail: `${adapter} is not a symlink to .argus/skills`, name, ok: false };
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

export interface WiringOptions {
  /** Set only by `argus up`, which is the half that writes the binding. */
  hermes?: { profile: string; root: string };
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
    );
  }
  return checks;
}

/** Print the report. Returns true when every check passed. */
export function printWiring(checks: WiringCheck[]): boolean {
  let ok = true;
  for (const check of checks) {
    if (check.ok) {
      console.log(`wiring: ${check.name} OK (${check.detail})`);
      continue;
    }
    ok = false;
    console.error(`WIRING DEGRADED: ${check.name} — ${check.detail}`);
  }
  return ok;
}
