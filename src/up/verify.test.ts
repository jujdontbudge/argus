import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { VERIFIED_HERMES_CLI_VERSION } from "../tailing/hermes-compat.ts";
import { agentsPointers, verifyWiring } from "./verify.ts";

/**
 * The degraded half of #67's wiring verification.
 *
 * `argus init`/`argus up` heal everything they own, so the failing branches
 * are not reachable by running the CLI twice — that is the point of a
 * converger. They ARE reachable if a future change stops writing something
 * the pointer blocks promise, which is exactly the regression these checks
 * exist to catch, so they are pinned here at the module the CLI calls.
 */

const sandboxes: string[] = [];

async function scratchRepo(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), "argus-verify-")));
  sandboxes.push(root);
  await mkdir(join(root, ".argus", "skills"), { recursive: true });
  await mkdir(join(root, ".argus", "memory"), { recursive: true });
  await mkdir(join(root, ".claude"), { recursive: true });
  await symlink("../.argus/skills", join(root, ".claude", "skills"));
  return root;
}

const BLOCKS = `<!-- argus:begin -->
- Read \`.argus/memory/USER.md\`.
- Search with \`argus search "<query>"\`.
<!-- argus:end -->

<!-- matt-pocock:begin -->
See \`docs/agents/domain.md\`.
<!-- matt-pocock:end -->
`;

afterEach(async () => {
  await Promise.all(
    sandboxes.splice(0).map((path) => rm(path, { force: true, recursive: true })),
  );
});

describe("wiring verification", () => {
  test("warns when the installed Hermes differs from the verified pin", async () => {
    const repo = await scratchRepo();
    const cli = join(repo, "hermes");
    await Bun.write(cli, '#!/bin/sh\nprintf "Hermes Agent v2026.8.27\\n"\n');
    await chmod(cli, 0o755);
    const checks = await verifyWiring(repo, { hermes: { profile: "unused", root: repo, cli } });
    expect(checks.at(-1)).toMatchObject({ name: "Hermes compatibility", ok: true, warning: true });
    expect(checks.at(-1)!.detail).toContain("verified against");
  });

  test("is silent for a matching Hermes and reports an absent pin/install as never verified", async () => {
    const repo = await scratchRepo();
    const cli = join(repo, "hermes");
    await Bun.write(cli, `#!/bin/sh\nprintf "${VERIFIED_HERMES_CLI_VERSION} · upstream deadbeef\\n"\n`);
    await chmod(cli, 0o755);
    const matching = await verifyWiring(repo, { hermes: { profile: "unused", root: repo, cli } });
    expect(matching.at(-1)).toMatchObject({ name: "Hermes compatibility", ok: true });
    expect(matching.at(-1)).not.toHaveProperty("warning");
    const missing = await verifyWiring(repo, { hermes: { profile: "unused", root: repo, cli: join(repo, "missing") } });
    expect(missing.at(-1)!.detail).toContain("never verified");
  });
  test("reads pointers out of the managed blocks and ignores prose commands", () => {
    expect(agentsPointers(BLOCKS).sort()).toEqual([
      ".argus/memory/USER.md",
      "docs/agents/domain.md",
    ]);
    expect(agentsPointers("Read `.argus/memory/USER.md` outside any block")).toEqual(
      [],
    );
  });

  test("fails on a pointer AGENTS.md promises but nothing wrote", async () => {
    const repo = await scratchRepo();
    await Bun.write(join(repo, "AGENTS.md"), BLOCKS);
    await Bun.write(join(repo, ".argus/memory/USER.md"), "# USER.md\n");

    const [, pointers] = await verifyWiring(repo);

    expect(pointers!.ok).toBe(false);
    expect(pointers!.detail).toContain("1/2 dangling: docs/agents/domain.md");
  });

  test("passes once every promised pointer exists", async () => {
    const repo = await scratchRepo();
    await Bun.write(join(repo, "AGENTS.md"), BLOCKS);
    await Bun.write(join(repo, ".argus/memory/USER.md"), "# USER.md\n");
    await Bun.write(join(repo, "docs/agents/domain.md"), "# Domain\n");

    const [, pointers] = await verifyWiring(repo);

    expect(pointers).toEqual({
      detail: "2/2 resolve",
      name: "AGENTS.md pointers",
      ok: true,
    });
  });

  test("reads a canonical skill back through the Claude adapter", async () => {
    const repo = await scratchRepo();
    await Bun.write(join(repo, "AGENTS.md"), BLOCKS);
    await mkdir(join(repo, ".argus/skills/example"), { recursive: true });
    await Bun.write(join(repo, ".argus/skills/example/SKILL.md"), "# Example\n");

    const [adapter] = await verifyWiring(repo);

    expect(adapter).toEqual({
      detail: "1 canonical skill readable through .claude/skills",
      name: "claude skills adapter",
      ok: true,
    });
  });

  test("preserves and verifies a physical Claude skills directory", async () => {
    const repo = await scratchRepo();
    await rm(join(repo, ".claude", "skills"));
    await mkdir(join(repo, ".claude", "skills", "local"), { recursive: true });
    await Bun.write(join(repo, ".claude", "skills", "local", "SKILL.md"), "# Local\n");
    await mkdir(join(repo, ".argus", "skills", "argus-orchestrator"), { recursive: true });
    await Bun.write(
      join(repo, ".argus", "skills", "argus-orchestrator", "SKILL.md"),
      "# Argus\n",
    );

    const [adapter] = await verifyWiring(repo);

    expect(adapter).toEqual({
      detail: "1 existing Claude skill preserved; Argus orchestrator readable",
      name: "claude skills adapter",
      ok: true,
    });
  });

  test("fails when the adapter resolves somewhere other than the canonical store", async () => {
    const repo = await scratchRepo();
    await rm(join(repo, ".claude", "skills"));
    await mkdir(join(repo, "elsewhere"), { recursive: true });
    await symlink("../elsewhere", join(repo, ".claude", "skills"));

    const [adapter] = await verifyWiring(repo);

    expect(adapter!.ok).toBe(false);
    expect(adapter!.detail).toContain(".claude/skills points at");
  });

  test("fails when Hermes memory is bound anywhere but this repo's pair", async () => {
    const repo = await scratchRepo();
    const hermes = join(repo, "hermes");
    await mkdir(join(hermes, "profiles", "argus-repo"), { recursive: true });
    await mkdir(join(repo, "global-memories"), { recursive: true });
    await symlink(
      join(repo, "global-memories"),
      join(hermes, "profiles", "argus-repo", "memories"),
    );

    const checks = await verifyWiring(repo, {
      hermes: { profile: "argus-repo", root: hermes },
    });

    // SPEC §8.1: the global store is the parallel-store disease returning
    // through the orchestrator. It must be a visible failure, not a shrug.
    expect(checks[2]!.ok).toBe(false);
    expect(checks[2]!.detail).toContain("global-memories");
  });

  test("fails when the Hermes profile omits the canonical skills store", async () => {
    const repo = await scratchRepo();
    const hermes = join(repo, "hermes");
    const profile = join(hermes, "profiles", "argus-repo");
    await mkdir(profile, { recursive: true });
    await symlink(join(repo, ".argus", "memory"), join(profile, "memories"));
    await Bun.write(join(profile, "config.yaml"), "skills:\n  external_dirs: []\n");

    const checks = await verifyWiring(repo, {
      hermes: { profile: "argus-repo", root: hermes },
    });

    expect(checks[3]).toEqual({
      detail: `profile skills.external_dirs omits ${join(repo, ".argus", "skills")}`,
      name: "Hermes skills binding",
      ok: false,
    });
  });
});
