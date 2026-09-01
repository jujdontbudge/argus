/**
 * The fake `gh` (SPEC §13 testing policy): an in-memory GitHub that answers
 * exactly the calls `./gh.ts` makes and records every invocation verbatim.
 *
 * It exists so the Retro eye's real filing path — create, read the DB id,
 * link through the sub_issues API, close — runs end to end under `bun test`
 * and in harness scenarios WITHOUT a single write reaching GitHub. Assertions
 * are made against `calls` (the argv actually built) and `issues` (the state
 * a real tracker would have ended in).
 */
import type { CommandResult, GhRunner } from "./gh";

export interface FakeGhIssue {
  number: string;
  /** GitHub's database id — what the sub_issues API takes, never the number. */
  id: number;
  title: string;
  body: string;
  labels: string[];
  state: "open" | "closed";
  closeReason: string | null;
  /** Parent issue number when linked as a sub-issue. */
  parent: number | null;
  /** GitHub assignee logins — the claim in SPEC §7.3.2 is an assignment. */
  assignees: string[];
  /** Issue numbers this one is blocked by (GitHub issue dependencies). */
  blockedBy: number[];
  /** Comments posted on it, in order — #57 comments every refusal. */
  comments: string[];
  /** Comments returned by the read-only issue comments API. */
  threadComments: FakeGhCommentSeed[];
  /** Timeline metadata used by frontier auto-unpause tests. */
  timeline: FakeGhTimelineEvent[];
}

export interface FakeGhCommentSeed {
  body: string;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  /** Compatibility spelling used by dispatch-context fixtures. */
  timestamp?: string;
}

export interface FakeGhTimelineEvent {
  event: string;
  created_at: string;
  actor?: { login: string };
  user?: { login: string };
  label?: { name: string };
  changes?: { body?: unknown };
  body?: string;
}

export interface FakeGhSeed {
  number: number;
  title: string;
  body?: string;
  labels?: string[];
  state?: "open" | "closed";
  assignees?: string[];
  blockedBy?: number[];
  /** Seed a sub-issue link without going through the sub_issues API. */
  parent?: number;
  /** Seed comments returned by `gh api .../comments --paginate`. */
  threadComments?: FakeGhCommentSeed[];
  /** Alias for threadComments, kept natural for issue fixtures. */
  comments?: FakeGhCommentSeed[];
  timeline?: FakeGhTimelineEvent[];
}

export interface FakeGhOptions {
  repo?: string;
  /** `gh repo view` fails: no remote, no auth, no network (tracker-less). */
  failView?: string;
  failCreate?: string;
  failLink?: string;
  failClose?: string;
  /** The login `gh api user` reports — the claimer's identity (#56). */
  login?: string;
  /** `gh api user` fails: the dispatcher cannot know who it would claim as. */
  failUser?: string;
  /** `gh issue list` fails: no frontier can be read. */
  failList?: string;
  /** `gh issue edit` (assign/unassign/body) fails: the claim cannot be made. */
  failEdit?: string;
  /** `gh issue comment` fails: a refusal cannot be explained on the ticket. */
  failComment?: string;
  /** The dependency/sub-issue reads fail: blocked-ness is UNKNOWN. */
  failDependencies?: string;
  /** Runs before each call — lets a test simulate a lost claim race. */
  before?: (args: readonly string[]) => void;
}

export interface FakeGh {
  run: GhRunner;
  /** Every gh invocation, in order, without the leading `gh`. */
  calls: string[][];
  issues: FakeGhIssue[];
  /** Every cwd gh was invoked in — proof the eye stays inside the sandbox. */
  cwds: string[];
  seed(issue: FakeGhSeed): FakeGhIssue;
  find(number: string): FakeGhIssue | undefined;
}

const ok = (stdout = ""): CommandResult => ({ exitCode: 0, stdout, stderr: "" });
const err = (stderr: string): CommandResult => ({ exitCode: 1, stdout: "", stderr });

/** Database ids are deliberately unlike issue numbers: id ≠ number, always. */
const ID_BASE = 3_000_000_000;

