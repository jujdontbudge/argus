/**
 * The Retro eye (SPEC §5.5, ticket #33): everything-is-a-ticket enforcement.
 *
 * It watches two signals — git (commits and working-tree changes no
 * registered ticket session covers) and the transcript (a digest whose
 * session claimed no ticket) — and for work that is real implementation it
 * files a CLOSED, `retro`-labeled sub-issue of the nearest plausible parent.
 * There is no approval queue: §5.5 is explicit that a wrong retro is cheap to
 * edit and a missing one breaks the record.
 *
 * Division of labour, deliberately narrow at the top:
 *
 * - the REGISTRY decides what is covered (./attribution.ts),
 * - the BRAIN decides only whether implementation happened and what to call it
 *   (./schema.ts),
 * - the EYE composes every written word from evidence (./compose.ts) and
 *   validates the parent against tickets that exist (./parent.ts).
 *
 * Failure posture (ADR-0001): the eye never crashes on tracker trouble and
 * never loses the record. With no tracker — or with `gh` refusing — the
 * composed retro is written into the session's digest (or, with no digest, to
 * `.argus/eyes/retro/unfiled/`) and the degradation is audited LOUDLY.
 */
import { mkdir, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { hashText } from "../../matching";
import {
  loadRegistry,
  registryPaths,
  type ProvenanceRecord,
  type SessionRecord,
} from "../../provenance";
import { fileAlertEmitter, retryForever, type StuckAlert } from "../backpressure";
import { createCodexBrain, type Brain } from "../brain";
import { createBrainCap, defaultBrainSlotsDirectory, type BrainCap } from "../cap";
import { Coalescer, type CoalesceWindow } from "../coalesce";
import { loadEyesConfig, type CadenceConfig } from "../config";
import { applyDigestUpdate, listDigests } from "../digest/outputs";
import { attributeChanges, referencedTickets } from "./attribution";
import { composeRetro, type RetroPrompt } from "./compose";
import { resolvePath, scanGit, type GitRunner, type GitScan } from "./git";
import { detectTracker, type GhRunner, type Tracker, type TrackerIssue } from "./gh";
import { resolveParent, type ParentRule } from "./parent";
import {
  parseRetroVerdict,
  RETRO_OUTPUT_SCHEMA,
  type RetroJudgment,
  type RetroVerdict,
} from "./schema";
import { buildSignals, type RetroSignal } from "./signal";

export type { ProvenanceRecord } from "../../provenance";

/** What one detected signal ended up as. */
export interface RetroFiling {
  signalId: string;
  title: string;
  /** `filed` reached the tracker; `digest-note` is the loud degradation. */
  outcome: "filed" | "digest-note";
  issue?: string;
  parent: string | null;
  parentRule: ParentRule;
  /** Why it degraded, when it did. */
  reason?: string;
}

/** Everything the eye surfaces loudly; nothing here is ever swallowed. */
export type RetroAudit =
  | { type: "retro-filed"; signalId: string; issue: string; parent: string | null; rule: ParentRule }
  | { type: "retro-unlinked"; signalId: string; issue: string; parent: string; reason: string }
  | {
      type: "retro-file-failed";
      signalId: string;
      title: string;
      reason: string;
      where: string;
    }
  | { type: "tracker-less"; signalId: string; title: string; where: string };

export interface SessionObservation {
  sessionId: string;
  /** The checkout the session is running in (session-meta `cwd`). */
  cwd: string;
}

export interface RetroEyeOptions {
  /** Repo root; state, digests and the git scan all hang off it. */
  repo: string;
  brain: Brain;
  cap: BrainCap;
  cadence: CadenceConfig;
  /** gh seam — tests pass a fake; nothing else may reach GitHub. */
  gh?: GhRunner;
  /** git seam (the default runs the real CLI). */
  git?: GitRunner;
  /** Registry supplier; defaults to this repo's `.argus/registry/`. */
  sessions?: () => Promise<SessionRecord[]>;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Stuck-alert sink; defaults to a §6 event file in `.argus/events/`. */
  onAlert?: (alert: StuckAlert) => void | Promise<void>;
  /** Audit sink; defaults to stderr — degradation must be visible. */
  onAudit?: (audit: RetroAudit) => void | Promise<void>;
  baseDelayMs?: number;
  maxDelayMs?: number;
  stuckAfterMs?: number;
}

/** A Johan-authored turn kept as retro evidence until its work is filed. */
interface StoredPrompt {
  sessionId: string;
  ts: string;
  text: string;
}

interface PersistedState {
  /** Johan-authored prompts per session, newest last (bounded). */
  prompts: StoredPrompt[];
  window: CoalesceWindow | null;
  /** The git cursor: commit shas already reported. */
  seen: string[];
  /** signalId → issue number, or "not-implementation" / "unfiled". */
  judged: Record<string, string>;
  /** Sessions that already have a retro; a digest growing is not a new one. */
  filedSessions: string[];
  /** sessionId → observed cwd. */
  sessionDirs: Record<string, string>;
  /** checkout → fingerprint of the working tree already reported for it. */
  workingTrees: Record<string, string>;
  /** True once the cursor has been anchored at the repo's current HEADs. */
  primed: boolean;
}

/**
 * A FUNCTION, never a shared constant: the eye mutates its state in place, so
 * a shared default object would let two eyes in one process (two repos, or a
 * restart in the same process) alias each other's cursors and filed ledgers.
 */
function emptyState(): PersistedState {
  return {
    prompts: [],
    window: null,
    seen: [],
    judged: {},
    filedSessions: [],
    sessionDirs: {},
    workingTrees: {},
    primed: false,
  };
}

/** The default audit sink's wording: what a human tailing the watcher reads. */
export function describeAudit(audit: RetroAudit): string {
  switch (audit.type) {
    case "retro-filed":
      return (
        `RETRO: filed #${audit.issue}` +
        (audit.parent === null
          ? " at root level"
          : ` as a sub-issue of #${audit.parent}`) +
        ` (rule: ${audit.rule}, signal ${audit.signalId})`
      );
    case "retro-unlinked":
      return (
        `RETRO: #${audit.issue} was filed but NOT linked under #${audit.parent}: ` +
        audit.reason
      );
    case "retro-file-failed":
      return (
        `RETRO UNFILED: "${audit.title}" could not be filed (${audit.reason}); ` +
        `written to ${audit.where} instead`
      );
    case "tracker-less":
      return (
        `TRACKER-LESS MODE: no GitHub tracker for this repo; retro ` +
        `"${audit.title}" written to ${audit.where} instead of a ticket`
      );
  }
}

/** Evidence, not an archive: the newest prompts are the ones that explain. */
const MAX_PROMPTS = 200;
const NOT_IMPLEMENTATION = "not-implementation";
const UNFILED = "unfiled";

function truncate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}…`;
}

function describeSignal(
  signal: RetroSignal,
  prompts: readonly StoredPrompt[],
): string {
  const lines: string[] = [
    `[signal=${signal.id} sources=${signal.sources.join(",")} dir=${signal.dir ?? "unknown"}]`,
  ];
  const changes = signal.changes;
  if (changes && changes.commits.length > 0) {
    lines.push("commits:");
    for (const commit of changes.commits) {
      lines.push(
        `- ${commit.sha.slice(0, 7)} ${commit.subject} (files: ${commit.files.join(", ")})`,
      );
    }
  }
  if (changes?.workingTree) {
    lines.push(`uncommitted: ${changes.workingTree.files.join(", ")}`);
  }
  for (const session of signal.sessions) {
    if (session.narrative === undefined) continue;
    lines.push(
      `digest(${session.sessionId}, ${session.agent ?? "unknown"}): ` +
        truncate(session.narrative.replace(/\n+/g, " ").trim(), 1_200),
    );
  }
  const relevant = prompts.filter((prompt) =>
    signal.sessions.some((session) => session.sessionId === prompt.sessionId),
  );
  if (relevant.length > 0) {
    lines.push("johan-prompts:");
    for (const prompt of relevant) lines.push(`- ${truncate(prompt.text, 500)}`);
  }
  return lines.join("\n");
}

function buildPrompt(
  signals: readonly RetroSignal[],
  prompts: readonly StoredPrompt[],
  candidates: readonly TrackerIssue[],
): string {
  return [
    "You are the Argus Retro eye. Each block below is work in this repo that",
    "no registered ticket session covers. Decide, per block, whether real",
    "IMPLEMENTATION happened — code or configuration actually written or",
    "changed — as opposed to planning, grilling, reading or note-taking.",
    "Do not run any commands; judge only from the blocks.",
    "",
    "Emit JSON matching the output schema, one entry per signal id:",
    '- implementation: true only when something was actually implemented.',
    "- what: a short phrase naming what was done, for the title `Retro: <what>`.",
    "- summary: two or three sentences on what happened.",
    "- parentTicket: the number of the nearest plausible parent from the",
    "  candidate list below, or null when none plausibly covers this work.",
    "  Never invent a number that is not listed.",
    "",
    ...signals.map((signal) => `${describeSignal(signal, prompts)}\n`),
    "## candidate parent tickets",
    "",
    ...(candidates.length > 0
      ? candidates.map((issue) => `- #${issue.number} ${issue.title}`)
      : ["- (none open)"]),
  ].join("\n");
}

