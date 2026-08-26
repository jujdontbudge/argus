/**
 * The wayfinder map update (ticket #57; SPEC §7.3.4's "update the map").
 *
 * The map is not a file. Per the wayfinder skill it is a single issue on the
 * repo's tracker labelled `wayfinder:map` — the label set `argus up` already
 * converges (SPEC §10) — and it is an INDEX, not a store: "a decision lives in
 * exactly one place — its ticket — so the map never restates it, only gists it
 * and links". So closing a ticket adds exactly ONE line under `## Decisions so
 * far`, naming the ticket and linking it. Never the ticket's body, never the
 * diff, never a summary that could drift from the ticket it points at.
 *
 * REFER BY NAME, also from the skill: the line is `- [<title>](<url>) — <gist>`,
 * because a wall of bare `#57`s is illegible to the human the map is for.
 *
 * A repo with no map is NORMAL, not broken — an effort that never got charted
 * still merges and closes tickets — so `no-map` is an outcome, not a failure.
 * A map that exists and cannot be updated IS a failure, and a loud one: the
 * index silently falling behind the tracker is how a map stops being trusted.
 */
import type { GhRunner } from "../eyes/retro/gh";

export const MAP_LABEL = "wayfinder:map";
const DECISIONS_HEADING = /^##\s+Decisions so far\s*$/im;

export type MapUpdate =
  /** The map gained (or already had) this ticket's line. */
  | "updated"
  /** This repo has no wayfinder map; nothing to update. */
  | "no-map";

export interface MapResult {
  status: MapUpdate | "failed";
  /** The map issue's number, when one was found. */
  map?: string;
  reason?: string;
}

interface MapIssue {
  number: string;
  body: string;
}

const detail = (result: { stderr: string; stdout: string }): string =>
  (result.stderr.trim() || result.stdout.trim()).slice(0, 300);

async function findMap(
  run: GhRunner,
  cwd: string,
  tracker: string,
): Promise<MapIssue | null | { reason: string }> {
  const listed = await run(
    [
      "issue",
      "list",
      "--repo",
      tracker,
      "--label",
      MAP_LABEL,
      "--state",
      "open",
      "--limit",
      "10",
      "--json",
      "number,body",
    ],
    cwd,
  );
  if (listed.exitCode !== 0) {
    return { reason: `gh issue list --label ${MAP_LABEL} failed: ${detail(listed)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(listed.stdout);
  } catch {
    return { reason: "gh issue list returned output that is not JSON" };
  }
  if (!Array.isArray(parsed)) return { reason: "gh issue list returned a non-array" };
  for (const raw of parsed) {
    if (typeof raw !== "object" || raw === null) continue;
    const issue = raw as Record<string, unknown>;
    if (typeof issue.number !== "number") continue;
    return {
      body: typeof issue.body === "string" ? issue.body : "",
      number: String(issue.number),
    };
  }
  return null;
}

/**
 * Insert the decision line directly under `## Decisions so far`, so the index
 * stays where the skill says it lives. A map whose body has no such heading
 * still gets the line — appended under a heading this adds — because losing
 * the record is worse than editing a map somebody shaped differently.
 */
export function withDecision(body: string, line: string): string {
  if (body.includes(line)) return body;
  const lines = body.split("\n");
  const at = lines.findIndex((entry) => DECISIONS_HEADING.test(entry));
  if (at === -1) {
    const separator = body.trim() === "" ? "" : "\n\n";
    return `${body.replace(/\s+$/, "")}${separator}## Decisions so far\n\n${line}\n`;
  }
  // Past the heading and its blank line, past any HTML comment the skill's
  // template puts there, and above the existing entries.
  let insert = at + 1;
  while (
    insert < lines.length &&
    (lines[insert]!.trim() === "" || lines[insert]!.trim().startsWith("<!--"))
  ) {
    insert += 1;
  }
  lines.splice(insert, 0, line);
  return lines.join("\n");
}

export function decisionLine(request: {
  ticket: string;
  title: string;
  url: string;
  gist: string;
}): string {
  const name = request.title.trim() === "" ? `Ticket #${request.ticket}` : request.title.trim();
  return `- [${name}](${request.url}) — ${request.gist}`;
}

export async function updateWayfinderMap(request: {
  cwd: string;
  gh: GhRunner;
  gist: string;
  ticket: string;
  title: string;
  tracker: string;
  url: string;
}): Promise<MapResult> {
  const found = await findMap(request.gh, request.cwd, request.tracker);
  if (found === null) return { status: "no-map" };
  if ("reason" in found) return { reason: found.reason, status: "failed" };

  const line = decisionLine({
    gist: request.gist,
    ticket: request.ticket,
    title: request.title,
    url: request.url,
  });
  const body = withDecision(found.body, line);
  if (body === found.body) return { map: found.number, status: "updated" };

  const edited = await request.gh(
    ["issue", "edit", found.number, "--repo", request.tracker, "--body", body],
    request.cwd,
  );
  if (edited.exitCode !== 0) {
    return {
      map: found.number,
      reason: `gh issue edit --body failed: ${detail(edited)}`,
      status: "failed",
    };
  }
  return { map: found.number, status: "updated" };
}
