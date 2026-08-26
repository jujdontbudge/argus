import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorktree } from "../deploy/worktree.ts";
import { DEFAULT_GATES, runGates } from "./gates.ts";

const BUDGET_MS = 60_000;
const GIT_IDENTITY = {
  GIT_AUTHOR_EMAIL: "gates@invalid.example",
  GIT_AUTHOR_NAME: "Argus Gates Test",
  GIT_COMMITTER_EMAIL: "gates@invalid.example",
  GIT_COMMITTER_NAME: "Argus Gates Test",
};

async function run(
  command: readonly string[],
  cwd: string,
): Promise<{ exitCode: number; stderr: string; stdout: string }> {
  const child = Bun.spawn([...command], {
    cwd,
    env: { ...process.env, ...GIT_IDENTITY },
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

test(
  "a production-created ticket worktree runs every default gate and typecheck can refuse",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-gates-worktree-"));
    const repo = join(root, "repo");
    const worktree = join(root, "worktrees", "ticket-87");

    try {
      await mkdir(join(repo, "src"), { recursive: true });
      await mkdir(join(repo, "vendor", "types-fixture"), { recursive: true });
      await writeFile(
        join(repo, "package.json"),
        `${JSON.stringify(
          {
            devDependencies: {
              "@types/fixture": "file:vendor/types-fixture",
              typescript: "5.9.3",
            },
            private: true,
            scripts: { test: "bun test --pass-with-no-tests" },
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(
        join(repo, "tsconfig.json"),
        `${JSON.stringify(
          {
            compilerOptions: {
              module: "Preserve",
              moduleResolution: "Bundler",
              noEmit: true,
              strict: true,
              target: "ESNext",
              types: ["fixture"],
            },
            include: ["src/**/*.ts"],
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(join(repo, "src", "answer.ts"), "export const answer: number = 42;\n");
      await writeFile(
        join(repo, "src", "answer.test.js"),
        [
          'import { expect, test } from "bun:test";',
          'import { answer } from "./answer.ts";',
          'test("the fixture is runnable", () => expect(answer).toBe(42));',
          "",
        ].join("\n"),
      );
      await writeFile(
        join(repo, "vendor", "types-fixture", "package.json"),
        '{"name":"@types/fixture","version":"1.0.0","types":"index.d.ts"}\n',
      );
      await writeFile(
        join(repo, "vendor", "types-fixture", "index.d.ts"),
        "declare const fixtureReady: true;\n",
      );
      await writeFile(join(repo, ".gitignore"), "node_modules/\n");

      const seeded = await run(
        ["bun", "install", "--ignore-scripts", "--offline"],
        repo,
      );
      if (seeded.exitCode !== 0) {
        throw new Error(`fixture bun install failed: ${seeded.stderr || seeded.stdout}`);
      }
      expect((await run(["git", "init", "--quiet"], repo)).exitCode).toBe(0);
      expect((await run(["git", "add", "."], repo)).exitCode).toBe(0);
      expect((await run(["git", "commit", "--quiet", "-m", "fixture"], repo)).exitCode).toBe(
        0,
      );

      const created = await createWorktree({
        branch: "argus/ticket-87",
        path: worktree,
        repo,
      });
      expect(created).toEqual({
        branch: "argus/ticket-87",
        path: worktree,
        status: "created",
      });

      const green = await runGates(worktree, DEFAULT_GATES);
      expect(green.results.map(({ name, passed }) => ({ name, passed }))).toEqual([
        { name: "typecheck", passed: true },
        { name: "tests", passed: true },
      ]);
      expect(green.passed).toBe(true);

      await writeFile(
        join(worktree, "src", "answer.ts"),
        'export const answer: number = "not a number";\n',
      );
      const deliberateFailure = await runGates(worktree, DEFAULT_GATES);
      expect(deliberateFailure.results[0]?.name).toBe("typecheck");
      expect(deliberateFailure.results[0]?.passed).toBe(false);
      expect(deliberateFailure.results[0]?.exitCode).not.toBe(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
  BUDGET_MS,
);
