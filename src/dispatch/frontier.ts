/**
 * The GitHub frontier reader (ticket #56; SPEC §7.3.1: "Hermes reads the
 * frontier — open, unblocked, unclaimed tickets — from GitHub").
 *
 * SPEC §7.1 names the tracker shape this reads: "GitHub Issues per target repo
 * (native sub-issues + blocking edges = visible frontier)". So a ticket is on
 * the frontier when all four of these hold:
 *
 * 1. it is OPEN — asked of the API, not filtered afterwards, so a closed
 *    ticket is never even considered;
 * 2. it is UNCLAIMED — nobody is assigned to it, because §7.3.2's claim IS an
 *    assignment and a second dispatcher's claim must be visible to this one;
 * 3. no OPEN issue blocks it (GitHub issue dependencies, `blocked_by`);
 * 4. it has no OPEN sub-issues — a parent with unfinished children is an epic,
 *    and dispatching one would put an agent on work its children still own.
 * 5. it is not paused for a human decision — unless the repository owner has
 *    answered since the pause label was added.
 *
 * THE POSTURE ON WHAT CANNOT BE DETERMINED IS FAIL CLOSED, AND LOUD. If the
 * dependency read fails — rate limit, network, permissions — the ticket is
 * excluded with the reason attached rather than treated as unblocked. The
 * asymmetry is deliberate: an excluded ticket costs one deferred dispatch that
 * the next pass picks up, while a wrongly-dispatched blocked ticket spends a
 * real session doing work in the wrong order, and nothing un-spends it.
 *
 * Every call goes through the same injected `GhRunner` seam the Retro eye
 * files through, so no test run can reach a real repository.
 */
import type { GhRunner } from "../eyes/retro/gh";

/** One dispatchable ticket, with the scope text the dispatch prompt quotes. */
export interface FrontierTicket {
  number: string;
  title: string;
  body: string;
  labels: string[];
}

export type ExclusionReason =
  /** Somebody — possibly another dispatcher — already holds it. */
  | "claimed"
  /** An open issue blocks it (GitHub issue dependencies). */
  | "blocked"
  /** It is a parent whose children are not finished. */
  | "has-open-sub-issues"
  /** The last worker is waiting for the repository owner to answer. */
  | "blocked-on-human"
  /** Blocked-ness could NOT be read; fail closed rather than guess. */
  | "unknown-dependencies";

export interface ExcludedTicket {
  number: string;
  reason: ExclusionReason;
  detail: string;
}

export interface FrontierResult {
  /** Open, unblocked, unclaimed — in ticket order, so dispatch is stable. */
  tickets: FrontierTicket[];
  /** Every open ticket that did not make it, with why. */
  excluded: ExcludedTicket[];
  /** Whole-read failures (ADR-0001: degrade loudly, never silently). */
  degraded: string[];
}

export interface FrontierRequest {
  /** The directory `gh` runs in. */
  cwd: string;
  /** `owner/name`. */
  repo: string;
  run: GhRunner;
  /** Cap on the issue list; GitHub's own page limit for one call. */
  limit?: number;
}

interface ListedIssue {
  number: string;
  title: string;
  body: string;
  labels: string[];
  assignees: string[];
}

const BLOCKED_ON_HUMAN_LABEL = "argus:blocked-on-human";

const detail = (result: { stderr: string; stdout: string }): string =>
  (result.stderr.trim() || result.stdout.trim()).slice(0, 300);

