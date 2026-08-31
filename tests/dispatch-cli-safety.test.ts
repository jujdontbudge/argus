import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function runCli(args: string[], cwd: string) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd,
    env: { ...Bun.env },
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stderr, stdout };
}

describe("argus dispatch CLI safety (#122)", () => {
  test("--help prints subcommand help without entering dispatch", async () => {
    const outside = await mkdtemp(join(tmpdir(), "argus-not-a-repo-"));
    try {
      const result = await runCli(["dispatch", "--help"], outside);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("Usage: argus dispatch");
      expect(result.stdout).not.toContain("sessions in flight");
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });

  test("positional ticket numbers are rejected before entering dispatch", async () => {
    const outside = await mkdtemp(join(tmpdir(), "argus-not-a-repo-"));
    try {
      const result = await runCli(["dispatch", "16"], outside);

      expect(result.exitCode).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("argus dispatch: unknown argument '16'");
      expect(result.stderr).toContain("Usage: argus dispatch");
      expect(result.stderr).not.toContain("not inside a git repository");
    } finally {
      await rm(outside, { force: true, recursive: true });
    }
  });
});