export class RetroEye {
  private state: PersistedState;
  private readonly coalescer: Coalescer;
  private readonly now: () => number;
  private readonly statePath: string;
  private readonly sessionsDir: string;
  private readonly loadSessions: () => Promise<SessionRecord[]>;
  private readonly onAlert: (alert: StuckAlert) => void | Promise<void>;
  private readonly onAudit: (audit: RetroAudit) => void | Promise<void>;
  private scanning = false;

  private constructor(
    private readonly options: RetroEyeOptions,
    state: PersistedState,
  ) {
    this.state = state;
    this.coalescer = new Coalescer(options.cadence, state.window);
    this.now = options.now ?? Date.now;
    this.statePath = join(options.repo, ".argus/eyes/retro/state.json");
    this.sessionsDir = join(options.repo, ".argus/sessions");
    this.loadSessions =
      options.sessions ??
      (async () => (await loadRegistry(registryPaths(options.repo))).sessions);
    this.onAlert =
      options.onAlert ?? fileAlertEmitter(join(options.repo, ".argus/events"));
    this.onAudit =
      options.onAudit ??
      ((audit) => {
        // Loud by default: a degraded retro a human never sees is a lost one.
        const line = describeAudit(audit);
        if (audit.type === "retro-filed") console.log(line);
        else console.error(line);
      });
  }

