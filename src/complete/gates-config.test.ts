import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveRepositoryGates, runGates } from "./gates.ts";

test("an Argus-shaped root manifest selects its TypeScript gates", async () => {
  const root = await mkdtemp(join(tmpdir(), "argus-gate-config-ts-"));
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  try {
    await mkdir(join(repo, ".argus"), { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(join(repo, ".argus", "config.yaml"), "# no gate override\n");
    await writeFile(
      join(worktree, "package.json"),
      `${JSON.stringify({
        scripts: { test: "bun test", typecheck: "tsc --noEmit" },
      })}\n`,
    );
    await writeFile(join(worktree, "tsconfig.json"), "{}\n");
    await writeFile(join(worktree, "bun.lock"), "");

    expect(await resolveRepositoryGates(repo, worktree)).toEqual({
      gates: [
        { command: ["bun", "run", "typecheck"], name: "typecheck" },
        { command: ["bun", "run", "test"], name: "tests" },
      ],
      source: "root Bun package scripts with tsconfig.json and lockfile",
      status: "resolved",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a Python/docs repository runs only its explicitly configured gates", async () => {
  const root = await mkdtemp(join(tmpdir(), "argus-gate-config-python-"));
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  try {
    await mkdir(join(repo, ".argus"), { recursive: true });
    await mkdir(join(worktree, "docs"), { recursive: true });
    await writeFile(
      join(repo, ".argus", "config.yaml"),
      [
        "completion:",
        "  gates:",
        "    - name: tests",
        "      command: [python3, tests/test_authority_matrix.py, -v]",
        "    - name: validator",
        "      command: [python3, scripts/validate_authority_matrix.py]",
        "    - name: json",
        "      command: [python3, -m, json.tool, governance/authority-matrix.json]",
        "",
      ].join("\n"),
    );

    expect(await resolveRepositoryGates(repo, worktree)).toEqual({
      gates: [
        {
          command: ["python3", "tests/test_authority_matrix.py", "-v"],
          name: "tests",
        },
        {
          command: ["python3", "scripts/validate_authority_matrix.py"],
          name: "validator",
        },
        {
          command: ["python3", "-m", "json.tool", "governance/authority-matrix.json"],
          name: "json",
        },
      ],
      source: ".argus/config.yaml completion.gates",
      status: "resolved",
    });
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("malformed completion configuration fails closed with the config path", async () => {
  const root = await mkdtemp(join(tmpdir(), "argus-gate-config-malformed-"));
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  try {
    await mkdir(join(repo, ".argus"), { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(
      join(repo, ".argus", "config.yaml"),
      "completion:\n  gates: [\n",
    );

    const resolution = await resolveRepositoryGates(repo, worktree);
    expect(resolution.status).toBe("error");
    if (resolution.status === "error") {
      expect(resolution.reason).toContain(".argus/config.yaml");
      expect(resolution.reason).toContain("valid YAML");
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a YAML config with the wrong root shape is malformed even in a TypeScript repo", async () => {
  const root = await mkdtemp(join(tmpdir(), "argus-gate-config-root-"));
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  try {
    await mkdir(join(repo, ".argus"), { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(join(repo, ".argus", "config.yaml"), "- not-a-config-map\n");
    await writeFile(
      join(worktree, "package.json"),
      '{"scripts":{"typecheck":"tsc --noEmit","test":"bun test"}}\n',
    );
    await writeFile(join(worktree, "tsconfig.json"), "{}\n");
    await writeFile(join(worktree, "bun.lock"), "");

    const resolution = await resolveRepositoryGates(repo, worktree);
    expect(resolution.status).toBe("error");
    if (resolution.status === "error") {
      expect(resolution.reason).toContain(".argus/config.yaml root must be a map");
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a malformed gate entry explains the invalid field", async () => {
  const root = await mkdtemp(join(tmpdir(), "argus-gate-entry-malformed-"));
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  try {
    await mkdir(join(repo, ".argus"), { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(
      join(repo, ".argus", "config.yaml"),
      [
        "completion:",
        "  gates:",
        "    - name: tests",
        "      command: python3 tests/test_docs.py",
        "",
      ].join("\n"),
    );

    const resolution = await resolveRepositoryGates(repo, worktree);
    expect(resolution.status).toBe("error");
    if (resolution.status === "error") {
      expect(resolution.reason).toContain("completion.gates[0].command");
      expect(resolution.reason).toContain("non-empty argv list");
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("an explicitly empty gate set is rejected instead of passing silently", async () => {
  const root = await mkdtemp(join(tmpdir(), "argus-gate-config-empty-"));
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  try {
    await mkdir(join(repo, ".argus"), { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(
      join(repo, ".argus", "config.yaml"),
      "completion:\n  gates: []\n",
    );

    const resolution = await resolveRepositoryGates(repo, worktree);
    expect(resolution.status).toBe("error");
    if (resolution.status === "error") {
      expect(resolution.reason).toContain("completion.gates cannot be empty");
      expect(resolution.reason).toContain("name");
      expect(resolution.reason).toContain("command");
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a repository without a root TypeScript project never receives a tsc gate", async () => {
  const root = await mkdtemp(join(tmpdir(), "argus-gate-config-none-"));
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  try {
    await mkdir(join(repo, ".argus"), { recursive: true });
    await mkdir(join(worktree, "docs"), { recursive: true });
    await writeFile(join(repo, ".argus", "config.yaml"), "# no gate override\n");
    await writeFile(join(worktree, "docs", "guide.md"), "# Guide\n");

    const resolution = await resolveRepositoryGates(repo, worktree);
    expect(resolution.status).toBe("error");
    if (resolution.status === "error") {
      expect(resolution.reason).toContain("no completion gates are configured");
      expect(resolution.reason).toContain("completion.gates");
      expect(resolution.reason).not.toContain("tsc");
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("a malformed root package manifest fails detection closed", async () => {
  const root = await mkdtemp(join(tmpdir(), "argus-gate-package-malformed-"));
  const repo = join(root, "repo");
  const worktree = join(root, "worktree");
  try {
    await mkdir(join(repo, ".argus"), { recursive: true });
    await mkdir(worktree, { recursive: true });
    await writeFile(join(repo, ".argus", "config.yaml"), "# detection\n");
    await writeFile(join(worktree, "package.json"), "{ not-json\n");
    await writeFile(join(worktree, "tsconfig.json"), "{}\n");
    await writeFile(join(worktree, "bun.lock"), "");

    const resolution = await resolveRepositoryGates(repo, worktree);
    expect(resolution.status).toBe("error");
    if (resolution.status === "error") {
      expect(resolution.reason).toContain("root package.json");
      expect(resolution.reason).toContain("valid JSON");
    }
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});

test("the gate runner itself refuses an empty gate set", async () => {
  expect(
    runGates("/unused", [], async () => ({ exitCode: 0, stderr: "", stdout: "" })),
  ).rejects.toThrow("at least one completion gate");
});
