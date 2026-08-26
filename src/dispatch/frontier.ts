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
