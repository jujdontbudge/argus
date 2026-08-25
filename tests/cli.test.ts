import { describe, expect, test } from "bun:test";

const checkout = new URL("..", import.meta.url).pathname;
const cli = new URL("../src/cli.ts", import.meta.url).pathname;
const oldBunPreload = new URL("./fixtures/old-bun.ts", import.meta.url).pathname;

async function runCli(args: string[], bunArgs: string[] = []) {
  const child = Bun.spawn([process.execPath, ...bunArgs, cli, ...args], {
    cwd: checkout,
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

describe("argus CLI", () => {
  test("--help lists the ticket-owned subcommands", async () => {
    const result = await runCli(["--help"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    for (const command of ["up", "down", "status", "watch", "search", "install"]) {
      expect(result.stdout).toContain(command);
    }
  });

  test("startup refuses a Bun version below the hard floor", async () => {
    const result = await runCli(["--help"], ["--preload", oldBunPreload]);

    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("requires Bun >= 1.3.12");
    expect(result.stderr).toContain("found 1.2.99");
  });
});
