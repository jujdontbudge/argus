/**
 * Eye configuration (SPEC §11.7, ADR-0002 values): knobs read from the repo's
 * `.argus/config.yaml` with defaults in code. The file is the small nested
 * key/value subset `argus up` scaffolds — a full YAML parser is neither needed
 * nor wanted (zero runtime deps). Unknown keys and malformed scalar values fall
 * back to defaults. Unsupported model slugs are the exception: SPEC §1 item 8
 * requires them to fail loudly before an unattended eye can incur API charges.
 */
import { join } from "node:path";

/**
 * List-visible models in Johan's ChatGPT subscription catalog on 2026-08-26.
 * Ticket #54 additionally exercised luna and sol through 153 real exec calls.
 * This is deliberately fail-closed: catalog churn requires an explicit update.
 */
const CHATGPT_SUBSCRIPTION_MODELS = new Set([
  "gpt-5.3-codex-spark",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
]);

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

/** The model knobs an individual judgment eye resolves after inheritance. */
export type EyeBrainConfig = Pick<BrainConfig, "model" | "reasoningEffort">;

export interface JudgmentEyeConfig extends CadenceConfig {
  brain: EyeBrainConfig;
}

/** The weekly curator pass the Reviewer triggers (SPEC §5.1, ticket #35). */
export interface CuratorConfig {
  enabled: boolean;
  /** Gate interval; Hermes' `curator.interval_hours` default is 168 (7 days). */
  intervalHours: number;
  staleAfterDays: number;
  archiveAfterDays: number;
}

/**
 * SPEC §7.3.3's dispatch cap — "Concurrency cap: **3**, a config knob
 * (`.argus/config.yaml`), raised only after the merge/verify loop proves
 * itself" (ticket #56).
 *
 * It lives beside `brain.max_concurrency` and is deliberately NOT the same
 * number: the brain cap budgets `codex exec` calls machine-wide, while this
 * one budgets concurrent WORKER SESSIONS in one repo. Conflating them was the
 * gap AUDIT.md §4 item 2 recorded — the file carried only the brain's budget,
 * so §7.3's cap existed in prose alone.
 */
export interface DispatchConfig {
  /** Concurrent dispatched ticket sessions per repo (SPEC §7.3.3: 3). */
  maxConcurrency: number;
}

export interface EyesConfig {
  brain: BrainConfig;
  reviewer: JudgmentEyeConfig;
  digest: JudgmentEyeConfig;
  retro: JudgmentEyeConfig;
  curator: CuratorConfig;
  dispatch: DispatchConfig;
}

export const DEFAULT_EYES_CONFIG: EyesConfig = {
  brain: {
    model: "gpt-5.6-luna",
    reasoningEffort: "low",
    maxConcurrency: 2,
  },
  reviewer: {
    brain: { model: "gpt-5.6-luna", reasoningEffort: "low" },
    quietWindowSeconds: 30,
    maxWaitSeconds: 300,
  },
  digest: {
    brain: { model: "gpt-5.6-luna", reasoningEffort: "low" },
    quietWindowSeconds: 30,
    maxWaitSeconds: 120,
  },
  // The slowest eye: it files tickets, not notes, and its git scan is the
  // one that must never race a half-finished commit sequence.
  retro: {
    brain: { model: "gpt-5.6-luna", reasoningEffort: "low" },
    quietWindowSeconds: 60,
    maxWaitSeconds: 600,
  },
  // Hermes' `curator:` block defaults (hermes_cli/config.py:1852-1884).
  curator: {
    enabled: true,
    intervalHours: 168,
    staleAfterDays: 30,
    archiveAfterDays: 90,
  },
  dispatch: { maxConcurrency: 3 },
};

/**
 * Parse the config subset: indented `section:` blocks with `key: value`
 * children. Dotted map keys represent nested subsections (`reviewer.brain`).
 */