  static async open(options: RetroEyeOptions): Promise<RetroEye> {
    const statePath = join(options.repo, ".argus/eyes/retro/state.json");
    let state = emptyState();
    const file = Bun.file(statePath);
    if (await file.exists()) {
      try {
        const raw = (await file.json()) as Partial<PersistedState>;
        state = {
          prompts: Array.isArray(raw.prompts) ? raw.prompts : [],
          window: raw.window ?? null,
          seen: Array.isArray(raw.seen) ? raw.seen : [],
          judged: raw.judged ?? {},
          filedSessions: Array.isArray(raw.filedSessions) ? raw.filedSessions : [],
          sessionDirs: raw.sessionDirs ?? {},
          workingTrees: raw.workingTrees ?? {},
          primed: raw.primed === true,
        };
      } catch {
        // Torn state: the atomic writer makes this near-impossible, and an
        // unreadable file must not take the eye down. It re-primes instead,
        // which costs a cursor reset, never a duplicate retro (ids are
        // content-derived and `judged` is what stops re-filing).
      }
    }
    return new RetroEye(options, state);
  }

  /**
   * Anchor the git cursor at the repo's current HEADs. History that predates
   * the eye is not rogue work — it is history — so a fresh install never
   * files a retro for the repo it was just switched on in.
   */
  async prime(): Promise<void> {
    const scan = await scanGit({
      repo: this.options.repo,
      seen: this.state.seen,
      ...(this.options.git !== undefined && { run: this.options.git }),
    });
    this.state.seen = scan.seen;
    this.cursorWorkingTrees(scan);
    this.state.primed = true;
    await this.persist();
  }

