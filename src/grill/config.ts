import { join } from "node:path";

/** The subscription model used by every GRILL_MODES route unless overridden. */
export const DEFAULT_GRILL_MODEL = "claude-fable-5";

export interface GrillConfig {
  model: string;
}

/**
 * Read the small `grill:` section from the repo-local Argus config.
 *
 * Grill models are Claude subscription slugs, so unlike the unattended Codex
 * brain config they are intentionally not checked against the ChatGPT model
 * catalog in `src/eyes/config.ts`.
 */
export async function loadGrillConfig(repo: string): Promise<GrillConfig> {
  const file = Bun.file(join(repo, ".argus", "config.yaml"));
  if (!(await file.exists())) return { model: DEFAULT_GRILL_MODEL };

  const text = await file.text();
  const lines = text.split(/\r?\n/);
  const section = lines.findIndex((line) => /^grill:\s*(?:#.*)?$/.test(line));
  if (section === -1) return { model: DEFAULT_GRILL_MODEL };

  for (let index = section + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (!/^\s/.test(line)) break;
    const match = line.match(/^\s+model:\s*(.*?)\s*(?:#.*)?$/);
    if (match?.[1] !== undefined) {
      const model = match[1].replace(/^['"]|['"]$/g, "").trim();
      return { model: model || DEFAULT_GRILL_MODEL };
    }
  }

  return { model: DEFAULT_GRILL_MODEL };
}

/** Explicit launch flags win over the repo config, which wins over the default. */
export async function resolveGrillModel(
  repo: string,
  override?: string,
): Promise<string> {
  if (override !== undefined && override.trim() !== "") return override;
  return (await loadGrillConfig(repo)).model;
}
