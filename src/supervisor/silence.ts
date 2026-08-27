/**
 * Silent deployments (#96, half 2): the deployment that is registered, watched
 * — and empty.
 *
 * #89's third live drive produced a durable registry row, five running
 * watchers, zero archived messages, and no complaint from anything. From
 * inside Argus that is indistinguishable from five broken eyes, and it stayed
 * invisible for as long as it did only because a human-written driver happened
 * to be reading the screen. The dialog it blocked on is one instance; the
 * class is "Argus registered a deployment, the archiver is live, and nothing
 * from that session has ever been archived", and the class is what this
 * module measures. A session that died at exec, one whose transcript lands in
 * a home the eyes do not read (#89 finding D), and one sitting on a modal all
 * arrive here as the same input, and all of them degrade.
 *
 * This is #85's shape one level up. #85 made an alive PID with no matching
 * health report `degraded` with a readable reason instead of silently
 * "running"; this makes a live deployment with no archived message `degraded`
 * with a readable reason instead of silently empty.
 *
 * ── THE THRESHOLD, and why five minutes ──────────────────────────────────
 *
 * The floor is how long a HEALTHY deployment can take to archive its first
 * message. That is not "time to first token": the first archived message is
 * the dispatch prompt itself, written to the transcript when the session
 * accepts it, and the archiver's poll is 250ms (`ARGUS_WATCH_POLL_MS`). The
 * budget is process start + CLI boot + the first transcript line + one poll —
 * seconds on the drives in `docs/acceptance/`, and tens of seconds on a cold,
 * loaded machine or a cmux-typed grill launch. Five minutes is roughly an
 * order of magnitude of headroom over the worst of those, so a slow start
 * never reads as an outage.
 *
 * The ceiling is what it costs to be wrong the other way. #89's session sat
 * blocked with nothing noticing, and the only thing that would EVER have
 * marked it is `dispatch-expired`, which the classifier raises at
 * `WINDOW_AFTER_MS` — one hour. Five minutes is twelve times tighter than the
 * status quo, and it is bounded above by exactly that hour: past
 * `WINDOW_AFTER_MS` this check goes quiet and hands the session to the
 * `dispatch-expired` audit, which `argus status` already prints. So the two
 * never double-report, and this fills the window in which nothing did.
 *
 * `ARGUS_SILENT_DEPLOYMENT_MS` overrides the floor for drives that cannot
 * wait five minutes to prove the behaviour.
 */
import { toEpochMs, WINDOW_AFTER_MS } from "../matching";
import type { SessionRecord } from "../provenance";

export const SILENT_DEPLOYMENT_MS = 300_000;

export interface SilenceInput {
  /** Session ids with at least one row in this repo's archive. */
  archivedSessionIds: ReadonlySet<string>;
  /**
   * Is the archiver eye running for this repo? Zero archived messages means
   * nothing when nothing is archiving — that fault is already its own status
   * row, and blaming the deployment for it would be a second, wrong reason
   * for one problem.
   */
  archiverAlive: boolean;
  now: number;
  repo: string;
  sessions: readonly SessionRecord[];
  thresholdMs: number;
}

export interface SilentDeployment {
  agent: string | null;
  /** ISO-8601 or epoch-ms, exactly as the registry row recorded it. */
  deployedAt: string | number;
  reason: string;
  repo: string;
  sessionId: string;
  silentForMs: number;
  state: "degraded";
  ticket: string | null;
}

export function silenceThresholdMs(
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): number {
  const parsed = Number(env.ARGUS_SILENT_DEPLOYMENT_MS);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : SILENT_DEPLOYMENT_MS;
}

function humanDuration(milliseconds: number): string {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/**
 * The degraded deployments in one repo. Pure: every fact it needs — the rows,
 * the archive, whether the archiver is alive, and the clock — is passed in, so
 * the rule is testable without a live fleet.
 */
export function silentDeployments(input: SilenceInput): SilentDeployment[] {
  if (!input.archiverAlive) return [];
  const earliest = new Map<string, SessionRecord>();
  for (const session of input.sessions) {
    const seen = earliest.get(session.sessionId);
    if (seen === undefined || toEpochMs(session.ts) < toEpochMs(seen.ts)) {
      earliest.set(session.sessionId, session);
    }
  }
  const rows: SilentDeployment[] = [];
  for (const session of earliest.values()) {
    if (input.archivedSessionIds.has(session.sessionId)) continue;
    const silentForMs = input.now - toEpochMs(session.ts);
    if (silentForMs < input.thresholdMs || silentForMs >= WINDOW_AFTER_MS) continue;
    rows.push({
      agent: session.agent ?? null,
      deployedAt: session.ts,
      reason:
        `deployed ${humanDuration(silentForMs)} ago and the archiver eye is live, ` +
        `but it has archived 0 messages for this session (threshold ` +
        `${humanDuration(input.thresholdMs)}). The session never started, is blocked ` +
        `on a prompt it cannot answer, or its transcript is not where the eyes are ` +
        `looking. Attach to it: the deployment row has the worktree and the tab.`,
      repo: input.repo,
      sessionId: session.sessionId,
      silentForMs,
      state: "degraded",
      ticket: session.ticket ?? null,
    });
  }
  return rows.sort(
    (left, right) =>
      right.silentForMs - left.silentForMs ||
      left.sessionId.localeCompare(right.sessionId),
  );
}
