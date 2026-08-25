import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { disableRepo, enableRepo, readEnabledRepos } from "./registry.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true })));
});

describe("supervisor repo registry", () => {
  test("enables idempotently and disables only the selected repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-registry-"));
    roots.push(root);
    const path = join(root, "state", "repos");
    const repoA = join(root, "repo-a");
    const repoB = join(root, "repo-b");

    expect(await enableRepo(path, repoA)).toEqual([repoA]);
    expect(await enableRepo(path, repoB)).toEqual([repoA, repoB]);
    expect(await enableRepo(path, repoA)).toEqual([repoA, repoB]);
    expect(await Bun.file(path).text()).toBe(`${repoA}\n${repoB}\n`);

    expect(await disableRepo(path, repoA)).toEqual([repoB]);
    expect(await readEnabledRepos(path)).toEqual([repoB]);
    expect(await disableRepo(path, repoA)).toEqual([repoB]);
  });
});