function parseSections(text: string): Map<string, Map<string, string>> {
  const sections = new Map<string, Map<string, string>>();
  const stack: Array<{ indent: number; path: string }> = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\t/g, "  ");
    if (line.trim().length === 0 || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const content = line.trim();
    const section = content.match(/^([A-Za-z0-9_]+):\s*$/);
    if (section) {
      while (stack.length > 0 && stack.at(-1)!.indent >= indent) stack.pop();
      const parent = stack.at(-1);
      if (indent > 0 && parent === undefined) continue;
      const path = parent
        ? `${parent.path}.${section[1]!}`
        : section[1]!;
      stack.push({ indent, path });
      sections.set(path, new Map());
      continue;
    }
    const child = content.match(/^([A-Za-z0-9_]+):\s*(.+)$/);
    while (stack.length > 0 && stack.at(-1)!.indent >= indent) stack.pop();
    const current = stack.at(-1);
    if (child && current && indent > current.indent) {
      sections.get(current.path)!.set(child[1]!, child[2]!.trim());
      continue;
    }
    stack.length = 0; // anything else ends the section; stay lenient
  }
  return sections;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (/^(true|yes|on)$/i.test(value)) return true;
  if (/^(false|no|off)$/i.test(value)) return false;
  return fallback;
}

function nonEmpty(value: string | undefined, fallback: string): string {
  return value !== undefined && value.length > 0 ? value : fallback;
}

function subscriptionModel(
  value: string | undefined,
  fallback: string,
  configPath: string,
): string {
  const model = nonEmpty(value, fallback);
  if (!CHATGPT_SUBSCRIPTION_MODELS.has(model)) {
    throw new Error(
      `${configPath} '${model}' is not reachable via codex exec on the ChatGPT` +
        " subscription; refusing a model that could require metered API access",
    );
  }
  return model;
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

function judgmentEye(
  section: Map<string, string> | undefined,
  brainSection: Map<string, string> | undefined,
  defaults: JudgmentEyeConfig,
  inheritedBrain: EyeBrainConfig,
  configPath: string,
): JudgmentEyeConfig {
  return {
    brain: {
      model: subscriptionModel(
        brainSection?.get("model"),
        inheritedBrain.model,
        `${configPath}.brain.model`,
      ),
      reasoningEffort: nonEmpty(
        brainSection?.get("reasoning_effort"),
        inheritedBrain.reasoningEffort,
      ),
    },
    ...cadence(section, defaults),
  };
}

function curator(
  section: Map<string, string> | undefined,
  defaults: CuratorConfig,
): CuratorConfig {
  return {
    enabled: boolean(section?.get("enabled"), defaults.enabled),
    intervalHours: positiveInteger(
      section?.get("interval_hours"),
      defaults.intervalHours,
    ),
    staleAfterDays: positiveInteger(
      section?.get("stale_after_days"),
      defaults.staleAfterDays,
    ),
    archiveAfterDays: positiveInteger(
      section?.get("archive_after_days"),
      defaults.archiveAfterDays,
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
  const resolvedBrain: BrainConfig = {
    model: subscriptionModel(
      brain?.get("model"),
      defaults.brain.model,
      "brain.model",
    ),
    reasoningEffort: nonEmpty(
      brain?.get("reasoning_effort"),
      defaults.brain.reasoningEffort,
    ),
    maxConcurrency: positiveInteger(
      brain?.get("max_concurrency"),
      defaults.brain.maxConcurrency,
    ),
  };
  const inheritedBrain: EyeBrainConfig = {
    model: resolvedBrain.model,
    reasoningEffort: resolvedBrain.reasoningEffort,
  };
  return {
    brain: resolvedBrain,
    reviewer: judgmentEye(
      sections.get("reviewer"),
      sections.get("reviewer.brain"),
      defaults.reviewer,
      inheritedBrain,
      "reviewer",
    ),
    digest: judgmentEye(
      sections.get("digest"),
      sections.get("digest.brain"),
      defaults.digest,
      inheritedBrain,
      "digest",
    ),
    retro: judgmentEye(
      sections.get("retro"),
      sections.get("retro.brain"),
      defaults.retro,
      inheritedBrain,
      "retro",
    ),
    curator: curator(sections.get("curator"), defaults.curator),
    dispatch: {
      maxConcurrency: positiveInteger(
        sections.get("dispatch")?.get("max_concurrency"),
        defaults.dispatch.maxConcurrency,
      ),
    },
  };
}
