import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

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

  // #117 item 6: two `argus up` runs racing on the SAME registry file. This is
  // not a hypothetical — `argus up` calls `enableRepo` (src/up.ts
  // `ensureSupervisorEnrollment`), and two shells converging two different
  // repos at once is the ordinary way a person adopts a second repo.
  //
  // Cross-PROCESS, not two awaits in one process, because that is the case
  // that has no shared memory to serialize it: read-modify-write plus a
  // `${path}.${pid}.tmp` scratch name means each writer has its OWN temp path
  // and both renames succeed, so the last rename wins outright.
  test("concurrent cross-process enableRepo keeps every enrolled repo", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-registry-race-"));
    roots.push(root);
    const path = join(root, "state", "repos");
    const module = fileURLToPath(new URL("./registry.ts", import.meta.url));
    const WRITERS = 8;

    // A shared start barrier: every child spins until the file appears, so the
    // reads genuinely interleave instead of being serialized by spawn latency.
    const gate = join(root, "GO");
    const children = Array.from({ length: WRITERS }, (_, index) =>
      Bun.spawn(
        [
          process.execPath,
          "-e",
          `
            const { enableRepo } = await import(${JSON.stringify(module)});
            while (!(await Bun.file(${JSON.stringify(gate)}).exists())) {
              await Bun.sleep(1);
            }
            await enableRepo(${JSON.stringify(path)}, ${JSON.stringify(join(root, "repo-"))} + ${index});
          `,
        ],
        { stderr: "pipe", stdout: "ignore" },
      ),
    );
    await Bun.write(gate, "go\n");
    const codes = await Promise.all(children.map((child) => child.exited));

    expect(codes).toEqual(Array.from({ length: WRITERS }, () => 0));
    expect((await readEnabledRepos(path)).sort()).toEqual(
      Array.from({ length: WRITERS }, (_, index) => join(root, `repo-${index}`)).sort(),
    );
  }, 20_000);

  // #117 is a chaos ticket, so the lock it adds has to survive the thing chaos
  // does: a holder that is SIGKILLed and never releases. Without takeover, one
  // killed `argus up` would wedge every future enrollment on this machine.
  test("a lock left by a dead holder is taken over, not waited out", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-registry-stale-"));
    roots.push(root);
    const path = join(root, "state", "repos");
    const repo = join(root, "repo");
    await mkdir(dirname(path), { recursive: true });

    // A pid that is provably dead: spawn something trivial and wait for it.
    const corpse = Bun.spawn([process.execPath, "-e", ""], { stdout: "ignore" });
    await corpse.exited;
    await Bun.write(`${path}.lock`, `${JSON.stringify({ pid: corpse.pid, token: "stale" })}\n`);

    const started = Bun.nanoseconds();
    expect(await enableRepo(path, repo)).toEqual([repo]);
    const elapsedMs = (Bun.nanoseconds() - started) / 1e6;

    // Waiting the full budget out would be 2000ms. Takeover is immediate.
    expect(elapsedMs).toBeLessThan(500);
    expect(await Bun.file(`${path}.lock`).exists()).toBe(false);
  });
});
