/**
 * Eye configuration (SPEC §11.7, ADR-0002 values): knobs read from the repo's
 * `.argus/config.yaml` with defaults in code. The file is the two-level
 * key/value subset `argus up` scaffolds — a full YAML parser is neither needed
 * nor wanted (zero runtime deps). Unknown keys and malformed values fall back
 * to defaults; a broken config file must never take an eye down.
 */
import { join } from "node:path";

export interface BrainConfig {
  model: string;
  reasoningEffort: string;
  /** Machine-wide cap on concurrent `codex exec` brains (ADR-0002: 2). */
  maxConcurrency: number;
}

export interface CadenceConfig {
  /** Fire after this much turn silence (ADR-0002 quiet window). */
  quietWindowSeconds: number;
  /** Fire at latest this long after the first pending turn (ADR-0002 cap). */
  maxWaitSeconds: number;
}

export interface EyesConfig {
  brain: BrainConfig;
  reviewer: CadenceConfig;
  digest: CadenceConfig;
}

export const DEFAULT_EYES_CONFIG: EyesConfig = {
  brain: {
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    maxConcurrency: 2,
  },
  reviewer: { quietWindowSeconds: 30, maxWaitSeconds: 300 },
  digest: { quietWindowSeconds: 30, maxWaitSeconds: 120 },
};

/** Parse the config subset: `section:` lines with `  key: value` children. */
function parseSections(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  let current: Map<string, string> | null = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, "  ");
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    const child = line.match(/^\s+([A-Za-z0-9_]+):\s*(.*)$/);
    if (child && current) {
      current.set(child[1]!, child[2]!.trim());
      continue;
    }
    const section = line.match(/^([A-Za-z0-9_]+):\s*$/);
    if (section) {
      current = new Map();
      sections.set(section[1]!, current);
      continue;
    }
    current = null; // anything else ends the section; stay lenient
  }
  return sections;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonEmpty(value: string | undefined, fallback: string): string {
  return value !== undefined && value.length > 0 ? value : fallback;
}

function cadence(
  section: Map<string, string> | undefined,
  defaults: CadenceConfig,
): CadenceConfig {
  return {
    quietWindowSeconds: positiveInteger(
      section?.get("quiet_window_seconds"),
      defaults.quietWindowSeconds,
    ),
    maxWaitSeconds: positiveInteger(
      section?.get("max_wait_seconds"),
      defaults.maxWaitSeconds,
    ),
  };
}

/** Load the repo's eye config; every missing or invalid value defaults. */
export async function loadEyesConfig(repo: string): Promise<EyesConfig> {
  const file = Bun.file(join(repo, ".argus", "config.yaml"));
  const sections = (await file.exists())
    ? parseSections(await file.text())
    : new Map<string, Map<string, string>>();
  const brain = sections.get("brain");
  const defaults = DEFAULT_EYES_CONFIG;
  return {
    brain: {
      model: nonEmpty(brain?.get("model"), defaults.brain.model),
      reasoningEffort: nonEmpty(
        brain?.get("reasoning_effort"),
        defaults.brain.reasoningEffort,
      ),
      maxConcurrency: positiveInteger(
        brain?.get("max_concurrency"),
        defaults.brain.maxConcurrency,
      ),
    },
    reviewer: cadence(sections.get("reviewer"), defaults.reviewer),
    digest: cadence(sections.get("digest"), defaults.digest),
  };
}
