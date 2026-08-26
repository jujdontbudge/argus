import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  rm,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const sandboxes: string[] = [];

setDefaultTimeout(90_000);

async function run(
  command: string[],
  cwd: string,
  env: Record<string, string>,
) {
  const child = Bun.spawn(command, {
    cwd,
    env: { ...Bun.env, ...env },
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

async function createScratchRepo(name = "repo"): Promise<{
  env: Record<string, string>;
  repo: string;
  root: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "argus-up-"));
  sandboxes.push(root);
  const home = join(root, "home");
  const repoPath = join(root, name);
  await Promise.all([mkdir(home), mkdir(repoPath)]);
  const repo = await realpath(repoPath);
  const env = {
    ARGUS_REPOS_FILE: join(root, "state", "argus-repos"),
    CLAUDE_CONFIG_DIR: join(root, "state", "claude"),
    GIT_AUTHOR_EMAIL: "test@invalid.example",
    GIT_AUTHOR_NAME: "Argus Test",
    GIT_COMMITTER_EMAIL: "test@invalid.example",
    GIT_COMMITTER_NAME: "Argus Test",
    HOME: home,
    HERMES_HOME: join(root, "state", "hermes"),
    HONCHO_API_KEY: "",
  };
  expect((await run(["git", "init", "--quiet"], repo, env)).exitCode).toBe(0);
  expect(
    (
      await run(
        ["git", "commit", "--quiet", "--allow-empty", "-m", "initial"],
        repo,
        {
          ...env,
          GIT_AUTHOR_EMAIL: "test@invalid.example",
          GIT_AUTHOR_NAME: "Argus Test",
          GIT_COMMITTER_EMAIL: "test@invalid.example",
          GIT_COMMITTER_NAME: "Argus Test",
        },
      )
    ).exitCode,
  ).toBe(0);
  return { env, repo, root };
}

async function runUp(repo: string, env: Record<string, string>) {
  return run([process.execPath, cli, "up"], repo, env);
}

afterEach(async () => {
  await Promise.all(
    sandboxes.splice(0).map((path) =>
      rm(path, { force: true, recursive: true }),
    ),
  );
});

describe("argus up", () => {
  test("converges configured Honcho and Hermes bindings through the CLI", async () => {
    const requests: Array<{ body: unknown; path: string }> = [];
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests.push({
          body: await request.json(),
          path: new URL(request.url).pathname,
        });
        return Response.json({}, { status: 201 });
      },
    });
    const { env, repo } = await createScratchRepo("scratch-fake-honcho");
    await mkdir(join(repo, ".argus"), { recursive: true });
    await Bun.write(
      join(repo, ".argus", "config.yaml"),
      `honcho:
  url: http://127.0.0.1:${server.port}
`,
    );

    try {
      const result = await runUp(repo, {
        ...env,
        HONCHO_API_KEY: "scratch-token",
      });

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(
        "Honcho binding: argus-scratch-fake-honcho (created)",
      );
      expect(result.stdout).toContain(
        "Hermes profile: argus-scratch-fake-honcho",
      );
      expect(requests).toHaveLength(5);
      expect(requests[0]).toEqual({
        body: {
          id: "argus-scratch-fake-honcho",
          metadata: { repo },
        },
        path: "/v3/workspaces",
      });
      expect(
        (
          await lstat(
            join(
              env.HERMES_HOME!,
              "profiles",
              "argus-scratch-fake-honcho",
              "memories",
            ),
          )
        ).isSymbolicLink(),
      ).toBe(true);
    } finally {
      server.stop(true);
    }
  });

  test("scaffolds the per-repo Argus layout and ignores Argus state", async () => {
    const { env, repo } = await createScratchRepo();

    const result = await runUp(repo, env);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(
      "HONCHO DEGRADED: http://localhost:8000 unavailable",
    );
    expect(result.stderr).toContain("local bindings converged");
    for (const directory of [
      "registry",
      "memory",
      "skills",
      "sessions",
      "events",
    ]) {
      expect((await lstat(join(repo, ".argus", directory))).isDirectory()).toBe(
        true,
      );
    }
    const scaffolded = await Bun.file(join(repo, ".argus/config.yaml")).text();
    expect(scaffolded).toContain("# brain:");
    for (const eye of ["reviewer", "digest", "retro"]) {
      expect(scaffolded).toContain(
        `# ${eye}:\n#   brain:\n#     model: gpt-5.6-luna\n#     reasoning_effort: low`,
      );
    }
    // SPEC §7.3.3's cap is a knob a human is meant to find and raise (#56).
    expect(scaffolded).toContain("# dispatch:");
    expect(scaffolded).toContain("#   max_concurrency: 3");
    // Everything Argus generates that must not be committed, including the
    // machine-local Claude hook settings `up` writes (#67).
    expect(await Bun.file(join(repo, ".gitignore")).text()).toBe(
      ".argus/\n.claude/skills\n.claude/settings.local.json\n",
    );
    // #67: the working-tree entry is what makes git ignore `.argus/`. Argus
    // does not commit on a user's behalf; it says what to commit.
    expect(
      (await run(["git", "show", "HEAD:.gitignore"], repo, env)).exitCode,
    ).not.toBe(0);
    expect(result.stdout).toContain("Committed nothing");
  });

  test("commits the integration files only when explicitly asked", async () => {
    const { env, repo } = await createScratchRepo();

    const first = await run([process.execPath, cli, "up", "--commit"], repo, env);

    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("Committed .gitignore, AGENTS.md, docs/agents");
    const tracked = (
      await run(["git", "ls-tree", "-r", "--name-only", "HEAD"], repo, env)
    ).stdout;
    expect(tracked).toContain(".gitignore");
    expect(tracked).toContain("AGENTS.md");
    expect(tracked).toContain("docs/agents/domain.md");
    const headAfterFirst = (await run(["git", "rev-parse", "HEAD"], repo, env))
      .stdout;

    const second = await run([process.execPath, cli, "up", "--commit"], repo, env);

    expect(second.exitCode).toBe(0);
    expect((await run(["git", "rev-parse", "HEAD"], repo, env)).stdout).toBe(
      headAfterFirst,
    );
    expect(second.stdout).toContain("Integration files: already committed");
  });

  test("seeds the memory pair it points at and leaves edited memory alone", async () => {
    const { env, repo } = await createScratchRepo();

    expect((await runUp(repo, env)).exitCode).toBe(0);

    const memoryDir = join(repo, ".argus/memory");
    expect((await Bun.file(join(memoryDir, "USER.md")).text()).startsWith(
      "# USER.md\n",
    )).toBe(true);
    expect(
      (await Bun.file(join(memoryDir, "MEMORY.md")).text()).startsWith(
        "# Memory index\n",
      ),
    ).toBe(true);

    const edited = "# Memory index\n\n- [Metro](metro.md) — runs on 8082\n";
    await Bun.write(join(memoryDir, "MEMORY.md"), edited);

    expect((await runUp(repo, env)).exitCode).toBe(0);

    expect(await Bun.file(join(memoryDir, "MEMORY.md")).text()).toBe(edited);
  });

  test("verifies the wiring it wrote and reports cmux capability honestly", async () => {
    const { env, repo } = await createScratchRepo();
    await mkdir(join(repo, ".argus/skills/example"), { recursive: true });
    await Bun.write(join(repo, ".argus/skills/example/SKILL.md"), "# Example\n");

    const result = await runUp(repo, {
      ...env,
      // cmux is optional; an absent binary must never make convergence fail.
      PATH: "/usr/bin:/bin",
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "wiring: claude skills adapter OK (1 canonical skill readable through .claude/skills)",
    );
    expect(result.stdout).toContain("wiring: AGENTS.md pointers OK (6/6 resolve)");
    expect(result.stdout).toContain(
      "wiring: Hermes memory binding OK (profile memories -> .argus/memory)",
    );
    expect(result.stdout).toContain("cmux hooks: optional");
    expect(result.stdout).toContain("cmux not installed");
  });

  test("moves Claude project memory into Argus and symlinks it back", async () => {
    const { env, repo } = await createScratchRepo();
    const claudeMemory = join(
      env.CLAUDE_CONFIG_DIR!,
      "projects",
      repo.replaceAll("/", "-"),
      "memory",
    );
    await mkdir(join(claudeMemory, "facts"), { recursive: true });
    await Bun.write(join(claudeMemory, "MEMORY.md"), "Claude memory\n");
    await Bun.write(join(claudeMemory, "facts/tooling.md"), "Use Bun\n");

    expect((await runUp(repo, env)).exitCode).toBe(0);

    expect(await Bun.file(join(repo, ".argus/memory/MEMORY.md")).text()).toBe(
      "Claude memory\n",
    );
    expect(
      await Bun.file(join(repo, ".argus/memory/facts/tooling.md")).text(),
    ).toBe("Use Bun\n");
    expect((await lstat(claudeMemory)).isSymbolicLink()).toBe(true);
    expect(await readlink(claudeMemory)).toBe(join(repo, ".argus/memory"));
  });

  test("merges pre-existing Argus and Claude memory without clobbering either", async () => {
    const { env, repo } = await createScratchRepo();
    const claudeMemory = join(
      env.CLAUDE_CONFIG_DIR!,
      "projects",
      repo.replaceAll("/", "-"),
      "memory",
    );
    await mkdir(claudeMemory, { recursive: true });
    await mkdir(join(repo, ".argus/memory"), { recursive: true });
    await Bun.write(join(claudeMemory, "MEMORY.md"), "Claude version\n");
    await Bun.write(join(claudeMemory, "new-fact.md"), "New fact\n");
    await Bun.write(join(repo, ".argus/memory/MEMORY.md"), "Argus version\n");

    expect((await runUp(repo, env)).exitCode).toBe(0);

    expect(await Bun.file(join(repo, ".argus/memory/MEMORY.md")).text()).toBe(
      "Argus version\n",
    );
    expect(await Bun.file(join(repo, ".argus/memory/new-fact.md")).text()).toBe(
      "New fact\n",
    );
    expect(
      await Bun.file(
        join(repo, ".argus/memory/claude-imported/MEMORY.md"),
      ).text(),
    ).toBe("Claude version\n");
    expect((await lstat(claudeMemory)).isSymbolicLink()).toBe(true);
  });

  test("installs Claude skill adapters and an idempotent AGENTS pointer block", async () => {
    const { env, repo } = await createScratchRepo();
    await mkdir(join(repo, ".argus/skills/example"), { recursive: true });
    await Bun.write(join(repo, ".argus/skills/example/SKILL.md"), "# Example\n");
    await Bun.write(join(repo, "AGENTS.md"), "# Repository guidance\n");

    expect((await runUp(repo, env)).exitCode).toBe(0);
    expect(await readlink(join(repo, ".claude/skills"))).toBe(
      "../.argus/skills",
    );
    expect(
      await Bun.file(join(repo, ".claude/skills/example/SKILL.md")).text(),
    ).toBe("# Example\n");
    const firstAgents = await Bun.file(join(repo, "AGENTS.md")).text();
    expect(firstAgents).toContain(".argus/memory/USER.md");
    expect(firstAgents).toContain(".argus/memory/MEMORY.md");
    expect(firstAgents).toContain(".argus/skills/");
    expect(firstAgents).toContain('argus search "<query>"');

    expect((await runUp(repo, env)).exitCode).toBe(0);
    const repeatedAgents = await Bun.file(join(repo, "AGENTS.md")).text();
    expect(repeatedAgents).toBe(firstAgents);
    expect(repeatedAgents.match(/<!-- argus:begin -->/g)).toHaveLength(1);
  });

  test("converges partial adapters and refreshes duplicate pointer blocks", async () => {
    const { env, repo } = await createScratchRepo();
    await mkdir(join(repo, ".claude/skills/local"), { recursive: true });
    await Bun.write(join(repo, ".claude/skills/local/SKILL.md"), "# Local\n");
    await Bun.write(
      join(repo, "AGENTS.md"),
      "Before\n\n<!-- argus:begin -->\nstale one\n<!-- argus:end -->\n\n" +
        "Middle\n\n<!-- argus:begin -->\nstale two\n<!-- argus:end -->\n",
    );

    expect((await runUp(repo, env)).exitCode).toBe(0);

    expect((await lstat(join(repo, ".claude/skills"))).isSymbolicLink()).toBe(
      true,
    );
    expect(
      await Bun.file(join(repo, ".argus/skills/local/SKILL.md")).text(),
    ).toBe("# Local\n");
    const agents = await Bun.file(join(repo, "AGENTS.md")).text();
    expect(agents).toContain("Before");
    expect(agents).toContain("Middle");
    expect(agents).not.toContain("stale one");
    expect(agents).not.toContain("stale two");
    expect(agents.match(/<!-- argus:begin -->/g)).toHaveLength(1);
  });

  test("checks the remote with gh, creates only missing Argus labels, and wires tracker docs", async () => {
    const { env, repo, root } = await createScratchRepo();
    expect(
      (
        await run(
          ["git", "remote", "add", "origin", "git@github.com:acme/widgets.git"],
          repo,
          env,
        )
      ).exitCode,
    ).toBe(0);
    const bin = join(root, "bin");
    const ghLog = join(root, "gh.jsonl");
    const gh = join(bin, "gh");
    await mkdir(bin);
    await Bun.write(
      gh,
      `#!/usr/bin/env bun
import { appendFile } from "node:fs/promises";
const args = Bun.argv.slice(2);
await appendFile(Bun.env.GH_FAKE_LOG!, JSON.stringify(args) + "\\n");
if (args[0] === "repo" && args[1] === "view") console.log(JSON.stringify({ nameWithOwner: "acme/widgets" }));
if (args[0] === "label" && args[1] === "list") console.log(JSON.stringify([{ name: "retro" }]));
`,
    );
    await chmod(gh, 0o755);

    const result = await runUp(repo, {
      ...env,
      GH_FAKE_LOG: ghLog,
      PATH: `${bin}:${Bun.env.PATH ?? ""}`,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("GitHub tracker: acme/widgets");
    const calls = (await Bun.file(ghLog).text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as string[]);
    expect(calls[0]).toEqual([
      "repo",
      "view",
      "acme/widgets",
      "--json",
      "nameWithOwner",
    ]);
    expect(calls[1]).toEqual([
      "label",
      "list",
      "--repo",
      "acme/widgets",
      "--limit",
      "100",
      "--json",
      "name",
    ]);
    expect(
      calls
        .filter(([group, action]) => group === "label" && action === "create")
        .map((call) => call[2]),
    ).toEqual([
      "wayfinder:map",
      "wayfinder:research",
      "wayfinder:prototype",
      "wayfinder:grilling",
      "wayfinder:task",
    ]);
    expect(await Bun.file(join(repo, "docs/agents/issue-tracker.md")).text()).toContain(
      "acme/widgets",
    );
    expect(await Bun.file(join(repo, "docs/agents/triage-labels.md")).text()).toContain(
      "ready-for-agent",
    );
    expect(await Bun.file(join(repo, "docs/agents/domain.md")).text()).toContain(
      "single-context",
    );
    expect(await Bun.file(join(repo, "AGENTS.md")).text()).toContain(
      "## Agent skills",
    );
  });

  test("announces tracker-less mode without calling gh when no GitHub remote exists", async () => {
    const { env, repo, root } = await createScratchRepo();
    const bin = join(root, "bin");
    await mkdir(bin);
    await Bun.write(join(bin, "gh"), "#!/bin/sh\nexit 99\n");
    await chmod(join(bin, "gh"), 0o755);

    const result = await runUp(repo, {
      ...env,
      PATH: `${bin}:${Bun.env.PATH ?? ""}`,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("TRACKER-LESS MODE");
    expect(result.stderr).toContain("skipped GitHub labels and tracker checks");
  });

  test("enrolls the repo once in the configurable supervisor registry and reports cmux hooks as optional", async () => {
    const { env, repo } = await createScratchRepo();

    const first = await runUp(repo, env);
    const headAfterFirst = (
      await run(["git", "rev-parse", "HEAD"], repo, env)
    ).stdout;
    const registryAfterFirst = await Bun.file(env.ARGUS_REPOS_FILE!).text();
    const agentsAfterFirst = await Bun.file(join(repo, "AGENTS.md")).text();
    const configAfterFirst = await Bun.file(join(repo, ".argus/config.yaml")).text();
    const second = await runUp(repo, env);

    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain(
      // #7: optional, never a convergence requirement (SPEC §3/§6).
      "cmux hooks: optional (resume convenience; not required for signal delivery)",
    );
    expect(first.stdout).toContain("Argus converged");
    expect(registryAfterFirst).toBe(`${repo}\n`);
    expect(second.exitCode).toBe(0);
    expect(await Bun.file(env.ARGUS_REPOS_FILE!).text()).toBe(registryAfterFirst);
    expect(await Bun.file(join(repo, "AGENTS.md")).text()).toBe(agentsAfterFirst);
    expect(await Bun.file(join(repo, ".argus/config.yaml")).text()).toBe(
      configAfterFirst,
    );
    expect((await run(["git", "rev-parse", "HEAD"], repo, env)).stdout).toBe(
      headAfterFirst,
    );
  });

  test("idempotently converges the Claude Stop hook and Codex notify command", async () => {
    const { env, repo, root } = await createScratchRepo();
    const codexHome = join(root, "state", "codex");
    await mkdir(join(repo, ".claude"), { recursive: true });
    await mkdir(codexHome, { recursive: true });
    await Bun.write(
      join(repo, ".claude", "settings.local.json"),
      JSON.stringify({
        permissions: { allow: ["Read"] },
        hooks: {
          Stop: [
            {
              hooks: [{ type: "command", command: "./custom-stop.sh" }],
            },
          ],
        },
      }),
    );
    await Bun.write(join(codexHome, "config.toml"), 'model = "gpt-5.6-sol"\n');

    const first = await runUp(repo, { ...env, CODEX_HOME: codexHome });
    const second = await runUp(repo, { ...env, CODEX_HOME: codexHome });

    expect(first.exitCode).toBe(0);
    expect(second.exitCode).toBe(0);
    const claude = await Bun.file(
      join(repo, ".claude", "settings.local.json"),
    ).json();
    expect(claude.permissions).toEqual({ allow: ["Read"] });
    expect(claude.hooks.Stop).toHaveLength(2);
    expect(claude.hooks.Stop[0].hooks[0].command).toBe("./custom-stop.sh");
    const argusCommands = claude.hooks.Stop.flatMap(
      (group: { hooks?: Array<{ command?: string }> }) =>
        group.hooks?.map(({ command }) => command ?? "") ?? [],
    ).filter((command: string) => command.includes("ARGUS_HOOK=claude-stop"));
    expect(argusCommands).toHaveLength(1);

    const codex = await Bun.file(join(codexHome, "config.toml")).text();
    expect(codex).toContain('model = "gpt-5.6-sol"');
    expect(codex.match(/^notify = /gm)).toHaveLength(1);
    expect(codex).toContain("scripts/codex-notify.ts");
    expect(codex.match(/# argus:notify:begin/g)).toHaveLength(1);
  });

  test("refuses a non-git directory without creating local or supervisor state", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-up-non-git-"));
    sandboxes.push(root);
    const home = join(root, "home");
    const supervisor = join(root, "state", "argus-repos");
    await mkdir(home);

    const result = await runUp(root, {
      ARGUS_REPOS_FILE: supervisor,
      CLAUDE_CONFIG_DIR: join(root, "state", "claude"),
      HOME: home,
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not inside a git repository");
    expect(await Bun.file(join(root, ".argus/config.yaml")).exists()).toBe(false);
    expect(await Bun.file(supervisor).exists()).toBe(false);
  });

  test("preserves a user's existing ignore file when adding the Argus entry", async () => {
    const { env, repo } = await createScratchRepo();
    await Bun.write(join(repo, ".gitignore"), "node_modules/\n");

    expect((await runUp(repo, env)).exitCode).toBe(0);

    expect(await Bun.file(join(repo, ".gitignore")).text()).toBe(
      "node_modules/\n.argus/\n.claude/skills\n.claude/settings.local.json\n",
    );
  });

  test("degrades to tracker-less mode when gh is unavailable", async () => {
    const { env, repo } = await createScratchRepo();
    expect(
      (
        await run(
          ["git", "remote", "add", "origin", "https://github.com/acme/widgets.git"],
          repo,
          env,
        )
      ).exitCode,
    ).toBe(0);

    const result = await runUp(repo, { ...env, PATH: "/usr/bin:/bin" });

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("TRACKER-LESS MODE");
    expect(result.stderr).toContain("gh could not access acme/widgets");
    expect(await Bun.file(join(repo, ".argus/config.yaml")).exists()).toBe(true);
  });
});