  /**
   * The working tree is a cursor, not a standing accusation. A checkout that
   * was already dirty when the eye started watching — `argus up` scaffolding
   * nobody committed, a half-finished edit from last week — is the state of
   * the world, not rogue work. Only a tree that CHANGED since the last scan
   * is a signal.
   */
  private cursorWorkingTrees(scan: GitScan): GitScan {
    return {
      ...scan,
      roots: scan.roots.map((root) => {
        if (root.workingTree === null) return root;
        const fingerprint = hashText(
          [root.workingTree.files.join("\n"), root.workingTree.diff].join("\n--\n"),
        );
        const reported = this.state.workingTrees[root.dir] === fingerprint;
        this.state.workingTrees[root.dir] = fingerprint;
        return reported ? { ...root, workingTree: null } : root;
      }),
    };
  }

  /** A session was seen running in a checkout (session-meta `cwd`). */
  observeSession(observation: SessionObservation): void {
    this.state.sessionDirs[observation.sessionId] = observation.cwd;
  }

  /** Johan-authored turns arrive as retro evidence; nothing else is kept. */
  async ingest(records: readonly ProvenanceRecord[]): Promise<void> {
    const at = this.now();
    let noted = false;
    for (const record of records) {
      if (record.author !== "johan") continue; // §5.5 body: Johan's prompts
      this.state.prompts.push({
        sessionId: record.sessionId,
        ts: record.ts,
        text: record.text,
      });
      this.coalescer.note(at);
      noted = true;
    }
    if (this.state.prompts.length > MAX_PROMPTS) {
      this.state.prompts = this.state.prompts.slice(-MAX_PROMPTS);
    }
    if (noted) await this.persist();
  }

  /** Epoch ms of the next due scan, or null when nothing is pending. */
  dueAt(): number | null {
    return this.coalescer.dueAt();
  }

  /** Run a scan if the cadence says it is due. */
  async tick(): Promise<RetroFiling[]> {
    if (!this.coalescer.shouldFire(this.now())) return [];
    return this.scan();
  }

  /**
   * One full detection pass: scan git, attribute against the registry, fold
   * in the digests, judge, and file. Safe to call directly (the watcher loop
   * runs it on the cadence); never throws for tracker trouble.
   */
  async scan(): Promise<RetroFiling[]> {
    if (this.scanning) return [];
    // A watcher that starts ticking without priming must not accuse the repo
    // of its own history: the first scan anchors the cursor and reports
    // nothing, exactly as an explicit prime() would.
    if (!this.state.primed) {
      await this.prime();
      return [];
    }
    this.scanning = true;
    try {
      const scan = await scanGit({
        repo: this.options.repo,
        seen: this.state.seen,
        ...(this.options.git !== undefined && { run: this.options.git }),
      });
      // git reports resolved paths, so every path compared against a checkout
      // — registry workspaces, observed session cwds — is resolved too.
      const sessions = await Promise.all(
        (await this.loadSessions()).map(async (session) =>
          session.workspace === undefined
            ? session
            : { ...session, workspace: await resolvePath(session.workspace) },
        ),
      );
      const sessionDirs = new Map(
        await Promise.all(
          Object.entries(this.state.sessionDirs).map(
            async ([sessionId, cwd]) =>
              [sessionId, await resolvePath(cwd)] as const,
          ),
        ),
      );
      const attribution = attributeChanges(this.cursorWorkingTrees(scan), {
        sessions,
        sessionDirs,
      });
      const digests = await listDigests(this.sessionsDir);
      const signals = buildSignals({ attribution, digests, sessionDirs, sessions }).filter(
        (signal) => this.isFresh(signal),
      );

      // The cursor advances even when nothing is rogue: reported commits are
      // reported. What stops a re-file is `judged`, not the cursor.
      this.state.seen = scan.seen;
      this.coalescer.flush();

      if (signals.length === 0) {
        await this.persist();
        return [];
      }

      const tracker = await detectTracker(this.options.repo, this.options.gh);
      const candidates = tracker ? await tracker.openTickets() : [];
      const verdict = await retryForever(
        () => this.evaluateOnce(signals, candidates),
        {
          eye: "retro",
          onAlert: this.onAlert,
          ...(this.options.baseDelayMs !== undefined && {
            baseDelayMs: this.options.baseDelayMs,
          }),
          ...(this.options.maxDelayMs !== undefined && {
            maxDelayMs: this.options.maxDelayMs,
          }),
          ...(this.options.stuckAfterMs !== undefined && {
            stuckAfterMs: this.options.stuckAfterMs,
          }),
          now: this.now,
          ...(this.options.sleep !== undefined && { sleep: this.options.sleep }),
        },
      );

      const filings: RetroFiling[] = [];
      const bySignal = new Map(signals.map((signal) => [signal.id, signal]));
      for (const judgment of verdict.retros) {
        const signal = bySignal.get(judgment.signalId);
        if (signal === undefined) continue; // the eye decides what exists, not the brain
        if (!judgment.implementation) {
          this.state.judged[signal.id] = NOT_IMPLEMENTATION;
          continue;
        }
        filings.push(
          await this.file(signal, judgment, tracker, candidates, scan.repoRoot),
        );
      }
      await this.persist();
      return filings;
    } finally {
      this.scanning = false;
    }
  }

