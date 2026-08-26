import { describe, expect, test } from "bun:test";

import { launchLine, shellQuote } from "./launch.ts";

/**
 * Ticket #62 — the grill session is LAUNCHED BY TYPING into a fresh cmux
 * shell, because §5 rule 1 forbids the alternative: `cmux new-workspace
 * --command <claude …>` would start the session at workspace-creation time,
 * which is before the registry row can exist.
 *
 * Typing into a shell puts the whole quoting burden here, and the dispatch
 * prompt is multi-line. A real newline typed into a terminal SUBMITS the line,
 * so the command has to be exactly one physical line whose argv still carries
 * real newlines — otherwise the prompt that lands in the transcript is not the
 * prompt the registry recorded, its hash misses, and it classifies as JOHAN.
 * That is the poisoning path, reached by a quoting bug.
 *
 * So the quoting is asserted against a real shell rather than against my
 * reading of one.
 */
async function shellExpands(quoted: string): Promise<string> {
  const child = Bun.spawn(["/bin/zsh", "-c", `printf %s ${quoted}`], {
    stderr: "pipe",
    stdout: "pipe",
  });
  const [code, out, err] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`zsh exited ${code}: ${err}`);
  return out;
}

describe("shellQuote (#62): one physical line, byte-identical argv", () => {
  test("a multi-line prompt survives a real shell unchanged", async () => {
    const prompt = "Grill me on #62.\n\nThe topic:\n  - provenance\n  - cmux\n";
    const quoted = shellQuote(prompt);
    expect(quoted).not.toContain("\n");
    expect(await shellExpands(quoted)).toBe(prompt);
  });

  test("quotes, backslashes, dollars and backticks survive a real shell", async () => {
    const nasty = `it's "$HOME" \\ \`whoami\` $(id) 100% \t tab`;
    const quoted = shellQuote(nasty);
    expect(quoted).not.toContain("\n");
    expect(await shellExpands(quoted)).toBe(nasty);
  });

  test("the empty string is still a single argument", async () => {
    expect(await shellExpands(shellQuote(""))).toBe("");
  });
});

describe("launchLine (#62): subscription mode survives Johan's own shell", () => {
  test("the three credential variables are unset at the command", async () => {
    // SPEC §1 items 7 and 8: subscriptions only, never an API key and never
    // metered access. Every other spawn in the tree gets this from
    // `subscriptionEnv`, which BUILDS the child environment; a grill is typed
    // into Johan's own shell and inherits his environment instead, so the
    // unsetting has to happen at the command or it does not happen at all.
    const line = launchLine("claude", ["claude", "--session-id", "abc", "hello"]);
    expect(line.split("\n")).toHaveLength(1);
    for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
      expect(line).toContain(name);
    }

    // Asserted through a real shell, because "the line mentions the variable"
    // and "the variable is gone from the child" are different claims.
    const child = Bun.spawn(
      ["/bin/zsh", "-c", line.replace(/\$'claude'/, "$'printenv'")],
      {
        env: { ...Bun.env, ANTHROPIC_API_KEY: "sk-should-not-survive" },
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    const [, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(out).not.toContain("sk-should-not-survive");
  });

  /**
   * #89. The live drive's actual failure: `startGrill` reported `started`, a
   * real Claude session ran, and every one of the five §14 stores stayed empty
   * — because the session ran in the host workspace's directory instead of the
   * repo the deployment named. `WorkerSpawnRequest.cwd` carried the right
   * answer the whole time and this route dropped it.
   */
  test("the deployment's cwd reaches the shell, through a real shell", async () => {
    const line = launchLine("claude", ["claude", "hello"], "/tmp");

    expect(line.split("\n")).toHaveLength(1);
    expect(line.startsWith("cd ")).toBe(true);

    // `pwd` through zsh, because "the line contains the path" and "the command
    // runs there" are different claims — the same distinction the credential
    // assertion above draws.
    const child = Bun.spawn(
      // A function replacement: in a string one, `$'` is the "text after the
      // match" pattern and would silently rebuild the line.
      ["/bin/zsh", "-c", line.replace(/\$'claude'.*/, () => "$'pwd'")],
      { env: { ...Bun.env }, stderr: "pipe", stdout: "pipe" },
    );
    const [, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    // The logical path: `cd` exports PWD and `pwd` reports it, which is
    // exactly what the session inherits.
    expect(out.trim()).toBe("/tmp");
  });

  /** `&&`, so a failed `cd` cannot fall through into the wrong directory. */
  test("a cd that fails does not start the session anyway", async () => {
    const line = launchLine("claude", ["claude", "hello"], "/no/such/directory");
    const child = Bun.spawn(
      ["/bin/zsh", "-c", line.replace(/\$'claude'.*/, () => "$'pwd'")],
      { env: { ...Bun.env }, stderr: "pipe", stdout: "pipe" },
    );
    const [code, out] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
    ]);
    expect(code).not.toBe(0);
    expect(out.trim()).toBe("");
  });

  /** Callers that never had a cwd keep the exact line they had. */
  test("no cwd is still a bare command", () => {
    expect(launchLine("claude", ["claude", "hello"]).startsWith("cd ")).toBe(false);
  });
});