export function createFakeGh(options: FakeGhOptions = {}): FakeGh {
  const repo = options.repo ?? "fixture-owner/fixture-repo";
  const calls: string[][] = [];
  const cwds: string[] = [];
  const issues: FakeGhIssue[] = [];
  const commentRecords = new WeakMap<FakeGhIssue, FakeGhCommentSeed[]>();
  let nextNumber = 1;

  const add = (seed: FakeGhSeed): FakeGhIssue => {
    const issue: FakeGhIssue = {
      number: String(seed.number),
      id: ID_BASE + seed.number,
      title: seed.title,
      body: seed.body ?? "",
      labels: seed.labels ?? [],
      state: seed.state ?? "open",
      closeReason: null,
      parent: seed.parent ?? null,
      assignees: [...(seed.assignees ?? [])],
      blockedBy: [...(seed.blockedBy ?? [])],
      comments: [],
      threadComments: [...(seed.threadComments ?? seed.comments ?? [])],
      timeline: [...(seed.timeline ?? [])],
    };
    const seededComments = issue.threadComments;
    commentRecords.set(issue, seededComments);
    issue.comments.push(...seededComments.map((comment) => comment.body));
    for (const label of issue.labels) {
      if (
        label === "argus:blocked-on-human" &&
        !issue.timeline.some(
          (event) => event.event === "labeled" && event.label?.name === label,
        )
      ) {
        issue.timeline.push({
          created_at: "2026-08-31T10:00:00Z",
          event: "labeled",
          label: { name: label },
        });
      }
    }
    issues.push(issue);
    nextNumber = Math.max(nextNumber, seed.number + 1);
    return issue;
  };

  const flag = (args: readonly string[], name: string): string | undefined => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };

  const run: GhRunner = async (args, cwd) => {
    options.before?.(args);
    calls.push([...args]);
    cwds.push(cwd);
    const [command, subcommand] = args;

    if (command === "repo" && subcommand === "view") {
      return options.failView ? err(options.failView) : ok(`${repo}\n`);
    }

    if (command === "issue" && subcommand === "list") {
      if (options.failList) return err(options.failList);
      const state = flag(args, "--state") ?? "open";
      // #57 finds the wayfinder map by label, so the fake must filter by one.
      const labels: string[] = [];
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--label" && args[index + 1] !== undefined) {
          labels.push(args[index + 1]!);
        }
      }
      return ok(
        JSON.stringify(
          issues
            .filter((issue) => state === "all" || issue.state === state)
            .filter((issue) => labels.every((label) => issue.labels.includes(label)))
            .map((issue) => ({
              number: Number(issue.number),
              title: issue.title,
              body: issue.body,
              labels: issue.labels.map((name) => ({ name })),
              assignees: issue.assignees.map((login) => ({ login })),
              state: issue.state.toUpperCase(),
            })),
        ),
      );
    }

    if (command === "issue" && subcommand === "view") {
      const issue = issues.find((entry) => entry.number === args[2]);
      if (!issue) return err(`could not resolve to an Issue: ${args[2]}`);
      return ok(
        JSON.stringify({
          number: Number(issue.number),
          title: issue.title,
          body: issue.body,
          labels: issue.labels.map((name) => ({ name })),
          state: issue.state.toUpperCase(),
          assignees: issue.assignees.map((login) => ({ login })),
        }),
      );
    }

    if (command === "issue" && subcommand === "create") {
      if (options.failCreate) return err(options.failCreate);
      const labels: string[] = [];
      for (let index = 0; index < args.length; index += 1) {
        if (args[index] === "--label" && args[index + 1] !== undefined) {
          labels.push(args[index + 1]!);
        }
      }
      const issue = add({
        number: nextNumber,
        title: flag(args, "--title") ?? "",
        body: flag(args, "--body") ?? "",
        labels,
      });
      return ok(`https://github.com/${repo}/issues/${issue.number}\n`);
    }

    if (command === "label" && subcommand === "list") {
      return ok(
        JSON.stringify(
          [...new Set(issues.flatMap((issue) => issue.labels))].map((name) => ({ name })),
        ),
      );
    }

    if (command === "label" && subcommand === "create") {
      return ok("");
    }

    if (command === "issue" && subcommand === "edit") {
      if (options.failEdit) return err(options.failEdit);
      const issue = issues.find((entry) => entry.number === args[2]);
      if (!issue) return err(`no issue ${args[2]}`);
      for (let index = 0; index < args.length; index += 1) {
        const value = args[index + 1];
        if (value === undefined) continue;
        if (args[index] === "--add-assignee" && !issue.assignees.includes(value)) {
          issue.assignees.push(value);
        }
        if (args[index] === "--remove-assignee") {
          issue.assignees = issue.assignees.filter((entry) => entry !== value);
        }
        if (args[index] === "--add-label" && !issue.labels.includes(value)) {
          issue.labels.push(value);
          issue.timeline.push({
            created_at: new Date().toISOString(),
            event: "labeled",
            label: { name: value },
          });
        }
        if (args[index] === "--remove-label") {
          issue.labels = issue.labels.filter((entry) => entry !== value);
        }
        // The wayfinder map update (#57) rewrites the map issue's body.
        if (args[index] === "--body") issue.body = value;
      }
      return ok("");
    }

    if (command === "issue" && subcommand === "comment") {
      if (options.failComment) return err(options.failComment);
      const issue = issues.find((entry) => entry.number === args[2]);
      if (!issue) return err(`no issue ${args[2]}`);
      const body = flag(args, "--body") ?? "";
      issue.comments.push(body);
      const now = new Date().toISOString();
      commentRecords.get(issue)!.push({
        author: options.login ?? "argus-bot",
        body,
        createdAt: now,
        updatedAt: now,
      });
      return ok("");
    }

    if (command === "issue" && subcommand === "close") {
      if (options.failClose) return err(options.failClose);
      const issue = issues.find((entry) => entry.number === args[2]);
      if (!issue) return err(`no issue ${args[2]}`);
      issue.state = "closed";
      issue.closeReason = flag(args, "--reason") ?? null;
      const closing = flag(args, "--comment");
      if (closing !== undefined) issue.comments.push(closing);
      return ok("");
    }

    if (command === "api") {
      const path = args[1] ?? "";
      if (path === "user") {
        if (options.failUser) return err(options.failUser);
        return ok(`${options.login ?? "argus-bot"}\n`);
      }
      const timeline = path.match(/^repos\/(.+)\/issues\/(\d+)\/timeline$/);
      if (timeline) {
        const issue = issues.find((entry) => entry.number === timeline[2]);
        if (!issue) return err(`no issue ${timeline[2]}`);
        return ok(JSON.stringify([issue.timeline]));
      }
      const issueComments = path.match(/^repos\/(.+)\/issues\/(\d+)\/comments$/);
      if (issueComments) {
        const issue = issues.find((entry) => entry.number === issueComments[2]);
        if (!issue) return err(`no issue ${issueComments[2]}`);
        return ok(
          JSON.stringify(
            (commentRecords.get(issue) ?? []).map((comment) => ({
              body: comment.body,
              created_at:
                comment.createdAt ?? comment.timestamp ?? "2026-08-31T10:00:00Z",
              updated_at:
                comment.updatedAt ?? comment.createdAt ?? comment.timestamp ??
                "2026-08-31T10:00:00Z",
              user: { login: comment.author ?? "argus-bot" },
            })),
          ),
        );
      }
      const blocked = path.match(/^repos\/(.+)\/issues\/(\d+)\/dependencies\/blocked_by$/);
      if (blocked) {
        if (options.failDependencies) return err(options.failDependencies);
        const issue = issues.find((entry) => entry.number === blocked[2]);
        if (!issue) return err(`no issue ${blocked[2]}`);
        return ok(
          JSON.stringify(
            issue.blockedBy.flatMap((number) => {
              const dependency = issues.find(
                (entry) => entry.number === String(number),
              );
              return dependency
                ? [{ number, state: dependency.state, title: dependency.title }]
                : [{ number, state: "open", title: `Issue #${number}` }];
            }),
          ),
        );
      }
      const children = path.match(/^repos\/(.+)\/issues\/(\d+)\/sub_issues$/);
      if (children && !args.includes("-F")) {
        if (options.failDependencies) return err(options.failDependencies);
        const issue = issues.find((entry) => entry.number === children[2]);
        if (!issue) return err(`no issue ${children[2]}`);
        return ok(
          JSON.stringify(
            issues
              .filter((entry) => entry.parent === Number(issue.number))
              .map((entry) => ({
                number: Number(entry.number),
                state: entry.state,
                title: entry.title,
              })),
          ),
        );
      }
      const link = path.match(/^repos\/(.+)\/issues\/(\d+)\/sub_issues$/);
      if (link) {
        if (options.failLink) return err(options.failLink);
        const parent = issues.find((entry) => entry.number === link[2]);
        if (!parent) return err(`no parent issue ${link[2]}`);
        const id = Number(flag(args, "-F")?.replace(/^sub_issue_id=/, ""));
        const child = issues.find((entry) => entry.id === id);
        if (!child) return err(`no issue with database id ${id}`);
        child.parent = Number(parent.number);
        return ok(JSON.stringify({ id: child.id, number: Number(child.number) }));
      }
      const read = path.match(/^repos\/(.+)\/issues\/(\d+)$/);
      if (read) {
        const issue = issues.find((entry) => entry.number === read[2]);
        if (!issue) return err(`no issue ${read[2]}`);
        const jq = flag(args, "--jq");
        return ok(
          jq === ".id"
            ? `${issue.id}\n`
            : JSON.stringify({ id: issue.id, number: Number(issue.number) }),
        );
      }
      return err(`fake gh: unsupported api path ${path}`);
    }

    return err(`fake gh: unsupported command ${args.join(" ")}`);
  };

  return {
    run,
    calls,
    issues,
    cwds,
    seed: add,
    find: (number) => issues.find((issue) => issue.number === number),
  };
}
