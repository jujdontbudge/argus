import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createWorktree } from "../deploy/worktree.ts";
import { resolveRepositoryGates, runGates } from "./gates.ts";

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
  "a production-created Argus worktree detects native gates and typecheck can refuse",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-gates-worktree-"));
    const repo = join(root, "repo");
    const worktree = join(root, "worktrees", "ticket-87");

    try {
      await mkdir(join(repo, "src"), { recursive: true });
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
      await writeFile(join(repo, ".gitignore"), "node_modules/\n");
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

      await writeFile(
        join(worktree, "package.json"),
        `${JSON.stringify(
          {
            name: "argus-shaped-fixture",
            private: true,
            scripts: {
              test: "bun test --pass-with-no-tests",
              typecheck: `bun ${JSON.stringify(
                join(process.cwd(), "node_modules", "typescript", "bin", "tsc"),
              )} --noEmit`,
            },
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(
        join(worktree, "tsconfig.json"),
        `${JSON.stringify(
          {
            compilerOptions: {
              module: "Preserve",
              moduleResolution: "Bundler",
              noEmit: true,
              strict: true,
              target: "ESNext",
            },
            include: ["src/**/*.ts"],
          },
          null,
          2,
        )}\n`,
      );
      await writeFile(
        join(worktree, "bun.lock"),
        `${JSON.stringify(
          {
            lockfileVersion: 1,
            configVersion: 1,
            workspaces: { "": { name: "argus-shaped-fixture" } },
            packages: {},
          },
          null,
          2,
        )}\n`,
      );

      const resolution = await resolveRepositoryGates(repo, worktree);
      expect(resolution.status).toBe("resolved");
      if (resolution.status === "error") throw new Error(resolution.reason);

      const green = await runGates(worktree, resolution.gates);
      expect(green.results.map(({ name, passed }) => ({ name, passed }))).toEqual([
        { name: "typecheck", passed: true },
        { name: "tests", passed: true },
      ]);
      expect(green.passed).toBe(true);

      await writeFile(
        join(worktree, "src", "answer.ts"),
        'export const answer: number = "not a number";\n',
      );
      const deliberateFailure = await runGates(worktree, resolution.gates);
      expect(deliberateFailure.results[0]?.name).toBe("typecheck");
      expect(deliberateFailure.results[0]?.passed).toBe(false);
      expect(deliberateFailure.results[0]?.exitCode).not.toBe(0);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  },
  BUDGET_MS,
);
