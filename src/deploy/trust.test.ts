import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { claudeConfigFile, trustDirectory } from "./trust.ts";

/**
 * Ticket #96, half 1 — the first-run trust dialog, decided BEFORE the process
 * starts instead of answered after it blocks.
 *
 * Measured against the real binary (2.1.246), which documents the contract in
 * its own error string: "set projects[<dir>].hasTrustDialogAccepted: true in
 * <config file>". The config file is `$CLAUDE_CONFIG_DIR/.claude.json` when
 * that variable is set and `$HOME/.claude.json` otherwise — probed live, with
 * a scratch HOME, by creating the file and looking at where it landed.
 *
 * Every test here writes into a scratch directory. Nothing in this file may
 * ever read or write the real `~/.claude.json`.
 */
const roots: string[] = [];

async function scratch(): Promise<{ configDir: string; project: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "argus-trust-"));
  roots.push(root);
  return { configDir: join(root, "cfg"), project: join(root, "worktree"), root };
}

async function readConfig(configDir: string): Promise<Record<string, any>> {
  return (await Bun.file(join(configDir, ".claude.json")).json()) as Record<string, any>;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("the Claude Code config file Argus pre-trusts into", () => {
  test("CLAUDE_CONFIG_DIR wins; HOME is the fallback", () => {
    expect(claudeConfigFile({ CLAUDE_CONFIG_DIR: "/cfg", HOME: "/home/j" })).toBe(
      "/cfg/.claude.json",
    );
    expect(claudeConfigFile({ HOME: "/home/j" })).toBe("/home/j/.claude.json");
  });

  test("no HOME and no CLAUDE_CONFIG_DIR is a failure, never a guess", () => {
    expect(() => claudeConfigFile({})).toThrow(/HOME/);
  });
});

describe("pre-trusting a directory", () => {
  test("writes hasTrustDialogAccepted for the resolved path, creating the config", async () => {
    const { configDir, project } = await scratch();
    const result = await trustDirectory(project, {
      env: { CLAUDE_CONFIG_DIR: configDir },
    });
    expect(result.status).toBe("trusted");
    const config = await readConfig(configDir);
    expect(config.projects[project].hasTrustDialogAccepted).toBe(true);
  });

  test("keeps every other project and every unrelated key intact", async () => {
    const { configDir, project } = await scratch();
    await Bun.write(
      join(configDir, ".claude.json"),
      JSON.stringify({
        oauthAccount: { emailAddress: "keep@me" },
        projects: {
          "/somewhere/else": { hasTrustDialogAccepted: true, allowedTools: ["Bash"] },
          [project]: { allowedTools: ["Read"], hasTrustDialogAccepted: false },
        },
      }),
    );
    const result = await trustDirectory(project, {
      env: { CLAUDE_CONFIG_DIR: configDir },
    });
    expect(result.status).toBe("trusted");
    const config = await readConfig(configDir);
    expect(config.oauthAccount).toEqual({ emailAddress: "keep@me" });
    expect(config.projects["/somewhere/else"]).toEqual({
      hasTrustDialogAccepted: true,
      allowedTools: ["Bash"],
    });
    expect(config.projects[project]).toEqual({
      allowedTools: ["Read"],
      hasTrustDialogAccepted: true,
    });
  });

  test("keeps a project written concurrently after its snapshot was read", async () => {
    const { configDir, project } = await scratch();
    const path = join(configDir, ".claude.json");
    const concurrentProject = "/written/by/claude";
    const initial = {
      projects: {
        "/already/present": { hasTrustDialogAccepted: true },
      },
    };
    await Bun.write(path, JSON.stringify(initial));

    const write = Bun.write;
    let injected = false;
    Object.assign(Bun, {
      write: async (...args: Parameters<typeof Bun.write>) => {
        const written = await write(...args);
        if (!injected && String(args[0]).startsWith(`${path}.argus.`)) {
          injected = true;
          await write(
            path,
            JSON.stringify({
              ...initial,
              projects: {
                ...initial.projects,
                [concurrentProject]: { allowedTools: ["Read"] },
              },
            }),
          );
        }
        return written;
      },
    });

    try {
      const result = await trustDirectory(project, {
        env: { CLAUDE_CONFIG_DIR: configDir },
      });
      expect(result.status).toBe("trusted");
    } finally {
      Object.assign(Bun, { write });
    }

    const config = await readConfig(configDir);
    expect(config.projects[concurrentProject]).toEqual({ allowedTools: ["Read"] });
    expect(config.projects[project].hasTrustDialogAccepted).toBe(true);
  });

  test("serializes concurrent Argus writers so every project survives", async () => {
    const { configDir, project } = await scratch();
    const projects = Array.from({ length: 8 }, (_, index) => `${project}-${index}`);

    const results = await Promise.all(
      projects.map((candidate) =>
        trustDirectory(candidate, { env: { CLAUDE_CONFIG_DIR: configDir } }),
      ),
    );

    expect(results.map(({ status }) => status)).toEqual(projects.map(() => "trusted"));
    const config = await readConfig(configDir);
    for (const candidate of projects) {
      expect(config.projects[candidate].hasTrustDialogAccepted).toBe(true);
    }
  });

  test("an already-trusted directory is reported, and the file is not rewritten", async () => {
    const { configDir, project } = await scratch();
    const path = join(configDir, ".claude.json");
    await Bun.write(
      path,
      JSON.stringify({ projects: { [project]: { hasTrustDialogAccepted: true } } }),
    );
    const before = await stat(path);
    await Bun.sleep(10);
    const result = await trustDirectory(project, {
      env: { CLAUDE_CONFIG_DIR: configDir },
    });
    expect(result.status).toBe("already-trusted");
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs);
  });

  test("a malformed config is left alone and reported, never clobbered", async () => {
    const { configDir, project } = await scratch();
    const path = join(configDir, ".claude.json");
    await Bun.write(path, "{not json");
    const result = await trustDirectory(project, {
      env: { CLAUDE_CONFIG_DIR: configDir },
    });
    expect(result.status).toBe("failed");
    expect(result.status === "failed" && result.reason).toMatch(/JSON/i);
    expect(await Bun.file(path).text()).toBe("{not json");
  });

  test("the config keeps its 0600 mode", async () => {
    const { configDir, project } = await scratch();
    const path = join(configDir, ".claude.json");
    await Bun.write(path, JSON.stringify({ projects: {} }));
    await chmod(path, 0o600);
    await trustDirectory(project, { env: { CLAUDE_CONFIG_DIR: configDir } });
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  test("a config directory that cannot be written fails without throwing", async () => {
    const { configDir, project, root } = await scratch();
    await writeFile(join(root, "not-a-dir"), "");
    const result = await trustDirectory(project, {
      env: { CLAUDE_CONFIG_DIR: join(root, "not-a-dir", "cfg") },
    });
    expect(result.status).toBe("failed");
    expect(configDir).toBeTruthy();
  });
});
