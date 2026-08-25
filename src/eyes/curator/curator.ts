/**
 * The curator pass (SPEC §5.1, ticket #35) — the weekly hygiene half of the
 * Reviewer's self-improvement loop. Creation and update are the Reviewer's
 * ordinary work; retirement is this.
 *
 * It is a PASS INSIDE THE REVIEWER, not a sixth watcher: the supervisor runs
 * five eyes deliberately, so the trigger is `maybeRunCurator`, which the
 * Reviewer calls after every evaluation and which the 7-day gate almost
 * always answers with "not yet".
 *
 * Phase order, lifted from `run_curator_review()` (`agent/curator.py:1407-1609`):
 *
 *   0. snapshot the stores (skipped on dry-run, never fatal)
 *   1. scan skills + memory
 *   2. deterministic 30/90 transitions over the usage sidecar
 *   3. execute the archive decisions
 *   4. the LLM consolidation pass over what survived
 *   5. execute its decisions — the EYE moves files, the brain only judges
 *   6. converge the memory index, and write the report
 *
 * Two deliberate departures from the native curator, both because it is
 * skills-only and the memory half is new spec:
 *
 * - Facts are never archived by the clock. A durable project fact is READ
 *   constantly and written once; an mtime 90 days old means it was right the
 *   first time, not that it is dead. Fact staleness is computed, shown to the
 *   brain and reported, but only a reasoned merge/prune decision retires one.
 * - A failed brain does not fail the pass. The deterministic tier and the
 *   snapshot already landed, so the error goes in the report and the gate
 *   still advances — a broken `codex` must not turn a weekly pass into a
 *   per-turn retry storm.
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Brain } from "../brain";
import type { BrainCap } from "../cap";
import type { CuratorConfig } from "../config";
import { repairMemoryIndex } from "../reviewer/outputs";
import type { GitRunner } from "../retro/git";
import { archiveFact, archiveSkill } from "./archive";
import { snapshotArgusState } from "./backup";
import { buildCuratorPrompt, type PromptFact, type PromptSkill } from "./prompt";
import { emptyReport, writeReport, type CuratorRunReport } from "./report";
import { scanMemory, scanSkills, type FactCandidate, type SkillCandidate } from "./scan";
import { CURATOR_OUTPUT_SCHEMA, parseCuratorVerdict, type CuratorVerdict } from "./schema";
import { recordRun, shouldRunNow, type GateReason } from "./state";
import {
  applyAutomaticTransitions,
  DEFAULT_THRESHOLDS,
  type TransitionThresholds,
} from "./transitions";
import { emptyRecord, readUsage, writeUsage, type LockOptions, type UsageSidecar } from "./usage";

const DAY_MS = 86_400_000;

/** Ensure the stores exist before a pass writes into them. */
export async function ensureStores(repo: string): Promise<void> {
  await mkdir(join(repo, ".argus/skills"), { recursive: true });
  await mkdir(join(repo, ".argus/memory"), { recursive: true });
}

export interface CuratorPassOptions {
  /** Repo root; every store hangs off its `.argus/`. */
  repo: string;
  brain: Brain;
  cap: BrainCap;
  /** Epoch ms; injected so a pass is reproducible. */
  now: number;
  /** Report-only: judge everything, move nothing, bump nothing. */
  dryRun?: boolean;
  thresholds?: TransitionThresholds;
  /** Injectable git for the snapshot. */
  run?: GitRunner;
  lock?: LockOptions;
}

export interface CuratorPassResult {
  report: CuratorRunReport;
  reportDirectory: string;
  summary: string;
}

function idleDays(now: number, at: number): number {
  return Math.floor((now - at) / DAY_MS);
}

/**
 * Replace a skill body while keeping its frontmatter: the brain writes prose,
 * not headers, and a consolidation must never cost a skill its `name:`.
 */
async function rewriteSkillBody(dir: string, body: string): Promise<void> {
  const path = join(dir, "SKILL.md");
  if (body.trimStart().startsWith("---")) {
    await Bun.write(path, body.endsWith("\n") ? body : `${body}\n`);
    return;
  }
  const existing = await Bun.file(path).text();
  const frontmatter = existing.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
  await Bun.write(
    path,
    `${frontmatter ? frontmatter[0] : ""}\n${body.replace(/\n*$/, "")}\n`,
  );
}

