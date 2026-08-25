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
}

export interface FakeGhSeed {
  number: number;
  title: string;
  body?: string;
  labels?: string[];
  state?: "open" | "closed";
}

export interface FakeGhOptions {
  repo?: string;
  /** `gh repo view` fails: no remote, no auth, no network (tracker-less). */
  failView?: string;
  failCreate?: string;
  failLink?: string;
  failClose?: string;
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
      parent: null,
    };
    issues.push(issue);
    nextNumber = Math.max(nextNumber, seed.number + 1);
    return issue;
  };

  const flag = (args: readonly string[], name: string): string | undefined => {
    const at = args.indexOf(name);
    return at >= 0 ? args[at + 1] : undefined;
  };

  const run: GhRunner = async (args, cwd) => {
    calls.push([...args]);
    cwds.push(cwd);
    const [command, subcommand] = args;

    if (command === "repo" && subcommand === "view") {
      return options.failView ? err(options.failView) : ok(`${repo}\n`);
    }

    if (command === "issue" && subcommand === "list") {
      const state = flag(args, "--state") ?? "open";
      return ok(
        JSON.stringify(
          issues
            .filter((issue) => state === "all" || issue.state === state)
            .map((issue) => ({
              number: Number(issue.number),
              title: issue.title,
              body: issue.body,
              labels: issue.labels.map((name) => ({ name })),
            })),
        ),
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

    if (command === "issue" && subcommand === "close") {
      if (options.failClose) return err(options.failClose);
      const issue = issues.find((entry) => entry.number === args[2]);
      if (!issue) return err(`no issue ${args[2]}`);
      issue.state = "closed";
      issue.closeReason = flag(args, "--reason") ?? null;
      return ok("");
    }

    if (command === "api") {
      const path = args[1] ?? "";
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
