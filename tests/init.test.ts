import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  lstat,
  mkdir,
  mkdtemp,
  readlink,
  realpath,
  rm,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `argus init` is the REPO-LOCAL half of setup (#67).
 *
 * The split this file pins down: `init` writes only things that live inside
 * the repo and can be read by a human — the `.argus/` layout, the seeded
 * memory pair, the adapters, the pointer blocks. It contacts no network, wires
 * no machine state (`~/.codex`, `~/.hermes`, the supervisor registry, launchd),
 * and starts nothing. `argus up` is `init` plus that machine convergence.
 *
 * Everything runs through the production CLI against a scratch repo under a
 * scratch HOME; nothing here may touch the real machine.
 */

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const sandboxes: string[] = [];

setDefaultTimeout(90_000);

async function run(
  command: string[],
  cwd: string,
  env: Record<string, string> = {},
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

async function createScratchRepo(name = "repo") {
  const root = await mkdtemp(join(tmpdir(), "argus-init-"));
  sandboxes.push(root);
  const home = join(root, "home");
  const repoPath = join(root, name);
  await Promise.all([mkdir(home), mkdir(repoPath)]);
  const repo = await realpath(repoPath);
  const env: Record<string, string> = {
    ARGUS_REPOS_FILE: join(root, "state", "argus-repos"),
    CLAUDE_CONFIG_DIR: join(root, "state", "claude"),
    CODEX_HOME: join(root, "state", "codex"),
    GIT_AUTHOR_EMAIL: "test@invalid.example",
    GIT_AUTHOR_NAME: "Argus Test",
    GIT_COMMITTER_EMAIL: "test@invalid.example",
    GIT_COMMITTER_NAME: "Argus Test",
    HERMES_HOME: join(root, "state", "hermes"),
    HOME: home,
    HONCHO_API_KEY: "",
  };
  expect((await run(["git", "init", "--quiet"], repo, env)).exitCode).toBe(0);
  expect(
    (
      await run(
        ["git", "commit", "--quiet", "--allow-empty", "-m", "initial"],
        repo,
        env,
      )
    ).exitCode,
  ).toBe(0);
  return { env, repo, root };
}

function runInit(repo: string, env: Record<string, string>, args: string[] = []) {
  return run([process.execPath, cli, "init", ...args], repo, env);
}

afterEach(async () => {
  await Promise.all(
    sandboxes.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("argus init", () => {
  test("scaffolds the repo and touches no machine state", async () => {
    const { env, repo, root } = await createScratchRepo();

    const result = await runInit(repo, env);

    expect(result.exitCode).toBe(0);
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
    expect(await Bun.file(join(repo, ".argus/config.yaml")).exists()).toBe(true);
    expect(await readlink(join(repo, ".claude/skills"))).toBe("../.argus/skills");
    const agents = await Bun.file(join(repo, "AGENTS.md")).text();
    expect(agents).toContain("<!-- argus:begin -->");
    expect(agents).toContain("<!-- matt-pocock:begin -->");
    expect(await Bun.file(join(repo, ".gitignore")).text()).toBe(
      ".argus/\n.claude/skills\n.claude/settings.local.json\n",
    );
    for (const doc of ["issue-tracker.md", "triage-labels.md", "domain.md"]) {
      expect(await Bun.file(join(repo, "docs/agents", doc)).exists()).toBe(true);
    }

    // The whole point of the split: nothing outside the repo moved.
    expect(await Bun.file(env.ARGUS_REPOS_FILE!).exists()).toBe(false);
    expect(
      await Bun.file(join(root, "state", "codex", "config.toml")).exists(),
    ).toBe(false);
    expect(
      await Bun.file(join(repo, ".claude/settings.local.json")).exists(),
    ).toBe(false);
    expect(await Bun.file(join(root, "state", "hermes")).exists()).toBe(false);
    expect(result.stdout).not.toContain("Hermes profile");
    expect(result.stdout).toContain("Run `argus up`");
  });

  test("seeds the canonical memory pair AGENTS.md points at", async () => {
    const { env, repo } = await createScratchRepo();

    expect((await runInit(repo, env)).exitCode).toBe(0);

    const user = await Bun.file(join(repo, ".argus/memory/USER.md")).text();
    const memory = await Bun.file(join(repo, ".argus/memory/MEMORY.md")).text();
    // Exactly the headers the Reviewer's own writers assume, so the first
    // real finding appends instead of starting a second store.
    expect(user.startsWith("# USER.md\n")).toBe(true);
    expect(memory.startsWith("# Memory index\n")).toBe(true);
  });

  test("never re-seeds over memory a human or a watcher has edited", async () => {
    const { env, repo } = await createScratchRepo();

    expect((await runInit(repo, env)).exitCode).toBe(0);
    const edited = "# USER.md\n\n- Johan prefers Bun over node.\n";
    await Bun.write(join(repo, ".argus/memory/USER.md"), edited);
    const memoryBefore = await Bun.file(
      join(repo, ".argus/memory/MEMORY.md"),
    ).text();

    expect((await runInit(repo, env)).exitCode).toBe(0);

    expect(await Bun.file(join(repo, ".argus/memory/USER.md")).text()).toBe(
      edited,
    );
    expect(await Bun.file(join(repo, ".argus/memory/MEMORY.md")).text()).toBe(
      memoryBefore,
    );
  });

  test("commits nothing by default and prints the exact command instead", async () => {
    const { env, repo } = await createScratchRepo();
    const head = (await run(["git", "rev-parse", "HEAD"], repo, env)).stdout;

    const result = await runInit(repo, env);

    expect((await run(["git", "rev-parse", "HEAD"], repo, env)).stdout).toBe(head);
    expect(result.stdout).toContain("Committed nothing");
    expect(result.stdout).toContain(
      "git add -- .gitignore AGENTS.md docs/agents",
    );
    expect(result.stdout).toContain("argus init --commit");
  });

  test("--commit commits every integration file in one commit, once", async () => {
    const { env, repo } = await createScratchRepo();

    const first = await runInit(repo, env, ["--commit"]);

    expect(first.exitCode).toBe(0);
    expect(first.stdout).toContain("Committed .gitignore, AGENTS.md, docs/agents");
    const tracked = (
      await run(["git", "ls-tree", "-r", "--name-only", "HEAD"], repo, env)
    ).stdout;
    for (const path of [
      ".gitignore",
      "AGENTS.md",
      "docs/agents/domain.md",
      "docs/agents/issue-tracker.md",
      "docs/agents/triage-labels.md",
    ]) {
      expect(tracked).toContain(path);
    }
    const headAfterFirst = (await run(["git", "rev-parse", "HEAD"], repo, env))
      .stdout;

    const second = await runInit(repo, env, ["--commit"]);

    expect(second.exitCode).toBe(0);
    expect((await run(["git", "rev-parse", "HEAD"], repo, env)).stdout).toBe(
      headAfterFirst,
    );
    expect(second.stdout).toContain("Integration files: already committed");
  });

  test("verifies the wiring it wrote instead of asserting it in prose", async () => {
    const { env, repo } = await createScratchRepo();
    await mkdir(join(repo, ".argus/skills/example"), { recursive: true });
    await Bun.write(join(repo, ".argus/skills/example/SKILL.md"), "# Example\n");

    const result = await runInit(repo, env);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain(
      "wiring: claude skills adapter OK (1 canonical skill readable through .claude/skills)",
    );
    expect(result.stdout).toContain("wiring: AGENTS.md pointers OK (6/6 resolve)");
  });

  test("refuses loudly when something else owns the Claude skills adapter", async () => {
    const { env, repo } = await createScratchRepo();
    await mkdir(join(repo, ".claude"), { recursive: true });
    await mkdir(join(repo, "docs"), { recursive: true });
    await symlink("../docs", join(repo, ".claude", "skills"));

    const result = await runInit(repo, env);

    // Convergence heals what Argus owns; what it does not own it refuses.
    // Silently redirecting a reader away from a store a human chose is the
    // one outcome that would be worse than failing.
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      ".claude/skills already points at ../docs; refusing to replace it",
    );
  });

  test("refuses a directory that is not inside a git repository", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-init-non-git-"));
    sandboxes.push(root);

    const result = await run([process.execPath, cli, "init"], root, {
      HOME: join(root, "home"),
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("not inside a git repository");
    expect(await Bun.file(join(root, ".argus/config.yaml")).exists()).toBe(false);
  });

  test("rejects unknown flags rather than ignoring them", async () => {
    const { env, repo } = await createScratchRepo();

    const result = await runInit(repo, env, ["--push"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("unknown argument '--push'");
  });
});
