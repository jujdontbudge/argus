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
import {
  fileAlertEmitter,
  retryForever,
  type RetryFailure,
  type StuckAlert,
} from "../backpressure";
import { createCodexBrain, type Brain, type BrainOutcome } from "../brain";
import { createBrainCap, defaultBrainSlotsDirectory, type BrainCap } from "../cap";
import { Coalescer, type CoalesceWindow } from "../coalesce";
import { loadEyesConfig, type CadenceConfig } from "../config";
import { applyDigestUpdate, listDigests, type StoredDigest } from "../digest/outputs";
import { attributeChanges, referencedTickets } from "./attribution";
import {
  composeRetro,
  composeScopeDrift,
  type RetroComposition,
  type RetroPrompt,
} from "./compose";
import {
  buildDriftCandidates,
  buildDriftPrompt,
  decideDrift,
  isJudgeableScope,
  type DriftCandidate,
  type DriftQuestion,
} from "./drift";
import { resolvePath, scanGit, type GitRunner, type GitScan } from "./git";
import { detectTracker, type GhRunner, type Tracker, type TrackerIssue } from "./gh";
import { resolveParent, type ParentResolution, type ParentRule } from "./parent";
import {
  DRIFT_OUTPUT_SCHEMA,
  parseDriftVerdict,
  parseRetroVerdict,
  RETRO_OUTPUT_SCHEMA,
  type DriftJudgment,
  type RetroJudgment,
  type RetroVerdict,
} from "./schema";
import { buildSignals, type RetroSignal } from "./signal";

export type { ProvenanceRecord } from "../../provenance";

/**
 * `rogue` is §5.5's original detection — work no claimed ticket covers.
 * `scope-drift` is §14's harder case (#38) — work inside a ticket that the
 * ticket never asked for.
 */
export type RetroKind = "rogue" | "scope-drift";

/** What one detected signal ended up as. */
export interface RetroFiling {
  signalId: string;
  /** Which detector produced it: unticketed work, or drift inside a ticket. */
  kind: RetroKind;
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
  | { type: "tracker-less"; signalId: string; title: string; where: string }
  | {
      /**
       * A scope-drift question that did NOT become a ticket for a reason
       * worth seeing: the brain was unreachable or answered off-contract, the
       * repo has no tracker to read a scope from, or the brain claimed drift
       * without clearing the policy bar. An ordinary "not drift" is silent —
       * silence is the expected answer and must not become noise.
       */
      type: "scope-drift-not-filed";
      candidateId: string;
      ticket: string;
      reason: string;
    };

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
  onFailure?: (failure: RetryFailure) => void | Promise<void>;
  /** Audit sink; defaults to stderr — degradation must be visible. */
  onAudit?: (audit: RetroAudit) => void | Promise<void>;
  baseDelayMs?: number;
  maxDelayMs?: number;
  stuckAfterMs?: number;
  signal?: AbortSignal;
}

/** The minimum a degradation needs to find a session's digest. */
interface NoteSession {
  sessionId: string;
  agent?: string;
  digestFile?: string;
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
  /** Independent git-scan deadline; transcript activity may make a scan earlier. */
  nextScanAt: number | null;
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
    nextScanAt: null,
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
    case "scope-drift-not-filed":
      return (
        `RETRO: scope drift against #${audit.ticket} was NOT filed ` +
        `(${audit.candidateId}): ${audit.reason}`
      );
  }
}