export async function readFrontier(
  request: FrontierRequest,
): Promise<FrontierResult> {
  const { cwd, repo, run } = request;
  const excluded: ExcludedTicket[] = [];
  const degraded: string[] = [];

  const listed = await run(
    [
      "issue",
      "list",
      "--repo",
      repo,
      "--state",
      "open",
      "--limit",
      String(request.limit ?? 200),
      "--json",
      "number,title,body,labels,assignees",
    ],
    cwd,
  );
  if (listed.exitCode !== 0) {
    return {
      degraded: [`gh issue list failed (exit ${listed.exitCode}): ${detail(listed)}`],
      excluded,
      tickets: [],
    };
  }

  const open = parseIssues(listed.stdout);
  if (open === null) {
    return {
      degraded: ["gh issue list returned output that is not a JSON array of issues"],
      excluded,
      tickets: [],
    };
  }

  const tickets: FrontierTicket[] = [];
  for (const issue of [...open].sort((a, b) => Number(a.number) - Number(b.number))) {
    // Claimed is checked FIRST and short-circuits: it is the cheapest signal
    // and it means no dependency call is worth spending on this ticket.
    if (issue.assignees.length > 0) {
      excluded.push({
        detail: `assigned to ${issue.assignees.join(", ")}`,
        number: issue.number,
        reason: "claimed",
      });
      continue;
    }

    if (issue.labels.includes(BLOCKED_ON_HUMAN_LABEL)) {
      const resumed = await ownerResumed(run, cwd, repo, issue.number);
      if (typeof resumed === "string") {
        excluded.push({
          detail: `blocked-on-human activity could not be read: ${resumed}`,
          number: issue.number,
          reason: "blocked-on-human",
        });
        continue;
      }
      if (!resumed) {
        excluded.push({
          detail: `labeled ${BLOCKED_ON_HUMAN_LABEL}; awaiting a newer owner comment or body edit`,
          number: issue.number,
          reason: "blocked-on-human",
        });
        continue;
      }
      const removed = await run(
        [
          "issue",
          "edit",
          issue.number,
          "--repo",
          repo,
          "--remove-label",
          BLOCKED_ON_HUMAN_LABEL,
        ],
        cwd,
      );
      if (removed.exitCode !== 0) {
        excluded.push({
          detail: `owner activity resumed it, but the blocked-on-human label could not be removed: ${detail(removed)}`,
          number: issue.number,
          reason: "blocked-on-human",
        });
        continue;
      }
      issue.labels = issue.labels.filter((label) => label !== BLOCKED_ON_HUMAN_LABEL);
    }

    const blockers = await openRelated(
      run,
      cwd,
      `repos/${repo}/issues/${issue.number}/dependencies/blocked_by`,
    );
    if (typeof blockers === "string") {
      excluded.push({
        detail: `blocked_by could not be read: ${blockers}`,
        number: issue.number,
        reason: "unknown-dependencies",
      });
      continue;
    }
    if (blockers.length > 0) {
      excluded.push({
        detail: `blocked by ${blockers.map((number) => `#${number}`).join(", ")}`,
        number: issue.number,
        reason: "blocked",
      });
      continue;
    }

    const children = await openRelated(
      run,
      cwd,
      `repos/${repo}/issues/${issue.number}/sub_issues`,
    );
    if (typeof children === "string") {
      excluded.push({
        detail: `sub_issues could not be read: ${children}`,
        number: issue.number,
        reason: "unknown-dependencies",
      });
      continue;
    }
    if (children.length > 0) {
      excluded.push({
        detail: `${children.length} open sub-issue${children.length === 1 ? "" : "s"} (${children
          .map((number) => `#${number}`)
          .join(", ")})`,
        number: issue.number,
        reason: "has-open-sub-issues",
      });
      continue;
    }

    tickets.push({
      body: issue.body,
      labels: issue.labels,
      number: issue.number,
      title: issue.title,
    });
  }

  return { degraded, excluded, tickets };
}

/**
 * A blocked ticket is resumed only by activity that can reasonably be an
 * answer from the owner. Timeline events are used instead of issue.updated_at:
 * the latter also changes for Argus's own label and comments by other users.
 */
async function ownerResumed(
  run: GhRunner,
  cwd: string,
  repo: string,
  ticket: string,
): Promise<boolean | string> {
  const result = await run(
    [
      "api",
      `repos/${repo}/issues/${ticket}/timeline`,
      "--paginate",
      "--slurp",
    ],
    cwd,
  );
  if (result.exitCode !== 0) return detail(result);

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return `not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  const events = timelineEvents(parsed);
  if (events === null) return "not a JSON array of timeline events";

  const owner = repo.split("/", 1)[0];
  if (owner === undefined || owner === "") return "tracker repository has no owner";
  const labelEvent = events
    .filter(
      (event) =>
        event.event === "labeled" &&
        event.labelName === BLOCKED_ON_HUMAN_LABEL &&
        event.createdAt !== null,
    )
    .at(-1);
  if (labelEvent === undefined || labelEvent.createdAt === null) {
    return `no ${BLOCKED_ON_HUMAN_LABEL} label event found`;
  }
  const labelTime = labelEvent.createdAt;

  return events.some((event) => {
    if (event.createdAt === null || event.createdAt <= labelTime) return false;
    if (event.event === "commented") {
      return event.userLogin?.toLowerCase() === owner.toLowerCase();
    }
    return event.event === "edited" && event.bodyWasEdited;
  });
}

interface TimelineEvent {
  event: string;
  createdAt: string | null;
  labelName: string | null;
  userLogin: string | null;
  bodyWasEdited: boolean;
}

function timelineEvents(value: unknown): TimelineEvent[] | null {
  const pages = Array.isArray(value) && value.every(Array.isArray) ? value.flat() : value;
  if (!Array.isArray(pages)) return null;
  return pages.flatMap((entry): TimelineEvent[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const row = entry as Record<string, unknown>;
    const event = typeof row.event === "string" ? row.event : "";
    const createdAt =
      typeof row.created_at === "string" && !Number.isNaN(Date.parse(row.created_at))
        ? row.created_at
        : null;
    const label = row.label;
    const labelName =
      typeof label === "object" && label !== null &&
      typeof (label as Record<string, unknown>).name === "string"
        ? (label as { name: string }).name
        : null;
    const user = row.user;
    const userLogin =
      typeof user === "object" && user !== null &&
      typeof (user as Record<string, unknown>).login === "string"
        ? (user as { login: string }).login
        : null;
    const changes = row.changes;
    const bodyWasEdited =
      event === "edited" && typeof changes === "object" && changes !== null &&
      Object.prototype.hasOwnProperty.call(changes, "body");
    return [{ event, createdAt, labelName, userLogin, bodyWasEdited }];
  });
}

/**
 * The OPEN issue numbers at one relationship endpoint, or a failure string.
 *
 * A string return is "could not be determined", never "none" — the caller
 * excludes on it. An endpoint that answers with a non-array body is treated
 * the same way for the same reason: an unrecognised shape is not evidence of
 * an empty relationship.
 */
async function openRelated(
  run: GhRunner,
  cwd: string,
  path: string,
): Promise<string[] | string> {
  const result = await run(["api", path], cwd);
  if (result.exitCode !== 0) return detail(result);
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return `not valid JSON: ${error instanceof Error ? error.message : String(error)}`;
  }
  if (!Array.isArray(parsed)) return "not a JSON array";
  const numbers: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== "object" || entry === null) return "entry is not an object";
    const related = entry as { number?: unknown; state?: unknown };
    if (typeof related.number !== "number") return "entry has no issue number";
    // Anything that is not explicitly closed counts as open: the conservative
    // reading, and the one that keeps a half-understood state from dispatching.
    if (/^closed$/i.test(String(related.state))) continue;
    numbers.push(String(related.number));
  }
  return numbers;
}

function parseIssues(stdout: string): ListedIssue[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  return parsed.flatMap((raw): ListedIssue[] => {
    if (typeof raw !== "object" || raw === null) return [];
    const issue = raw as Record<string, unknown>;
    if (typeof issue.number !== "number") return [];
    return [
      {
        assignees: names(issue.assignees, "login"),
        body: typeof issue.body === "string" ? issue.body : "",
        labels: names(issue.labels, "name"),
        number: String(issue.number),
        title: typeof issue.title === "string" ? issue.title : "",
      },
    ];
  });
}

function names(value: unknown, field: "login" | "name"): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null) return [];
    const named = (entry as Record<string, unknown>)[field];
    return typeof named === "string" && named !== "" ? [named] : [];
  });
}
