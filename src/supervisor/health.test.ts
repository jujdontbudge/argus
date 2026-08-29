import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  EyeHealthReporter,
  eyeHealthPath,
  readEyeHealth,
} from "./health.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("EyeHealthReporter", () => {
  test("a transient write failure does not poison later health reports", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-health-"));
    roots.push(root);
    const reporter = new EyeHealthReporter(root, "reviewer");
    await reporter.start();

    const directory = dirname(eyeHealthPath(root, "reviewer"));
    const errors = spyOn(console, "error").mockImplementation(() => {});
    await chmod(directory, 0o500);
    try {
      await reporter.failure("transient write failure", 1);
    } finally {
      await chmod(directory, 0o700);
      errors.mockRestore();
    }

    await reporter.failure("reporting recovered", 2);
    expect(await readEyeHealth(root, "reviewer")).toMatchObject({
      backlog: 2,
      lastError: { message: "reporting recovered" },
    });
  });

  test("an idle heartbeat preserves the last archiver error", async () => {
    const root = await mkdtemp(join(tmpdir(), "argus-health-"));
    roots.push(root);
    const reporter = new EyeHealthReporter(root, "archiver");
    await reporter.start();
    await reporter.failure("database disk image is malformed", 0);

    await reporter.heartbeat(0);

    expect(await readEyeHealth(root, "archiver")).toMatchObject({
      backlog: 0,
      lastError: { message: "database disk image is malformed" },
      lastSuccess: null,
    });
  });

});
