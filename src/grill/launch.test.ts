import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { CmuxRun } from "../events";
import { createCmuxLaunch, launchLine, shellQuote } from "./launch.ts";

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
    const line = launchLine("/usr/bin/printenv", ["/usr/bin/printenv"]);
    expect(line.split("\n")).toHaveLength(1);
    // Asserted through a real shell rather than through plaintext command
    // representation: cmux-safe transport intentionally encodes every dynamic
    // value, while the behavior we need is that none reaches the child.
    const child = Bun.spawn(["/bin/zsh", "-c", line], {
      env: {
        ...Bun.env,
        ANTHROPIC_API_KEY: "argus-test-api-key",
        ANTHROPIC_AUTH_TOKEN: "argus-test-auth-token",
        CLAUDE_CODE_OAUTH_TOKEN: "argus-test-oauth-token",
      },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    expect(out).not.toContain("argus-test-api-key");
    expect(out).not.toContain("argus-test-auth-token");
    expect(out).not.toContain("argus-test-oauth-token");
  });

  /**
   * #89. The live drive's actual failure: `startGrill` reported `started`, a
   * real Claude session ran, and every one of the five §14 stores stayed empty
   * — because the session ran in the host workspace's directory instead of the
   * repo the deployment named. `WorkerSpawnRequest.cwd` carried the right
   * answer the whole time and this route dropped it.
   */
  test("the deployment's cwd reaches the shell, through a real shell", async () => {
    const line = launchLine("/bin/pwd", ["/bin/pwd"], "/tmp");

    expect(line.split("\n")).toHaveLength(1);
    expect(line.startsWith("cd ")).toBe(true);

    // `pwd` through zsh, because "the line contains the path" and "the command
    // runs there" are different claims — the same distinction the credential
    // assertion above draws.
    const child = Bun.spawn(["/bin/zsh", "-c", line], {
      env: { ...Bun.env },
      stderr: "pipe",
      stdout: "pipe",
    });
    const [, out] = await Promise.all([child.exited, new Response(child.stdout).text()]);
    // The logical path: `cd` exports PWD and `pwd` reports it, which is
    // exactly what the session inherits.
    expect(out.trim()).toBe("/tmp");
  });

  /** `&&`, so a failed `cd` cannot fall through into the wrong directory. */
  test("a cd that fails does not start the session anyway", async () => {
    const line = launchLine("/bin/pwd", ["/bin/pwd"], "/no/such/directory");
    const child = Bun.spawn(["/bin/zsh", "-c", line], {
      env: { ...Bun.env },
      stderr: "pipe",
      stdout: "pipe",
    });
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

describe("createCmuxLaunch (#122): bounded terminal transport", () => {
  test("delivers a long multiline argv value without crossing cmux's input boundary", async () => {
    const dir = await mkdtemp(join(tmpdir(), "argus-grill-launch-"));
    const output = join(dir, "received.txt");
    const prompt = Array.from(
      { length: 300 },
      (_, index) => `decision ${index}: preserve quotes ' \" and \\ backslashes`,
    ).join("\n");
    let typed = "";
    try {
      const cmux: CmuxRun = async (args) => {
        if (args[0] === "list-workspaces") {
          return { exitCode: 0, stderr: "", stdout: "workspace:8\n" };
        }
        if (args[0] === "list-pane-surfaces") {
          return { exitCode: 0, stderr: "", stdout: "surface:92\n" };
        }
        if (args[0] === "send") {
          typed = (args.at(-1) ?? "").slice(0, 1_000);
          return { exitCode: 0, stderr: "", stdout: "" };
        }
        if (args[0] === "send-key") {
          const child = Bun.spawn(["/bin/zsh", "-c", typed], {
            stderr: "pipe",
            stdout: "pipe",
          });
          const [code, stderr] = await Promise.all([
            child.exited,
            new Response(child.stderr).text(),
          ]);
          return { exitCode: code, stderr, stdout: "" };
        }
        throw new Error(`unexpected cmux call: ${args.join(" ")}`);
      };
      const spawn = createCmuxLaunch({
        cmux,
        inputSurface: "surface:92",
        surface: "706E40BA-AA9D-4F3A-BF98-3C04FB9011D6",
        workspace: "workspace:8",
      });

      await spawn({
        agent: "claude",
        command: [
          "/bin/sh",
          "-c",
          `printf %s "$1" > ${JSON.stringify(output)}`,
          "argus-grill-test",
          prompt,
        ],
        cwd: dir,
        env: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        executable: "/bin/sh",
      });

      expect(typed.length).toBeLessThan(1_000);
      expect(await readFile(output, "utf8")).toBe(prompt);
    } finally {
      await rm(dir, { force: true, recursive: true });
    }
  });
});
