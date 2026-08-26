import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const checkout = fileURLToPath(new URL("../..", import.meta.url));
const sandboxes: string[] = [];

interface Fixture {
  root: string;
  sourceDir: string;
  source: string;
  output: string;
  repo: string;
}

async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "argus-claude-mem-"));
  sandboxes.push(root);
  const sourceDir = join(root, "retired-store");
  const repo = join(root, "project");
  await mkdir(sourceDir);
  await mkdir(repo);
  const source = join(sourceDir, "claude-mem.db");
  const database = new Database(source, { create: true, strict: true });
  database.run(`
    CREATE TABLE observations (
      id INTEGER PRIMARY KEY,
      project TEXT NOT NULL,
      text TEXT NOT NULL,
      type TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE session_summaries (
      id INTEGER PRIMARY KEY,
      project TEXT NOT NULL,
      request TEXT,
      investigated TEXT,
      learned TEXT,
      completed TEXT,
      next_steps TEXT,
      notes TEXT,
      created_at TEXT NOT NULL
    );
    CREATE TABLE user_prompts (
      id INTEGER PRIMARY KEY,
      project TEXT NOT NULL,
      prompt_text TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);
  database
    .query("INSERT INTO observations VALUES (?, ?, ?, ?, ?)")
    .run(
      7,
      repo,
      "The signing service rejects certificates unless the chain is leaf-first.",
      "discovery",
      "2026-01-02T03:04:05.000Z",
    );
  database
    .query("INSERT INTO session_summaries VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(
      8,
      repo,
      "Debug signing",
      "Certificate order",
      "The service requires a leaf-first chain.",
      "Fixed the uploader",
      null,
      null,
      "2026-01-02T04:00:00.000Z",
    );
  database
    .query("INSERT INTO user_prompts VALUES (?, ?, ?, ?)")
    .run(
      9,
      repo,
      "Always use the staging certificate when testing uploads.",
      "2026-01-02T02:00:00.000Z",
    );
  database.close();
  return { root, sourceDir, source, output: join(root, "plan.json"), repo };
}

async function sourceSnapshot(directory: string): Promise<unknown> {
  const entries = await readdir(directory);
  return await Promise.all(
    entries.sort().map(async (name) => {
      const path = join(directory, name);
      const metadata = await stat(path);
      const bytes = await readFile(path);
      return {
        name,
        mode: metadata.mode,
        mtimeMs: metadata.mtimeMs,
        size: metadata.size,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      };
    }),
  );
}

async function runCli(
  cwd: string,
  args: string[],
  env: Record<string, string | undefined> = {},
) {
  const child = Bun.spawn(
    [process.execPath, join(checkout, "src/cli.ts"), ...args],
    { cwd, env: { ...Bun.env, ...env }, stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

afterEach(async () => {
  for (const root of sandboxes.splice(0)) {
    await chmod(join(root, "retired-store"), 0o755).catch(() => {});
    await chmod(join(root, "retired-store/claude-mem.db"), 0o644).catch(() => {});
    await rm(root, { force: true, recursive: true });
  }
});

describe("the one-time claude-mem retirement migration", () => {
  test("the production plan command opens the source store read-only and mutates nothing", async () => {
    const world = await fixture();
    await chmod(world.source, 0o444);
    await chmod(world.sourceDir, 0o555);
    const before = await sourceSnapshot(world.sourceDir);

    const result = await runCli(world.root, [
      "memory",
      "claude-mem",
      "plan",
      "--source",
      world.source,
      "--output",
      world.output,
    ]);

    expect(result).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `claude-mem plan written to ${world.output}: 3 rows (2 candidates, 1 review-required, 0 skipped)\n`,
    });
    expect(await sourceSnapshot(world.sourceDir)).toEqual(before);
    expect((await readdir(world.sourceDir)).sort()).toEqual(["claude-mem.db"]);

    const plan = await Bun.file(world.output).json();
    expect(plan.kind).toBe("argus.claude-mem-retirement-plan");
    expect(plan.approval).toBeNull();
    expect(plan.source.tables).toEqual({
      observations: 1,
      session_summaries: 1,
      user_prompts: 1,
    });
    expect(plan.entries.map((entry: Record<string, unknown>) => entry.provenance)).toEqual([
      "agent-derived",
      "agent-derived",
      "unverified-user-role",
    ]);
    expect(
      plan.entries.map((entry: Record<string, unknown>) => entry.destinationStore),
    ).toEqual(["MEMORY.md", "MEMORY.md", "MEMORY.md"]);
    expect(JSON.stringify(plan)).not.toContain("USER.md");
  });

  test("import refuses a pending plan and runs only after that exact plan is approved", async () => {
    const world = await fixture();
    expect(
      await runCli(world.root, [
        "memory",
        "claude-mem",
        "plan",
        "--source",
        world.source,
        "--output",
        world.output,
      ]),
    ).toMatchObject({ exitCode: 0 });
    const pending = await Bun.file(world.output).json();
    pending.entries[0].decision = "import";
    await Bun.write(world.output, `${JSON.stringify(pending, null, 2)}\n`);

    const refused = await runCli(world.root, [
      "memory",
      "claude-mem",
      "import",
      "--plan",
      world.output,
    ]);
    expect(refused.exitCode).toBe(1);
    expect(refused.stderr).toContain("plan is not approved");
    expect(await Bun.file(join(world.repo, ".argus/memory/MEMORY.md")).exists()).toBe(
      false,
    );

    const wrong = await runCli(world.root, [
      "memory",
      "claude-mem",
      "approve",
      "--plan",
      world.output,
      "--confirm",
      "not-the-plan-id",
    ]);
    expect(wrong.exitCode).toBe(1);
    expect(wrong.stderr).toContain(`confirmation must exactly match ${pending.id}`);

    const approved = await runCli(world.root, [
      "memory",
      "claude-mem",
      "approve",
      "--plan",
      world.output,
      "--confirm",
      pending.id,
    ]);
    expect(approved.exitCode).toBe(0);
    const approvedPlan = await Bun.file(world.output).json();
    expect(approvedPlan.approval.digest).toMatch(/^[0-9a-f]{64}$/);

    const imported = await runCli(world.root, [
      "memory",
      "claude-mem",
      "import",
      "--plan",
      world.output,
    ]);
    expect(imported).toEqual({
      exitCode: 0,
      stderr: "",
      stdout: `claude-mem import complete: 1 fact into 1 repo; receipt ${world.output}.import.json\n`,
    });
    const memory = join(world.repo, ".argus/memory");
    const fact = await Bun.file(join(memory, "claude-mem-discovery-7.md")).text();
    expect(fact).toContain("The signing service rejects certificates");
    expect(fact).toContain("Import provenance: agent-derived");
    expect(fact).toContain("observations row 7");
    expect(await Bun.file(join(memory, "MEMORY.md")).text()).toContain(
      "claude-mem-discovery-7.md",
    );
    expect(await Bun.file(join(memory, "USER.md")).exists()).toBe(false);
    expect(await Bun.file(`${world.output}.import.json`).json()).toMatchObject({
      status: "complete",
      planId: pending.id,
      imported: 1,
    });
  });

  test("retirement is a separate opt-in command with exact confirmation and preserves the database", async () => {
    const world = await fixture();
    await runCli(world.root, [
      "memory",
      "claude-mem",
      "plan",
      "--source",
      world.source,
      "--output",
      world.output,
    ]);
    const pending = await Bun.file(world.output).json();
    pending.entries[0].decision = "import";
    await Bun.write(world.output, `${JSON.stringify(pending, null, 2)}\n`);
    await runCli(world.root, [
      "memory",
      "claude-mem",
      "approve",
      "--plan",
      world.output,
      "--confirm",
      pending.id,
    ]);
    await runCli(world.root, [
      "memory",
      "claude-mem",
      "import",
      "--plan",
      world.output,
    ]);

    const bin = join(world.root, "bin");
    const log = join(world.root, "claude.log");
    await mkdir(bin);
    await Bun.write(
      join(bin, "claude"),
      '#!/bin/sh\nprintf "%s\\n" "$*" >> "$ARGUS_TEST_CLAUDE_LOG"\n',
    );
    await chmod(join(bin, "claude"), 0o755);
    const env = {
      ARGUS_TEST_CLAUDE_LOG: log,
      PATH: `${bin}:${Bun.env.PATH ?? ""}`,
    };
    const sourceBefore = await readFile(world.source);

    const absent = await runCli(
      world.root,
      ["memory", "claude-mem", "retire", "--plan", world.output],
      env,
    );
    expect(absent.exitCode).toBe(1);
    expect(await Bun.file(log).exists()).toBe(false);

    const wrong = await runCli(
      world.root,
      [
        "memory",
        "claude-mem",
        "retire",
        "--plan",
        world.output,
        "--confirm",
        "yes",
      ],
      env,
    );
    expect(wrong.exitCode).toBe(1);
    expect(wrong.stderr).toContain(
      `confirmation must exactly match uninstall-claude-mem:${pending.id}`,
    );
    expect(await Bun.file(log).exists()).toBe(false);

    const retired = await runCli(
      world.root,
      [
        "memory",
        "claude-mem",
        "retire",
        "--plan",
        world.output,
        "--confirm",
        `uninstall-claude-mem:${pending.id}`,
      ],
      env,
    );
    expect(retired).toEqual({
      exitCode: 0,
      stderr: "",
      stdout:
        `claude-mem plugin uninstalled; source archive preserved at ${world.source}\n`,
    });
    expect(await Bun.file(log).text()).toBe(
      "plugin uninstall --keep-data --yes claude-mem@thedotmack\n",
    );
    expect(await readFile(world.source)).toEqual(sourceBefore);
  });

  test("approval is invalidated by any later edit to the reviewed plan", async () => {
    const world = await fixture();
    await runCli(world.root, [
      "memory",
      "claude-mem",
      "plan",
      "--source",
      world.source,
      "--output",
      world.output,
    ]);
    const pending = await Bun.file(world.output).json();
    pending.entries[0].decision = "import";
    await Bun.write(world.output, `${JSON.stringify(pending, null, 2)}\n`);
    await runCli(world.root, [
      "memory",
      "claude-mem",
      "approve",
      "--plan",
      world.output,
      "--confirm",
      pending.id,
    ]);
    const changed = await Bun.file(world.output).json();
    changed.entries[0].content = "Content changed after Johan reviewed it.";
    await Bun.write(world.output, `${JSON.stringify(changed, null, 2)}\n`);

    const result = await runCli(world.root, [
      "memory",
      "claude-mem",
      "import",
      "--plan",
      world.output,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("approved plan changed after approval");
    expect(await Bun.file(join(world.repo, ".argus/memory/MEMORY.md")).exists()).toBe(
      false,
    );
  });

  test("an explicitly selected user_prompts row remains unverified project memory, never user memory", async () => {
    const world = await fixture();
    await runCli(world.root, [
      "memory",
      "claude-mem",
      "plan",
      "--source",
      world.source,
      "--output",
      world.output,
    ]);
    const pending = await Bun.file(world.output).json();
    for (const entry of pending.entries) entry.decision = "skip";
    pending.entries[2].decision = "import";
    await Bun.write(world.output, `${JSON.stringify(pending, null, 2)}\n`);
    await runCli(world.root, [
      "memory",
      "claude-mem",
      "approve",
      "--plan",
      world.output,
      "--confirm",
      pending.id,
    ]);
    expect(
      await runCli(world.root, [
        "memory",
        "claude-mem",
        "import",
        "--plan",
        world.output,
      ]),
    ).toMatchObject({ exitCode: 0 });

    const memory = join(world.repo, ".argus/memory");
    const fact = await Bun.file(join(memory, "claude-mem-prompt-9.md")).text();
    expect(fact).toContain("Import provenance: unverified-user-role");
    expect(fact).toContain("user_prompts row 9");
    expect(await Bun.file(join(memory, "USER.md")).exists()).toBe(false);
  });

  test("even an approved edited plan cannot target USER.md", async () => {
    const world = await fixture();
    await runCli(world.root, [
      "memory",
      "claude-mem",
      "plan",
      "--source",
      world.source,
      "--output",
      world.output,
    ]);
    const pending = await Bun.file(world.output).json();
    pending.entries[2].decision = "import";
    pending.entries[2].destinationStore = "USER.md";
    await Bun.write(world.output, `${JSON.stringify(pending, null, 2)}\n`);
    await runCli(world.root, [
      "memory",
      "claude-mem",
      "approve",
      "--plan",
      world.output,
      "--confirm",
      pending.id,
    ]);

    const result = await runCli(world.root, [
      "memory",
      "claude-mem",
      "import",
      "--plan",
      world.output,
    ]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("only MEMORY.md is allowed");
    expect(await Bun.file(join(world.repo, ".argus/memory/USER.md")).exists()).toBe(
      false,
    );
  });
});