  /** A signal is fresh unless it was judged, or its session already retro'd. */
  private isFresh(signal: RetroSignal): boolean {
    if (this.state.judged[signal.id] !== undefined) return false;
    if (signal.sources.length === 1 && signal.sources[0] === "transcript") {
      return !signal.sessions.some((session) =>
        this.state.filedSessions.includes(session.sessionId),
      );
    }
    return true;
  }

  /** One brain attempt under the machine-wide cap; throws to trigger retry. */
  private async evaluateOnce(
    signals: readonly RetroSignal[],
    candidates: readonly TrackerIssue[],
  ): Promise<RetroVerdict> {
    const release = await this.options.cap.acquire();
    try {
      const outcome = await this.options.brain.evaluate({
        prompt: buildPrompt(signals, this.state.prompts, candidates),
        schema: RETRO_OUTPUT_SCHEMA,
        cwd: this.options.repo,
      });
      if (!outcome.ok) throw new Error(`brain ${outcome.reason}: ${outcome.detail}`);
      const verdict = parseRetroVerdict(outcome.text);
      if (verdict === null) {
        throw new Error(`brain schema miss: ${outcome.text.slice(0, 500)}`);
      }
      return verdict;
    } finally {
      await release();
    }
  }

  private async file(
    signal: RetroSignal,
    judgment: RetroJudgment,
    tracker: Tracker | null,
    candidates: readonly TrackerIssue[],
    repoRoot: string,
  ): Promise<RetroFiling> {
    const prompts: RetroPrompt[] = this.state.prompts
      .filter((prompt) =>
        signal.sessions.some((session) => session.sessionId === prompt.sessionId),
      )
      .map((prompt) => ({ ...prompt, author: "johan" as const }));
    // Johan's own prompts can name the ticket his work belongs under.
    const promptTickets = prompts.flatMap((prompt) => referencedTickets(prompt.text));
    const parent = resolveParent({
      sessionTickets: signal.sessionTickets,
      referencedTickets: [...signal.referencedTickets, ...promptTickets],
      brainChoice: judgment.parentTicket,
      candidates,
    });
    const composition = composeRetro({
      what: judgment.what,
      summary: judgment.summary,
      signal,
      prompts,
      parent,
      repoRoot,
    });

    if (tracker === null) {
      const where = await this.writeDigestNote(signal, composition.title, composition.body);
      await this.onAudit({
        type: "tracker-less",
        signalId: signal.id,
        title: composition.title,
        where,
      });
      this.state.judged[signal.id] = UNFILED;
      this.rememberSessions(signal);
      return {
        signalId: signal.id,
        title: composition.title,
        outcome: "digest-note",
        parent: parent.parent,
        parentRule: parent.rule,
        reason: "tracker-less mode: no GitHub tracker for this repo",
      };
    }

    const filed = await tracker.fileRetro({
      title: composition.title,
      body: composition.body,
      parent: parent.parent,
    });
    if (!filed.ok) {
      const where = await this.writeDigestNote(signal, composition.title, composition.body);
      await this.onAudit({
        type: "retro-file-failed",
        signalId: signal.id,
        title: composition.title,
        reason: filed.reason,
        where,
      });
      this.state.judged[signal.id] = UNFILED;
      this.rememberSessions(signal);
      return {
        signalId: signal.id,
        title: composition.title,
        outcome: "digest-note",
        parent: parent.parent,
        parentRule: parent.rule,
        reason: filed.reason,
      };
    }

    if (parent.parent !== null && !filed.linked) {
      await this.onAudit({
        type: "retro-unlinked",
        signalId: signal.id,
        issue: filed.number,
        parent: parent.parent,
        reason: filed.linkError ?? "sub-issue link did not complete",
      });
    }
    await this.onAudit({
      type: "retro-filed",
      signalId: signal.id,
      issue: filed.number,
      parent: parent.parent,
      rule: parent.rule,
    });
    this.state.judged[signal.id] = filed.number;
    this.rememberSessions(signal);
    return {
      signalId: signal.id,
      title: composition.title,
      outcome: "filed",
      issue: filed.number,
      parent: parent.parent,
      parentRule: parent.rule,
    };
  }