export async function runCuratorPass(
  options: CuratorPassOptions,
): Promise<CuratorPassResult> {
  const dryRun = options.dryRun ?? false;
  const thresholds = options.thresholds ?? DEFAULT_THRESHOLDS;
  const at = new Date(options.now).toISOString();
  const skillsDir = join(options.repo, ".argus/skills");
  const memoryDir = join(options.repo, ".argus/memory");
  const report = emptyReport(at);
  report.dry_run = dryRun;
  await ensureStores(options.repo);

  // Phase 0 — the rollback point. Best-effort: a failed snapshot is reported,
  // never fatal (`agent/curator.py:1452-1462`).
  if (dryRun) {
    report.backup = { ok: false, reason: "dry run: no snapshot taken" };
  } else {
    report.backup = await snapshotArgusState({
      repo: options.repo,
      at,
      ...(options.run !== undefined && { run: options.run }),
    });
    if (!report.backup.ok) {
      report.errors.push(`snapshot failed: ${report.backup.reason ?? "unknown"}`);
    }
  }

  // Phase 1 — what exists.
  const skills = await scanSkills(skillsDir);
  const memory = await scanMemory(memoryDir);
  report.candidates = { skills: skills.length, facts: memory.facts.length };
  report.orphans = memory.orphans;

  // Phase 2 — the deterministic tier.
  const before = await readUsage(skillsDir);
  const { sidecar, transitions, decisions } = applyAutomaticTransitions(
    before,
    skills.map(({ name }) => name),
    { now: options.now, ...thresholds },
  );
  report.transitions = transitions;
  if (!dryRun) await writeUsage(skillsDir, sidecar);

  // Phase 3 — execute them.
  const byName = new Map<string, SkillCandidate>(
    skills.map((candidate) => [candidate.name, candidate]),
  );
  const retired = new Set<string>();
  for (const name of decisions.archive) {
    const candidate = byName.get(name);
    if (!candidate) continue;
    const idle = transitions.find((transition) => transition.name === name)?.idleDays;
    const reason = `${idle ?? thresholds.archiveAfterDays} days idle`;
    retired.add(name);
    if (dryRun) {
      report.archived.skills.push({
        name,
        from: candidate.dir,
        to: join(skillsDir, ".archive", name),
        reason,
      });
      continue;
    }
    report.archived.skills.push(
      await archiveSkill({
        skillsDir,
        dir: candidate.dir,
        name,
        at,
        reason,
        ...(options.lock !== undefined && { lock: options.lock }),
      }),
    );
  }

  // Phase 4 — the consolidation pass over what survived. Pinned skills are
  // not shown to the brain at all: the bypass is structural, not a rule the
  // model is trusted to follow.
  const live = skills.filter(
    (candidate) => !retired.has(candidate.name) && !sidecar[candidate.name]?.pinned,
  );
  const promptSkills: PromptSkill[] = live.map((candidate) => {
    const record = sidecar[candidate.name] ?? emptyRecord(at);
    const transition = transitions.find(({ name }) => name === candidate.name);
    return {
      name: candidate.name,
      description: candidate.description,
      relative: candidate.relative,
      state: record.state,
      idleDays: transition?.idleDays ?? null,
      useCount: record.use_count,
      viewCount: record.view_count,
      patchCount: record.patch_count,
      supportFiles: candidate.supportFiles,
    };
  });
  const promptFacts: PromptFact[] = memory.facts.map((fact) => ({
    slug: fact.slug,
    title: fact.title,
    idleDays: idleDays(options.now, fact.touchedAt),
    indexed: fact.indexed,
  }));

  let verdict: CuratorVerdict | null = null;
  if (promptSkills.length > 0 || promptFacts.length > 0) {
    const release = await options.cap.acquire();
    try {
      const outcome = await options.brain.evaluate({
        prompt: buildCuratorPrompt({
          skills: promptSkills,
          facts: promptFacts,
          orphans: memory.orphans,
          dryRun,
        }),
        schema: CURATOR_OUTPUT_SCHEMA,
        cwd: options.repo,
      });
      if (!outcome.ok) {
        report.errors.push(`brain ${outcome.reason}: ${outcome.detail}`);
      } else {
        verdict = parseCuratorVerdict(outcome.text);
        if (verdict === null) {
          report.errors.push(`brain schema miss: ${outcome.text.slice(0, 500)}`);
        }
      }
    } finally {
      await release();
    }
  }

  // Phase 5 — execute the brain's decisions. Every name is checked against
  // what actually exists and against the pinned bypass first.
  if (verdict) {
    report.llm = {
      ran: true,
      summary: verdict.summary,
      consolidations: verdict.consolidations.map(({ from, into, reason }) => ({
        from,
        into,
        reason,
      })),
      prunings: verdict.prunings,
      rejected: [],
    };
    await applyVerdict({
      verdict,
      report,
      skillsDir,
      memoryDir,
      live,
      facts: memory.facts,
      sidecar,
      at,
      dryRun,
      ...(options.lock !== undefined && { lock: options.lock }),
    });
  }

  // Phase 6 — the index converges to the fact files (§5.1 orphan repair).
  if (!dryRun) await repairMemoryIndex(memoryDir);

  report.finished_at = new Date(options.now).toISOString();
  const summary =
    `${report.archived.skills.length} skill(s) archived, ` +
    `${report.archived.facts.length} fact(s) archived, ` +
    `${report.errors.length} error(s)`;
  const written = await writeReport(options.repo, report);
  return { report, reportDirectory: written.directory, summary };
}

interface ApplyVerdictInput {
  verdict: CuratorVerdict;
  report: CuratorRunReport;
  skillsDir: string;
  memoryDir: string;
  live: SkillCandidate[];
  facts: FactCandidate[];
  sidecar: UsageSidecar;
  at: string;
  dryRun: boolean;
  lock?: LockOptions;
}

