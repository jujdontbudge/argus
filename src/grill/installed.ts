/**
 * Does the routed skill id actually EXIST on this machine? (ticket #89)
 *
 * `./skills.ts` states the hazard in its own docblock — "`claude` given a
 * skill id that does not exist does not fail — it carries on and does
 * something adjacent, which is the worst possible failure for a planning
 * entry point" — and then `skills.test.ts` pins the ids by comparing
 * `GRILL_MODES.spec.skill` to the literal `"pocock-plus:to-spec"` it was
 * built from. Constant against constant. That test cannot fail for the reason
 * the docblock says it can: an upstream rename moves the SKILL.md and leaves
 * both sides of the assertion untouched.
 *
 * This module is the missing half — the id resolved against the machine,
 * never against another copy of itself.
 *
 * HOW A PLUGIN ID RESOLVES, and why it is read from the same file `claude`
 * reads. `~/.claude/plugins/installed_plugins.json` maps
 * `<plugin>@<marketplace>` to the VERSIONED `installPath` currently active.
 * The cache holds several versions side by side (1.2.3-johan.2, .3 and .7 on
 * this machine), and three of the five routed skills exist in all of them, so
 * a glob over the cache would answer "installed" for a version `claude` will
 * never load. The manifest is the only thing that names the active one.
 *
 * WHAT "EXISTS" IS NOT ENOUGH TO PROVE, and this is the finding #89 turned
 * up rather than a subtlety invented here. A SKILL.md whose frontmatter
 * carries `disable-model-invocation: true` is present on disk, is reachable
 * as a slash command, and CANNOT be invoked by the model. The grill dispatch
 * prompt (`./prompt.ts`) says "Use the <id> skill and <charter>." — a request
 * for a model invocation. For such a skill that sentence is unsatisfiable,
 * and `claude` does not fail: it carries on and does something adjacent,
 * which is the exact sentence the hazard was written as. So invocability is
 * resolved and reported beside existence, and a caller that only checks the
 * first learns nothing about the failure that actually happens.
 *
 * BOTH SURFACES, not one (#97). `claude` has exactly two ways in — the Skill
 * tool and the `/<id>` command — and the frontmatter closes them with two
 * INDEPENDENT keys, both of which are in use on this machine:
 * `disable-model-invocation: true` (`pocock-plus:to-spec`) and
 * `user-invocable: false` (`codex:codex-cli-runtime`). Reporting only the
 * first would let a caller route a mode to a slash command that is not there.
 * This module still only REPORTS; `./dispatch.ts` is what turns the report
 * into the invocation a session gets, or into a refusal.
 */
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { GRILL_MODES, type GrillMode, type ResolvedGrillSkill } from "./skills.ts";

/** The manifest `claude` itself reads to pick a plugin's active version. */
export const INSTALLED_PLUGINS_FILE = join(
  homedir(),
  ".claude/plugins/installed_plugins.json",
);

export interface InstalledSkill {
  /** The SKILL.md that backs the id, as an absolute path. */
  path: string;
  /** The `name:` its frontmatter declares — the id's second half. */
  name: string;
  /**
   * False when the frontmatter carries `disable-model-invocation: true`.
   * A dispatch prompt that says "Use the X skill" cannot be honoured then.
   */
  modelInvocable: boolean;
  /**
   * False when the frontmatter carries `user-invocable: false` — the OTHER
   * axis, and an independent one (#97). `disable-model-invocation` closes the
   * Skill tool; `user-invocable: false` closes the `/<id>` command surface.
   * This machine carries live examples of each on its own (`pocock-plus`'s
   * `to-spec` is slash-only; `codex`'s `codex-cli-runtime` is model-only), so
   * a skill reachable by NEITHER is a state a plugin can ship, not a
   * hypothetical — and it is the one a caller must refuse rather than route.
   */
  userInvocable: boolean;
}

export type SkillResolution =
  | { status: "resolved"; skill: InstalledSkill; source: ResolvedGrillSkill["source"] }
  | { status: "missing"; reason: string };

export interface GrillSkillVerification {
  mode: GrillMode;
  /** The id the dispatch prompt would invoke, verbatim. */
  id: string;
  resolution: SkillResolution;
}

/**
 * Every SKILL.md under the ACTIVE install of one plugin, keyed by declared
 * name. Returns null when the plugin is not installed at all, so a caller can
 * tell "no such plugin" apart from "plugin without that skill".
 */
export async function installedPluginSkills(
  qualifier: string,
  manifestFile: string = INSTALLED_PLUGINS_FILE,
): Promise<Map<string, InstalledSkill> | null> {
  let manifest: unknown;
  try {
    manifest = await Bun.file(manifestFile).json();
  } catch {
    return null;
  }
  const installPath = activeInstallPath(manifest, qualifier);
  if (installPath === null) return null;

  const found = new Map<string, InstalledSkill>();
  // Only `skills/` — the sibling `upstream-baseline/` and `flat-skills/` trees
  // are a vendored copy and a build artifact, not what the plugin loader reads.
  for await (const path of skillFiles(join(installPath, "skills"))) {
    const parsed = await parseSkill(path);
    if (parsed !== null && !found.has(parsed.name)) found.set(parsed.name, parsed);
  }
  return found;
}