  private rememberSessions(signal: RetroSignal): void {
    for (const session of signal.sessions) {
      if (!this.state.filedSessions.includes(session.sessionId)) {
        this.state.filedSessions.push(session.sessionId);
      }
    }
  }

  /**
   * The degradation surface: the retro goes into the session's digest so the
   * record survives, and into `.argus/eyes/retro/unfiled/` when there is no
   * session to attach it to.
   */
  private async writeDigestNote(
    signal: RetroSignal,
    title: string,
    body: string,
  ): Promise<string> {
    const withDigests = signal.sessions.filter(
      (session) => session.digestFile !== undefined,
    );
    if (withDigests.length > 0) {
      const written: string[] = [];
      for (const session of withDigests) {
        await applyDigestUpdate(
          this.sessionsDir,
          session.digestFile!,
          { agent: session.agent ?? "unknown", startedBy: "johan" },
          {
            narrative: {
              ts: new Date(this.now()).toISOString(),
              text: `**UNFILED RETRO — ${title}**\n\n${body}`,
            },
          },
        );
        written.push(join(this.sessionsDir, session.digestFile!));
      }
      return written.join(", ");
    }
    const path = join(
      this.options.repo,
      ".argus/eyes/retro/unfiled",
      `${signal.id}.md`,
    );
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, `# ${title}\n\n${body}\n`);
    return path;
  }

  /** Atomic (temp + rename): a crash can never tear the cursor or the ledger. */
  private async persist(): Promise<void> {
    await mkdir(dirname(this.statePath), { recursive: true });
    const temporary = `${this.statePath}.tmp`;
    await Bun.write(
      temporary,
      JSON.stringify(
        { ...this.state, window: this.coalescer.pendingWindow() },
        null,
        2,
      ),
    );
    await rename(temporary, this.statePath);
  }
}

/** Pieces `openRetro` composes from config that a caller may substitute. */
export interface OpenRetroOverrides {
  brain?: Brain;
  capDirectory?: string;
  gh?: GhRunner;
  git?: GitRunner;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onAlert?: (alert: StuckAlert) => void | Promise<void>;
  onAudit?: (audit: RetroAudit) => void | Promise<void>;
}

/**
 * The production composition (what #34's supervisor calls): cadence, model
 * and the machine cap all come from `.argus/config.yaml` with defaults in
 * code (retro: 60s quiet / 600s max — the slowest eye, because it files
 * tickets).
 */
export async function openRetro(
  repo: string,
  overrides: OpenRetroOverrides = {},
): Promise<RetroEye> {
  const config = await loadEyesConfig(repo);
  return RetroEye.open({
    repo,
    brain:
      overrides.brain ??
      createCodexBrain({
        model: config.brain.model,
        reasoningEffort: config.brain.reasoningEffort,
      }),
    cap: createBrainCap({
      directory: overrides.capDirectory ?? defaultBrainSlotsDirectory(),
      maxConcurrency: config.brain.maxConcurrency,
    }),
    cadence: config.retro,
    ...(overrides.gh !== undefined && { gh: overrides.gh }),
    ...(overrides.git !== undefined && { git: overrides.git }),
    ...(overrides.now !== undefined && { now: overrides.now }),
    ...(overrides.sleep !== undefined && { sleep: overrides.sleep }),
    ...(overrides.onAlert !== undefined && { onAlert: overrides.onAlert }),
    ...(overrides.onAudit !== undefined && { onAudit: overrides.onAudit }),
  });
}
