/**
 * The tracker seam (SPEC §5.5): every GitHub interaction the Retro eye makes
 * goes through `GhRunner`, so tests drive a fake and no test run can ever
 * write to a real repository.
 *
 * Filing a retro is three gh calls, in order:
 *
 * 1. `gh issue create --label retro` — the ticket itself.
 * 2. `gh api repos/O/N/issues/<parent>/sub_issues -F sub_issue_id=<db id>` —
 *    GitHub's native sub-issue link, the legal form of "ticket 15.1". It
 *    takes the issue's DATABASE id, not its number, so the id is read back
 *    from `gh api repos/O/N/issues/<number>` first.
 * 3. `gh issue close --reason completed` — a retro records work that already
 *    happened; it is filed closed (§5.5: no approval queue).
 *
 * Nothing here throws for tracker trouble. A failed create comes back as a
 * failure result and a failed link leaves the retro filed-but-unlinked with
 * the error attached — the eye surfaces both loudly (ADR-0001 posture) and
 * still keeps the record. A crashed watcher would lose the retro entirely,
 * which is the one outcome §5.5 refuses.
 */

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Injectable `gh` runner; the default runs the real CLI. */
export type GhRunner = (
  args: readonly string[],
  cwd: string,
) => Promise<CommandResult>;

const defaultRunner: GhRunner = async (args, cwd) => {
  try {
    const child = Bun.spawn(["gh", ...args], { cwd, stderr: "pipe", stdout: "pipe" });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } catch (error) {
    return {
      exitCode: 127,
      stdout: "",
      stderr: error instanceof Error ? error.message : String(error),
    };
  }
};

/** An open tracker issue: a candidate parent for a retro. */
export interface TrackerIssue {
  number: string;
  title: string;
  body: string;
  labels: string[];
}

export interface RetroIssueRequest {
  title: string;
  body: string;
  /** Parent issue number, or null for a root-level retro. */
  parent: string | null;
  /** Defaults to the `retro` label `argus up` converges. */
  labels?: string[];
}

export type FiledRetro =
  | {
      ok: true;
      number: string;
      url: string;
      parent: string | null;
      /** False when there was no parent, or the sub-issue link failed. */
      linked: boolean;
      linkError?: string;
      closed: boolean;
      closeError?: string;
    }
  | { ok: false; reason: string };

export interface Tracker {
  /** `owner/name` — the repo retros are filed against. */
  readonly repo: string;
  openTickets(): Promise<TrackerIssue[]>;
  fileRetro(request: RetroIssueRequest): Promise<FiledRetro>;
}

const RETRO_LABEL = "retro";

function fail(result: CommandResult, what: string): string {
  const detail = (result.stderr.trim() || result.stdout.trim()).slice(0, 500);
  return `${what} failed (exit ${result.exitCode}): ${detail}`;
}

/** The issue number at the end of a `gh issue create` URL. */
function numberFromUrl(url: string): string | null {
  return url.trim().match(/\/(\d+)\s*$/)?.[1] ?? null;
}

function createTracker(repo: string, cwd: string, run: GhRunner): Tracker {
  return {
    repo,

    async openTickets() {
      const listed = await run(
        [
          "issue",
          "list",
          "--repo",
          repo,
          "--state",
          "open",
          "--limit",
          "200",
          "--json",
          "number,title,body,labels",
        ],
        cwd,
      );
      if (listed.exitCode !== 0) return [];
      let parsed: unknown;
      try {
        parsed = JSON.parse(listed.stdout);
      } catch {
        return [];
      }
      if (!Array.isArray(parsed)) return [];
      return parsed.flatMap((raw): TrackerIssue[] => {
        if (typeof raw !== "object" || raw === null) return [];
        const issue = raw as Record<string, unknown>;
        if (typeof issue.number !== "number") return [];
        const labels = Array.isArray(issue.labels)
          ? issue.labels.flatMap((label) =>
              typeof label === "object" &&
              label !== null &&
              typeof (label as { name?: unknown }).name === "string"
                ? [(label as { name: string }).name]
                : [],
            )
          : [];
        return [
          {
            number: String(issue.number),
            title: typeof issue.title === "string" ? issue.title : "",
            body: typeof issue.body === "string" ? issue.body : "",
            labels,
          },
        ];
      });
    },

    async fileRetro(request) {
      const labels = request.labels ?? [RETRO_LABEL];
      const created = await run(
        [
          "issue",
          "create",
          "--repo",
          repo,
          "--title",
          request.title,
          "--body",
          request.body,
          ...labels.flatMap((label) => ["--label", label]),
        ],
        cwd,
      );
      if (created.exitCode !== 0) {
        return { ok: false, reason: fail(created, "gh issue create") };
      }
      const url = created.stdout.trim().split("\n").at(-1)?.trim() ?? "";
      const number = numberFromUrl(url);
      if (number === null) {
        return {
          ok: false,
          reason: `gh issue create returned no issue URL: ${url.slice(0, 200)}`,
        };
      }

      let linked = false;
      let linkError: string | undefined;
      if (request.parent !== null) {
        const read = await run(
          ["api", `repos/${repo}/issues/${number}`, "--jq", ".id"],
          cwd,
        );
        const id = read.exitCode === 0 ? read.stdout.trim() : null;
        if (id === null || !/^\d+$/.test(id)) {
          linkError = fail(read, `gh api repos/${repo}/issues/${number}`);
        } else {
          const link = await run(
            [
              "api",
              `repos/${repo}/issues/${request.parent}/sub_issues`,
              "-F",
              `sub_issue_id=${id}`,
            ],
            cwd,
          );
          if (link.exitCode === 0) linked = true;
          else linkError = fail(link, "gh api sub_issues");
        }
      }

      const closed = await run(
        ["issue", "close", number, "--repo", repo, "--reason", "completed"],
        cwd,
      );
      return {
        ok: true,
        number,
        url,
        parent: request.parent,
        linked,
        ...(linkError !== undefined && { linkError }),
        closed: closed.exitCode === 0,
        ...(closed.exitCode !== 0 && { closeError: fail(closed, "gh issue close") }),
      };
    },
  };
}

/**
 * The repo's tracker, or null for TRACKER-LESS MODE — no remote, no auth, no
 * network. `gh repo view` is the same check `argus up` uses, so the eye and
 * the converger agree on what "has a tracker" means.
 */
export async function detectTracker(
  repo: string,
  run: GhRunner = defaultRunner,
): Promise<Tracker | null> {
  const viewed = await run(
    ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"],
    repo,
  );
  if (viewed.exitCode !== 0) return null;
  const name = viewed.stdout.trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(name)) return null;
  return createTracker(name, repo, run);
}