/**
 * Resolve one mode's routed skill the way the session will: the repo's
 * canonical `.argus/skills/` first (SPEC §8.2 — "the plugin id is the
 * fallback, never the override"), then the active plugin install.
 */
export async function verifyGrillSkill(
  repo: string,
  mode: GrillMode,
  manifestFile: string = INSTALLED_PLUGINS_FILE,
): Promise<GrillSkillVerification> {
  const route = GRILL_MODES[mode];
  const canonicalPath = join(repo, ".argus", "skills", route.name, "SKILL.md");
  const canonical = await parseSkill(canonicalPath);
  if (canonical !== null) {
    return {
      id: route.name,
      mode,
      resolution: { skill: canonical, source: "argus-canonical", status: "resolved" },
    };
  }

  const [qualifier, name] = splitPluginId(route.skill);
  if (name === null) {
    return {
      id: route.skill,
      mode,
      resolution: {
        reason: `'${route.skill}' is not a <plugin>:<skill> id`,
        status: "missing",
      },
    };
  }
  const skills = await installedPluginSkills(qualifier, manifestFile);
  if (skills === null) {
    return {
      id: route.skill,
      mode,
      resolution: {
        reason: `no active install of plugin '${qualifier}' in ${manifestFile}`,
        status: "missing",
      },
    };
  }
  const skill = skills.get(name);
  if (skill === undefined) {
    return {
      id: route.skill,
      mode,
      resolution: {
        reason: `plugin '${qualifier}' is installed but declares no skill named '${name}'`,
        status: "missing",
      },
    };
  }
  return {
    id: route.skill,
    mode,
    resolution: { skill, source: "pocock-plus", status: "resolved" },
  };
}

/** Every mode in `GRILL_MODES`, so a rename cannot hide in an unused one. */
export async function verifyEveryGrillSkill(
  repo: string,
  manifestFile: string = INSTALLED_PLUGINS_FILE,
): Promise<GrillSkillVerification[]> {
  const modes = Object.keys(GRILL_MODES) as GrillMode[];
  return Promise.all(modes.map((mode) => verifyGrillSkill(repo, mode, manifestFile)));
}

/**
 * The manifest's shape is `{ plugins: { "<name>@<market>": [ { installPath } ] } }`.
 * A plugin may be installed at several scopes; the LAST entry wins, matching
 * the loader's user-over-project precedence on this machine.
 */
function activeInstallPath(manifest: unknown, qualifier: string): string | null {
  if (typeof manifest !== "object" || manifest === null) return null;
  const plugins = (manifest as { plugins?: unknown }).plugins;
  if (typeof plugins !== "object" || plugins === null) return null;
  for (const [key, value] of Object.entries(plugins as Record<string, unknown>)) {
    if (key !== qualifier && !key.startsWith(`${qualifier}@`)) continue;
    if (!Array.isArray(value) || value.length === 0) continue;
    const last = value[value.length - 1] as { installPath?: unknown };
    if (typeof last?.installPath === "string" && last.installPath !== "") {
      return last.installPath;
    }
  }
  return null;
}

function splitPluginId(id: string): [string, string | null] {
  const colon = id.indexOf(":");
  if (colon <= 0 || colon === id.length - 1) return [id, null];
  return [id.slice(0, colon), id.slice(colon + 1)];
}

async function* skillFiles(root: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) yield* skillFiles(path);
    else if (entry.name === "SKILL.md") yield path;
  }
}

/**
 * The frontmatter block only, and only the two keys that decide the route.
 * Deliberately not a YAML parser: the loader's own contract for these two is
 * a bare scalar on its own line, and a dependency-free reader that refuses to
 * guess at anything else cannot disagree with it in a way that matters here.
 */
async function parseSkill(path: string): Promise<InstalledSkill | null> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    return null;
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (match === null) return null;
  let name: string | null = null;
  let disabled = false;
  let userInvocable = true;
  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (pair === null) continue;
    if (pair[1] === "name") name = pair[2]!.trim().replace(/^["']|["']$/g, "");
    if (pair[1] === "disable-model-invocation") {
      disabled = pair[2]!.trim().toLowerCase() === "true";
    }
    // Default TRUE, and only an explicit `false` closes it: the key is absent
    // from 30 of this machine's 36 pocock-plus skills, and reading absence as
    // "not reachable" would refuse every grill on the machine.
    if (pair[1] === "user-invocable") {
      userInvocable = pair[2]!.trim().toLowerCase() !== "false";
    }
  }
  if (name === null || name === "") return null;
  return { modelInvocable: !disabled, name, path, userInvocable };
}
