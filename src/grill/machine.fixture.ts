/**
 * A FAKE machine for the grill's skill tests (#89, #97).
 *
 * Three test files now have to agree on what "a machine with pocock-plus
 * installed" looks like — `installed.test.ts` (does the id resolve),
 * `dispatch.test.ts` (can a session invoke it) and `grill.test.ts` (does
 * `startGrill` refuse when it cannot). Copying the builder into each is how
 * two of them end up describing a plugin layout the third does not have, so
 * it lives here once.
 *
 * It is a fixture and not a helper on the production side on purpose: nothing
 * under `src/grill/` may read it, and the real resolver's only input is a
 * manifest path, which is what this returns.
 */
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface FakeSkill {
  category: string;
  name: string;
  /** `disable-model-invocation: true` — reachable as `/id`, not by the model. */
  slashOnly?: boolean;
  /** `user-invocable: false` — reachable by the model, not as `/id`. */
  modelOnly?: boolean;
}

export interface FakeMachine {
  /** The `installed_plugins.json` to hand the resolver. */
  manifest: string;
  /** An empty repo, so `.argus/skills/` is absent unless a test writes one. */
  repo: string;
  root: string;
}

export const INSTALLED: readonly FakeSkill[] = [
  { category: "productivity", name: "grilling" },
  { category: "engineering", name: "code-review" },
  { category: "engineering", name: "diagnosing-bugs" },
  { category: "engineering", name: "to-spec" },
  { category: "engineering", name: "to-tickets" },
];

/** `INSTALLED`, with one skill's frontmatter changed — an upstream edit. */
export function withFrontmatter(
  name: string,
  change: Omit<FakeSkill, "category" | "name">,
): FakeSkill[] {
  return INSTALLED.map((skill) =>
    skill.name === name ? { ...skill, ...change } : skill,
  );
}

export async function fakeMachine(
  skills: readonly FakeSkill[] = INSTALLED,
  options: { version?: string; qualifier?: string } = {},
): Promise<FakeMachine> {
  const root = await mkdtemp(join(tmpdir(), "argus-grill-skills-"));
  const version = options.version ?? "1.2.3-johan.7";
  const installPath = join(root, "cache", "pocock-plus", version);
  for (const skill of skills) {
    const directory = join(installPath, "skills", skill.category, skill.name);
    await mkdir(directory, { recursive: true });
    await Bun.write(join(directory, "SKILL.md"), skillFile(skill));
  }
  const manifest = join(root, "installed_plugins.json");
  await Bun.write(
    manifest,
    JSON.stringify({
      plugins: {
        [`${options.qualifier ?? "pocock-plus"}@johan-plugins`]: [
          { installPath, scope: "user", version },
        ],
      },
      version: 2,
    }),
  );
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  return { manifest, repo, root };
}

function skillFile(skill: FakeSkill): string {
  return [
    "---",
    `name: ${skill.name}`,
    "description: a fixture skill",
    ...(skill.slashOnly === true ? ["disable-model-invocation: true"] : []),
    ...(skill.modelOnly === true ? ["user-invocable: false"] : []),
    "---",
    "",
    "body",
  ].join("\n");
}