/** Evidence, not an archive: the newest prompts are the ones that explain. */
const MAX_PROMPTS = 200;
const NOT_IMPLEMENTATION = "not-implementation";
const NOT_DRIFT = "not-drift";
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
          nextScanAt:
            typeof raw.nextScanAt === "number" && Number.isFinite(raw.nextScanAt)
              ? raw.nextScanAt
              : null,
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
    const eye = new RetroEye(options, state);
    if (!state.primed) await eye.prime();
    else if (state.nextScanAt === null) {
      eye.scheduleNextScan();
      await eye.persist();
    }
    return eye;
  }

  private scheduleNextScan(): void {
    this.state.nextScanAt =
      this.now() + this.options.cadence.maxWaitSeconds * 1_000;
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
    this.scheduleNextScan();
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
  async observeSession(observation: SessionObservation): Promise<void> {
    this.state.sessionDirs[observation.sessionId] = observation.cwd;
    await this.persist();
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
    const transcriptDue = this.coalescer.dueAt();
    if (transcriptDue === null) return this.state.nextScanAt;
    if (this.state.nextScanAt === null) return transcriptDue;
    return Math.min(transcriptDue, this.state.nextScanAt);
  }

  /** Run a scan if the cadence says it is due. */
  async tick(): Promise<RetroFiling[]> {
    const due = this.dueAt();
    if (due === null || this.now() < due) return [];
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
      // §14's harder case rides the SAME scan: the work a ticket session does
      // cover still has to answer "is this what the ticket asked for?".
      const drifts = buildDriftCandidates({
        attributed: attribution.attributed,
        // Every checkout in one scan belongs to one parent repo (§7.3).
        parentRepoOf: () => scan.repoRoot,
      }).filter((candidate) => this.state.judged[candidate.id] === undefined);

      // The cursor advances even when nothing is rogue: reported commits are
      // reported. What stops a re-file is `judged`, not the cursor.
      this.state.seen = scan.seen;
      this.coalescer.flush();

      if (signals.length === 0 && drifts.length === 0) {
        this.scheduleNextScan();
        await this.persist();
        return [];
      }

      const tracker = await detectTracker(this.options.repo, this.options.gh);
      const filings: RetroFiling[] = [];
      if (signals.length > 0) {
        filings.push(...(await this.judgeSignals(signals, tracker, scan.repoRoot)));
      }
      if (drifts.length > 0) {
        filings.push(...(await this.judgeDrift(drifts, tracker, digests)));
      }
      this.scheduleNextScan();
      await this.persist();
      return filings;
    } finally {
      this.scanning = false;
    }
  }

  /**
   * The §5.5 half: unticketed work becomes a retro. Extracted from `scan` so
   * the §14 scope-drift half can share the scan, the tracker and the cursor
   * without either half being able to swallow the other.
   */
  private async judgeSignals(
    signals: readonly RetroSignal[],
    tracker: Tracker | null,
    repoRoot: string,
  ): Promise<RetroFiling[]> {
      const candidates = tracker ? await tracker.openTickets() : [];
      const verdict = await retryForever(
        () => this.evaluateOnce(signals, candidates),
        {
          eye: "retro",
          onAlert: this.onAlert,
          ...(this.options.onFailure !== undefined && {
            onFailure: this.options.onFailure,
          }),
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
          ...(this.options.signal !== undefined && { signal: this.options.signal }),
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
          await this.file(signal, judgment, tracker, candidates, repoRoot),
        );
      }
      return filings;
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

  /**
   * The §14 half (#38): for each ticket whose session did work this scan, ask
   * the ONE scope question and file only what clears the policy bar.
   *
   * Failure posture differs from the §5.5 half ON PURPOSE. A retro for
   * unticketed work must never be lost, so that half retries forever; a
   * scope-drift question is a judgment call whose correct default is silence,
   * so a broken brain here is REPORTED and dropped. One attempt, no retry
   * storm, and the eye stays up either way.
   */
  private async judgeDrift(
    candidates: readonly DriftCandidate[],
    tracker: Tracker | null,
    digests: readonly StoredDigest[],
  ): Promise<RetroFiling[]> {
    const skip = async (candidate: DriftCandidate, reason: string): Promise<void> => {
      await this.onAudit({
        type: "scope-drift-not-filed",
        candidateId: candidate.id,
        ticket: candidate.ticket,
        reason,
      });
    };

    if (tracker === null) {
      // No tracker, no stated scope to measure against. Silence is the only
      // honest answer; the degradation is said out loud rather than guessed.
      for (const candidate of candidates) {
        await skip(
          candidate,
          "tracker-less mode: a ticket's stated scope cannot be read, so the" +
            " scope question cannot be asked",
        );
      }
      return [];
    }

    const questions: DriftQuestion[] = [];
    for (const candidate of candidates) {
      const scope = await tracker.readTicket(candidate.ticket);
      // A ticket gh cannot read, or one that states too little to measure a
      // diff against, is silence — never a guess in the direction of drift.
      if (scope === null || !isJudgeableScope(scope)) continue;
      questions.push({ candidate, scope });
    }
    if (questions.length === 0) return [];

    const release = await this.options.cap.acquire();
    let outcome: BrainOutcome;
    try {
      outcome = await this.options.brain.evaluate({
        prompt: buildDriftPrompt(questions),
        schema: DRIFT_OUTPUT_SCHEMA,
        cwd: this.options.repo,
      });
    } catch (error) {
      // A brain is supposed to REPORT failure, not throw it. One that throws
      // anyway must not escape into `scan` and take the watcher down — this
      // half's correct default is silence, so it degrades to silence, loudly.
      outcome = {
        ok: false,
        reason: "spawn-error",
        detail: error instanceof Error ? error.message : String(error),
      };
    } finally {
      // Always, on every path: a leaked slot would starve every eye on the
      // machine of the ADR-0002 budget, not just this one.
      await release();
    }
    if (!outcome.ok) {
      for (const { candidate } of questions) {
        await skip(candidate, `brain ${outcome.reason}: ${outcome.detail.slice(0, 200)}`);
      }
      return [];
    }
    const verdict = parseDriftVerdict(outcome.text);
    if (verdict === null) {
      for (const { candidate } of questions) {
        await skip(
          candidate,
          `brain schema miss: ${outcome.text.slice(0, 200)}`,
        );
      }
      return [];
    }

    const byId = new Map(
      questions.map((question) => [question.candidate.id, question]),
    );
    const filings: RetroFiling[] = [];
    for (const judgment of verdict.drifts) {
      const question = byId.get(judgment.candidateId);
      if (question === undefined) continue; // the eye decides what exists
      const decision = decideDrift(judgment);
      if (!decision.file) {
        this.state.judged[question.candidate.id] = NOT_DRIFT;
        // A plain "not drift" is the expected answer and stays silent; a
        // drift CLAIM the policy refused is worth seeing.
        if (judgment.drift) await skip(question.candidate, decision.reason);
        continue;
      }
      filings.push(await this.fileDrift(question, judgment, tracker, digests));
    }
    return filings;
  }

  private async fileDrift(
    question: DriftQuestion,
    judgment: DriftJudgment,
    tracker: Tracker,
    digests: readonly StoredDigest[],
  ): Promise<RetroFiling> {
    const { candidate, scope } = question;
    // The parent is the ticket itself — §5.5 rule 1, resolved through the
    // same machinery so the rule name in the body is the real one.
    const parent = resolveParent({
      sessionTickets: [scope.number],
      referencedTickets: [],
      brainChoice: null,
      candidates: [],
    });
    return this.deliver({
      id: candidate.id,
      kind: "scope-drift",
      composition: composeScopeDrift({ candidate, scope, judgment }),
      parent,
      sessions: candidate.sessionIds.map((sessionId) => {
        const digest = digests.find((entry) => entry.sessionId === sessionId);
        return {
          sessionId,
          ...(digest?.frontmatter.agent !== undefined && {
            agent: digest.frontmatter.agent,
          }),
          ...(digest !== undefined && { digestFile: digest.fileName }),
        };
      }),
      tracker,
      // `filedSessions` suppresses a session's TRANSCRIPT retro; a registered
      // ticket session never has one, and a drift must not silence a future
      // rogue signal. The drift ledger is `judged`, keyed by candidate id.
      remember: false,
    });
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
    return this.deliver({
      id: signal.id,
      kind: "rogue",
      composition: composeRetro({
        what: judgment.what,
        summary: judgment.summary,
        signal,
        prompts,
        parent,
        repoRoot,
      }),
      parent,
      sessions: signal.sessions,
      tracker,
      // A session that has a retro does not need a second one for the same
      // digest growing; drift has its own ledger and must not touch this.
      remember: true,
    });
  }

  /**
   * The one path to the tracker, shared by both halves. Every outcome keeps
   * the record: filed, filed-but-unlinked, or written into the digest with a
   * LOUD audit (ADR-0001). It never throws — a crashed watcher is the only
   * outcome §5.5 refuses.
   */
  private async deliver(input: {
    id: string;
    kind: RetroKind;
    composition: RetroComposition;
    parent: ParentResolution;
    sessions: readonly NoteSession[];
    tracker: Tracker | null;
    remember: boolean;
  }): Promise<RetroFiling> {
    const { composition, parent } = input;
    const degrade = async (reason: string, audit: RetroAudit): Promise<RetroFiling> => {
      await this.onAudit(audit);
      this.state.judged[input.id] = UNFILED;
      if (input.remember) this.rememberSessions(input.sessions);
      return {
        signalId: input.id,
        kind: input.kind,
        title: composition.title,
        outcome: "digest-note",
        parent: parent.parent,
        parentRule: parent.rule,
        reason,
      };
    };

    if (input.tracker === null) {
      const where = await this.writeNote(
        input.id,
        input.sessions,
        composition.title,
        composition.body,
      );
      return degrade("tracker-less mode: no GitHub tracker for this repo", {
        type: "tracker-less",
        signalId: input.id,
        title: composition.title,
        where,
      });
    }

    const filed = await input.tracker.fileRetro({
      title: composition.title,
      body: composition.body,
      parent: parent.parent,
    });
    if (!filed.ok) {
      const where = await this.writeNote(
        input.id,
        input.sessions,
        composition.title,
        composition.body,
      );
      return degrade(filed.reason, {
        type: "retro-file-failed",
        signalId: input.id,
        title: composition.title,
        reason: filed.reason,
        where,
      });
    }

    if (parent.parent !== null && !filed.linked) {
      await this.onAudit({
        type: "retro-unlinked",
        signalId: input.id,
        issue: filed.number,
        parent: parent.parent,
        reason: filed.linkError ?? "sub-issue link did not complete",
      });
    }
    await this.onAudit({
      type: "retro-filed",
      signalId: input.id,
      issue: filed.number,
      parent: parent.parent,
      rule: parent.rule,
    });
    this.state.judged[input.id] = filed.number;
    if (input.remember) this.rememberSessions(input.sessions);
    return {
      signalId: input.id,
      kind: input.kind,
      title: composition.title,
      outcome: "filed",
      issue: filed.number,
      parent: parent.parent,
      parentRule: parent.rule,
    };
  }

  private rememberSessions(sessions: readonly NoteSession[]): void {
    for (const session of sessions) {
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
  private async writeNote(
    id: string,
    sessions: readonly NoteSession[],
    title: string,
    body: string,
  ): Promise<string> {
    const withDigests = sessions.filter(
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
    const path = join(this.options.repo, ".argus/eyes/retro/unfiled", `${id}.md`);
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
  onFailure?: (failure: RetryFailure) => void | Promise<void>;
  onAudit?: (audit: RetroAudit) => void | Promise<void>;
  signal?: AbortSignal;
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
        ...(process.env.ARGUS_CODEX_EXECUTABLE !== undefined && {
          binary: process.env.ARGUS_CODEX_EXECUTABLE,
        }),
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
    ...(overrides.onFailure !== undefined && { onFailure: overrides.onFailure }),
    ...(overrides.onAudit !== undefined && { onAudit: overrides.onAudit }),
    ...(overrides.signal !== undefined && { signal: overrides.signal }),
  });
}
