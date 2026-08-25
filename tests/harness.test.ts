import { describe, expect, test } from "bun:test";
import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createSandbox } from "../src/harness/index.ts";

const checkout = fileURLToPath(new URL("..", import.meta.url));

describe("fake-Johan harness", () => {
  test("creates an isolated throwaway git repo and records the argus up stub", async () => {
    const sandbox = await createSandbox({ checkout });

    try {
      expect((await lstat(join(sandbox.repo, ".git"))).isDirectory()).toBe(true);
      expect(sandbox.home).toBe(join(sandbox.root, "home"));
      expect(sandbox.env.HOME).toBe(sandbox.home);
      expect(sandbox.env.XDG_CONFIG_HOME).toBe(join(sandbox.root, "state/config"));
      expect(sandbox.env.XDG_DATA_HOME).toBe(join(sandbox.root, "state/data"));
      expect(sandbox.env.XDG_STATE_HOME).toBe(join(sandbox.root, "state/state"));
      expect(sandbox.env.ARGUS_REPOS_DIR).toBe(join(sandbox.root, "state/argus-repos"));
      expect(sandbox.env.CLAUDE_CONFIG_DIR).toBe(join(sandbox.root, "state/claude"));
      expect(sandbox.env.HERMES_HOME).toBe(join(sandbox.root, "state/hermes"));
      expect(sandbox.env.CMUX_SOCKET_DIR).toBe(join(sandbox.root, "state/cmux"));
      expect(dirname(sandbox.repo)).toBe(sandbox.root);
      expect(sandbox.up).toEqual({
        exitCode: 1,
        stderr: "argus up: not implemented yet\n",
        stdout: "",
      });
    } finally {
      await sandbox.teardown();
    }

    expect(lstat(sandbox.root)).rejects.toThrow();
  });
});
