/**
 * The claim (ticket #56; SPEC §7.3.2: "Per ticket: **claim (assign)** → …").
 *
 * The claim IS the GitHub assignment. Nothing local can serve: a claim exists
 * to stop a SECOND dispatcher — on another machine, or the next cron tick —
 * from picking the same ticket up, and only the tracker is visible to both.
 * That is also why `readFrontier` excludes any assigned ticket: the claim and
 * the frontier read are two halves of one protocol.
 *
 * GitHub's assign API is not compare-and-swap, so the claim is
 * ASSIGN-THEN-VERIFY: assign, read the assignees back, and accept the claim
 * only if we are alone on it. Two dispatchers racing therefore both assign,
 * both read, and both see two assignees — so both back off and neither
 * spawns. Losing a claim costs one deferred dispatch; winning one falsely
 * costs two agents editing one ticket's worktrees, so the tie resolves to
 * "nobody", deliberately.
 */
import type { GhRunner } from "../eyes/retro/gh";

export type ClaimResult =
  /** The ticket is ours, and no one else is on it. */
  | { status: "claimed"; ticket: string; login: string }
  /** Somebody else holds it; we touched nothing that was not already theirs. */
  | { status: "lost"; ticket: string; reason: string }
  /** It closed, vanished, or `gh` failed — no claim, and no guess. */
  | { status: "failed"; ticket: string; reason: string };

export interface ClaimRequest {
  cwd: string;
  login: string;
  repo: string;
  run: GhRunner;
  ticket: string;
}

export interface TicketLabelRequest {
  cwd: string;
  label: string;
  repo: string;
  run: GhRunner;
  ticket: string;
}

export type TicketLabelResult =
  | { status: "marked"; ticket: string; label: string }
  | { status: "failed"; ticket: string; reason: string };

const detail = (result: { stderr: string; stdout: string }): string =>
  (result.stderr.trim() || result.stdout.trim()).slice(0, 300);

/** `gh api user` — who a claim would be made as. Null when gh cannot say. */
export async function claimingLogin(
  run: GhRunner,
  cwd: string,
): Promise<{ login: string } | { reason: string }> {
  const result = await run(["api", "user", "--jq", ".login"], cwd);
  if (result.exitCode !== 0) {
    return { reason: `gh api user failed (exit ${result.exitCode}): ${detail(result)}` };
  }
  const login = result.stdout.trim();
  if (login === "" || /\s/.test(login)) {
    return { reason: `gh api user returned no usable login: ${login.slice(0, 100)}` };
  }
  return { login };
}

export async function claimTicket(request: ClaimRequest): Promise<ClaimResult> {
  const { cwd, login, repo, run, ticket } = request;
  const assigned = await run(
    ["issue", "edit", ticket, "--repo", repo, "--add-assignee", login],
    cwd,
  );
  if (assigned.exitCode !== 0) {
    return {
      reason: `gh issue edit --add-assignee failed (exit ${assigned.exitCode}): ${detail(assigned)}`,
      status: "failed",
      ticket,
    };
  }

  const state = await readClaim(request);
  if ("reason" in state) {
    // The assignment may or may not have landed and we cannot tell. Give it
    // back rather than deploy on an unverified claim; a spare unassign on a
    // ticket we never held is harmless, a double dispatch is not.
    await releaseClaim(request);
    return { reason: state.reason, status: "failed", ticket };
  }
  if (state.state === "closed") {
    await releaseClaim(request);
    return {
      reason: "the ticket closed between the frontier read and the claim",
      status: "lost",
      ticket,
    };
  }
  const others = state.assignees.filter((assignee) => assignee !== login);
  if (others.length > 0) {
    await releaseClaim(request);
    return {
      reason: `another claimer holds it: ${others.join(", ")}`,
      status: "lost",
      ticket,
    };
  }
  if (!state.assignees.includes(login)) {
    return {
      reason: "gh reported success but the assignment is not visible",
      status: "failed",
      ticket,
    };
  }
  return { login, status: "claimed", ticket };
}

/**
 * Give a ticket back to the frontier. Used when a claim is lost, when the
 * deployment that would have justified it fails, and by recovery when a dead
 * session left nothing behind.
 */
export async function releaseClaim(request: ClaimRequest): Promise<boolean> {
  const { cwd, login, repo, run, ticket } = request;
  const result = await run(
    ["issue", "edit", ticket, "--repo", repo, "--remove-assignee", login],
    cwd,
  );
  return result.exitCode === 0;
}

/** Add a durable tracker marker and read it back before a worker starts. */
export async function addTicketLabel(
  request: TicketLabelRequest,
): Promise<TicketLabelResult> {
  const { cwd, label, repo, run, ticket } = request;
  const edited = await run(
    ["issue", "edit", ticket, "--repo", repo, "--add-label", label],
    cwd,
  );
  if (edited.exitCode !== 0) {
    return {
      reason: `gh issue edit --add-label failed (exit ${edited.exitCode}): ${detail(edited)}`,
      status: "failed",
      ticket,
    };
  }

  const viewed = await run(
    ["issue", "view", ticket, "--repo", repo, "--json", "labels"],
    cwd,
  );
  if (viewed.exitCode !== 0) {
    return {
      reason: `gh issue view labels failed (exit ${viewed.exitCode}): ${detail(viewed)}`,
      status: "failed",
      ticket,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(viewed.stdout);
  } catch {
    return {
      reason: "gh issue view labels returned output that is not JSON",
      status: "failed",
      ticket,
    };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return {
      reason: "gh issue view labels returned a non-object",
      status: "failed",
      ticket,
    };
  }
  const labels = Array.isArray((parsed as { labels?: unknown }).labels)
    ? (parsed as { labels: unknown[] }).labels.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const name = (entry as { name?: unknown }).name;
        return typeof name === "string" ? [name] : [];
      })
    : [];
  if (!labels.includes(label)) {
    return {
      reason: `gh issue edit reported success but ticket #${ticket} has no '${label}' label`,
      status: "failed",
      ticket,
    };
  }
  return { label, status: "marked", ticket };
}

async function readClaim(
  request: ClaimRequest,
): Promise<{ assignees: string[]; state: "open" | "closed" } | { reason: string }> {
  const { cwd, repo, run, ticket } = request;
  const viewed = await run(
    ["issue", "view", ticket, "--repo", repo, "--json", "assignees,state"],
    cwd,
  );
  if (viewed.exitCode !== 0) {
    return {
      reason: `gh issue view failed (exit ${viewed.exitCode}): ${detail(viewed)}`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(viewed.stdout);
  } catch {
    return { reason: "gh issue view returned output that is not JSON" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { reason: "gh issue view returned a non-object" };
  }
  const issue = parsed as Record<string, unknown>;
  const assignees = Array.isArray(issue.assignees)
    ? issue.assignees.flatMap((entry) => {
        if (typeof entry !== "object" || entry === null) return [];
        const login = (entry as Record<string, unknown>).login;
        return typeof login === "string" && login !== "" ? [login] : [];
      })
    : [];
  return {
    assignees,
    state: /^closed$/i.test(String(issue.state)) ? "closed" : "open",
  };
}