async function applyVerdict(input: ApplyVerdictInput): Promise<void> {
  const { report, verdict } = input;
  const byName = new Map(input.live.map((candidate) => [candidate.name, candidate]));
  const factSlugs = new Set(input.facts.map(({ slug }) => slug));
  const reject = (what: string, reason: string): void => {
    report.llm.rejected.push({ what, reason });
  };

  const retire = async (
    candidate: SkillCandidate,
    reason: string,
    absorbedInto?: string,
  ): Promise<void> => {
    if (input.dryRun) {
      report.archived.skills.push({
        name: candidate.name,
        from: candidate.dir,
        to: join(input.skillsDir, ".archive", candidate.name),
        reason,
        ...(absorbedInto !== undefined && { absorbedInto }),
      });
      return;
    }
    report.archived.skills.push(
      await archiveSkill({
        skillsDir: input.skillsDir,
        dir: candidate.dir,
        name: candidate.name,
        at: input.at,
        reason,
        ...(absorbedInto !== undefined && { absorbedInto }),
        ...(input.lock !== undefined && { lock: input.lock }),
      }),
    );
  };

  for (const entry of verdict.consolidations) {
    const what = `consolidation ${entry.from} → ${entry.into}`;
    const from = byName.get(entry.from);
    const into = byName.get(entry.into);
    if (input.sidecar[entry.from]?.pinned || input.sidecar[entry.into]?.pinned) {
      reject(what, "pinned skill");
      continue;
    }
    if (!from) {
      reject(what, `unknown skill: ${entry.from}`);
      continue;
    }
    if (!into) {
      reject(what, `unknown skill: ${entry.into}`);
      continue;
    }
    if (entry.body !== undefined && !input.dryRun) {
      await rewriteSkillBody(into.dir, entry.body);
    }
    await retire(from, entry.reason, into.name);
  }

  for (const entry of verdict.prunings) {
    const what = `pruning ${entry.name}`;
    if (input.sidecar[entry.name]?.pinned) {
      reject(what, "pinned skill");
      continue;
    }
    const candidate = byName.get(entry.name);
    if (!candidate) {
      reject(what, `unknown skill: ${entry.name}`);
      continue;
    }
    await retire(candidate, entry.reason);
  }

  const retireFact = async (slug: string, reason: string): Promise<void> => {
    if (input.dryRun) {
      report.archived.facts.push({
        slug,
        to: join(input.memoryDir, ".archive", `${slug}.md`),
        reason,
      });
      return;
    }
    const moved = await archiveFact(input.memoryDir, slug, { at: input.at });
    report.archived.facts.push({ slug, to: moved.to, reason });
  };

  for (const entry of verdict.memory.merges) {
    const what = `memory merge ${entry.from} → ${entry.into}`;
    if (!factSlugs.has(entry.from)) {
      reject(what, `unknown fact: ${entry.from}`);
      continue;
    }
    if (!factSlugs.has(entry.into)) {
      reject(what, `unknown fact: ${entry.into}`);
      continue;
    }
    await retireFact(entry.from, entry.reason);
  }

  for (const entry of verdict.memory.prunings) {
    if (!factSlugs.has(entry.slug)) {
      reject(`memory pruning ${entry.slug}`, `unknown fact: ${entry.slug}`);
      continue;
    }
    await retireFact(entry.slug, entry.reason);
  }
}

export interface MaybeRunCuratorOptions {
  repo: string;
  brain: Brain;
  cap: BrainCap;
  now: number;
  config: CuratorConfig;
  dryRun?: boolean;
  run?: GitRunner;
  lock?: LockOptions;
}

export interface CuratorTriggerResult {
  ran: boolean;
  reason: GateReason;
  result?: CuratorPassResult;
}

/**
 * The Reviewer's trigger point. Called on every debounced invocation; the
 * gate — not the caller — decides whether a pass happens, and a dry run
 * never bumps it (`agent/curator.py:1478-1483`).
 */
export async function maybeRunCurator(
  options: MaybeRunCuratorOptions,
): Promise<CuratorTriggerResult> {
  const decision = await shouldRunNow(options.repo, {
    now: options.now,
    intervalHours: options.config.intervalHours,
    enabled: options.config.enabled,
  });
  if (!decision.run) return { ran: false, reason: decision.reason };

  const result = await runCuratorPass({
    repo: options.repo,
    brain: options.brain,
    cap: options.cap,
    now: options.now,
    thresholds: {
      staleAfterDays: options.config.staleAfterDays,
      archiveAfterDays: options.config.archiveAfterDays,
    },
    ...(options.dryRun !== undefined && { dryRun: options.dryRun }),
    ...(options.run !== undefined && { run: options.run }),
    ...(options.lock !== undefined && { lock: options.lock }),
  });
  if (!(options.dryRun ?? false)) {
    await recordRun(options.repo, {
      at: new Date(options.now).toISOString(),
      summary: result.summary,
      reportPath: result.reportDirectory.slice(options.repo.length + 1),
    });
  }
  return { ran: true, reason: decision.reason, result };
}
