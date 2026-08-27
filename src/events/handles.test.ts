import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import {
  CMUX_UUID_ONLY_VERBS,
  isCmuxUuid,
  refuseCmuxArgs,
} from "./handles.ts";
import { runCmux } from "./notify.ts";

/**
 * Ticket #98 — the handle form, made structural.
 *
 * #90 left one thing standing: `tab.ts`'s resolve-then-act guard is not
 * atomic, focus moves on its own, and the UUID is the only defence that still
 * holds after the guard has lost its race. That defence was CONVENTIONAL —
 * held by a docblock and by which string each call site happened to pass. A
 * future edit could reintroduce a ref without failing anything.
 *
 * These tests are what makes it structural instead: the policy is a pure
 * function, the choke point enforces it, and the choke point is proven to be
 * the only one.
 */
const UUID = "2D3B8B38-C9FC-46F4-A512-8F1157CE2E10";

describe("#98: a cmux handle that fails open cannot reach a state-changing verb", () => {
  test("only a raw UUID counts as the form that fails closed", () => {
    expect(isCmuxUuid(UUID)).toBe(true);
    expect(isCmuxUuid(UUID.toLowerCase())).toBe(true);
    // The three forms measured NOT to fail closed, in order of danger.
    expect(isCmuxUuid("surface:60")).toBe(false); // #98's handle: redirects.
    expect(isCmuxUuid("1")).toBe(false); // #90: a bare index is a third thing.
    expect(isCmuxUuid(`surface:${UUID}`)).toBe(false); // #99: invalid at parse.
  });

  test("close-surface with a short ref is refused, with the reason", () => {
    const refusal = refuseCmuxArgs([
      "close-surface",
      "--surface",
      "surface:60",
      "--workspace",
      UUID,
    ]);
    expect(refusal).toContain("close-surface");
    expect(refusal).toContain("surface:60");
    expect(refusal).toContain("UUID only");
  });

  test("close-surface with UUIDs on both flags is allowed through", () => {
    expect(refuseCmuxArgs(["close-surface", "--surface", UUID, "--workspace", UUID])).toBeNull();
  });

  test("the refusal covers the whole destructive family, not just close-surface", () => {
    for (const verb of ["close-surface", "close-workspace", "close-window"]) {
      expect(refuseCmuxArgs([verb, "--workspace", "workspace:1"])).not.toBeNull();
    }
    // …and the layout-changing verbs that would act on Johan's focused tab.
    expect(refuseCmuxArgs(["new-surface", "--workspace", "workspace:1"])).not.toBeNull();
    expect(refuseCmuxArgs(["rename-tab", "--surface", "surface:2", "hello"])).not.toBeNull();
  });

  test("read-only verbs are untouched — resolution itself needs refs", () => {
    // `tree --all` IS the resolution step; refusing refs here would make the
    // UUID unobtainable, and `identify`/`read-screen`/`list-*` redirect at
    // worst into a stray screen dump.
    expect(refuseCmuxArgs(["--id-format", "both", "tree", "--all", "--json"])).toBeNull();
    expect(refuseCmuxArgs(["list-pane-surfaces", "--workspace", "workspace:1"])).toBeNull();
    expect(refuseCmuxArgs(["read-screen", "--surface", "surface:60"])).toBeNull();
    expect(refuseCmuxArgs(["identify", "--workspace", "workspace:1"])).toBeNull();
  });

  test("send and send-key are deliberately out of scope, and stay working", () => {
    // Their redirect is bounded (#7: text into the wrong session) and already
    // guarded by `createCmuxResolve`; Hermes rows in sends.jsonl legitimately
    // carry ref handles today (#99). Refusing them would take mission
    // delivery down to close a hole that destroys nothing.
    expect(refuseCmuxArgs(["send", "--workspace", "workspace:1", "--", "hi"])).toBeNull();
    expect(refuseCmuxArgs(["send-key", "--surface", "surface:2", "--", "enter"])).toBeNull();
  });

  test("a tab title that looks like a verb is not mistaken for one", () => {
    // `verbOf` finds the command properly rather than scanning for a name.
    expect(refuseCmuxArgs(["rename-tab", "--surface", UUID, "close-surface"])).toBeNull();
    // And text after `--` is literal, so it cannot smuggle a handle flag in.
    expect(refuseCmuxArgs(["send", "--surface", UUID, "--", "--workspace surface:1"])).toBeNull();
  });

  test("global options before the verb do not hide it", () => {
    expect(
      refuseCmuxArgs(["--id-format", "both", "close-surface", "--surface", "surface:60"]),
    ).not.toBeNull();
  });

  test("runCmux refuses without spawning, shaped like cmux's own fail-closed", async () => {
    // The refusal has to be exit 1 with a reason on stderr, because that is
    // the answer a dead UUID gets from the real binary and every caller in
    // the tree already degrades on it. A throw would need new handling at
    // each call site, and a call site that forgot would be silent.
    const result = await runCmux(["close-surface", "--surface", "surface:99999"]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("argus refuses");
  });
});

describe("#98: the choke point is the only one", () => {
  /**
   * THE REGRESSION THIS FILE EXISTS FOR. `runCmux` can only enforce the rule
   * for calls that go through it. A future edit that reaches for
   * `Bun.spawn(["cmux", …])` somewhere else would silently reopen the whole
   * hazard — a comment cannot notice that, and this can.
   */
  test("nothing outside notify.ts spawns the cmux binary", () => {
    const offenders: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory)) {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) {
          walk(path);
          continue;
        }
        if (!path.endsWith(".ts")) continue;
        if (path.endsWith(join("events", "notify.ts"))) continue;
        // This file quotes the patterns it looks for, so it matches itself.
        if (path.endsWith(join("events", "handles.test.ts"))) continue;
        const source = readFileSync(path, "utf8");
        // `Bun.spawn(["cmux"…])` / `spawnSync("cmux"…)` / `exec("cmux …")`.
        if (/spawn\w*\(\s*\[?\s*"cmux"/.test(source) || /exec\w*\(\s*"cmux[\s"]/.test(source)) {
          offenders.push(path);
        }
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
  });

  test("every state-changing verb Argus actually runs is in the UUID-only set", () => {
    // Argus drives exactly three of them today. If a fourth appears in the
    // tree without being listed, this is the test that says so.
    for (const verb of ["new-surface", "close-surface", "rename-tab"]) {
      expect(CMUX_UUID_ONLY_VERBS.has(verb)).toBe(true);
    }
  });
});
