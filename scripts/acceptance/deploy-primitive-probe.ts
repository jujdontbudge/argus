/**
 * Ticket #107 — the pre-trust step (#96) inside `deployWorker`, driven.
 *
 * WHY THIS EXISTS AS A SEPARATE RUNNER. `src/deploy/live.test.ts`'s Claude
 * half is the subscription drive: real `HOME`, no token, sandbox `cwd`. Since
 * #96 that half also reaches `trustDirectory`, and `trustDirectory` writes
 * `$CLAUDE_CONFIG_DIR ?? $HOME` + `/.claude.json`. With the real `HOME` that
 * is Johan's live 340 KB config, read-modify-renamed while his own sessions
 * are writing it — which #96's own evidence rules out in as many words:
 * "writing Johan's real ~/.claude.json is forbidden by the house rules".
 *
 * So the Claude half of that gate cannot be driven under the house rules any
 * more, and #107 records it `not-run` for that reason. This runner covers what
 * that half would have covered about the PRE-TRUST STEP, at zero subscription
 * cost and touching nothing real: scratch `HOME`, scratch `CLAUDE_CONFIG_DIR`,
 * scratch repo, production `deployWorker`.
 *
 * WHAT IT IS AN ORACLE FOR, and what it is not. Under a scratch config dir the
 * `claude` binary is "Not logged in" — measured, #107 — so the session exits
 * without a transcript. Everything under test here happens strictly BEFORE
 * that point: the checkout, the pre-trust write, the registry row and the
 * spawn. This is the same bargain #55's codex half already makes with its 401,
 * and it is stated rather than assumed. It is NOT a substitute for the
 * subscription drive: no transcript is produced, so nothing here proves the
 * preassigned session id reaches one.
 *
 * THE TAB LEG IS DELIBERATELY NOT DRIVEN. `workspace: "auto"` would open a
 * real cmux surface, and #107 runs under a house rule that the surface count
 * must be unchanged at the end. So `workspace`/`surface` below are null
 * BY REQUEST — `workspace: "none"`, the default — never by degradation, and
 * `workspaceDegraded` is null for the same reason. A null here is not evidence
 * that the tab leg works.
 *
 * Reproduce:
 *   bun run scripts/acceptance/deploy-primitive-probe.ts
 */
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { deployWorker } from "../../src/deploy/index.ts";
import { NATIVE_CLAUDE } from "../../src/harness/subscription-gate.ts";
import { claudeConfigFile } from "../../src/deploy/trust.ts";
import { loadRegistry, registryPaths } from "../../src/provenance/index.ts";

const DISPATCH =
  "You are working ticket #107. Reply with exactly the word ACKNOWLEDGED and " +
  "nothing else. Do not run any commands and do not write any files.";

const line = (label: string, value: unknown): void => {
  console.log(`  ${label.padEnd(24)} ${typeof value === "string" ? value : JSON.stringify(value)}`);
};

const rule = (title: string): void => {
  console.log(`\n${"-".repeat(78)}\n${title}\n${"-".repeat(78)}`);
};

async function sandboxRepo(root: string): Promise<string> {
  const repo = join(root, "repo");
  await mkdir(repo, { recursive: true });
  await Bun.$`git -C ${repo} init --quiet`.quiet();
  await Bun.$`git -C ${repo} commit --quiet --allow-empty -m base`
    .env({
      ...process.env,
      GIT_AUTHOR_EMAIL: "deploy@invalid.example",
      GIT_AUTHOR_NAME: "Argus Deploy",
      GIT_COMMITTER_EMAIL: "deploy@invalid.example",
      GIT_COMMITTER_NAME: "Argus Deploy",
    })
    .quiet();
  return repo;
}

const root = await mkdtemp("/private/tmp/argus-107-trust-");
// Scratch HOME *and* scratch CLAUDE_CONFIG_DIR. The second is what makes the
// pre-trust write land somewhere throwaway; the first keeps the child out of
// the real home even if the binary ignores the second.
const home = join(root, "home");
const config = join(root, "cfg");
await mkdir(home, { recursive: true });
await mkdir(config, { recursive: true });
const env = { ...Bun.env, CLAUDE_CONFIG_DIR: config, HOME: home };

console.log("=".repeat(78));
console.log("ARGUS DEPLOY PRIMITIVE — PRE-TRUST PROBE (#96 step) — ticket #107");
console.log("=".repeat(78));
line("HEAD", (await Bun.$`git rev-parse HEAD`.text()).trim());
line("scratch root", root);
line("scratch HOME", home);
line("scratch CLAUDE_CONFIG_DIR", config);
line("config file to write", claudeConfigFile(env));
line("claude executable", NATIVE_CLAUDE);

let failed = 0;
const check = (name: string, ok: boolean, detail: string): void => {
  if (!ok) failed += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail === "" ? "" : ` — ${detail}`}`);
};

try {
  const repo = await sandboxRepo(root);

  rule("1. deployWorker, claude route, scratch everything");
  const result = await deployWorker(
    {
      agent: "claude",
      dispatchPrompt: DISPATCH,
      executable: NATIVE_CLAUDE,
      repo,
      ticket: "107",
    },
    { env },
  );
  line("status", result.status);
  if (result.status !== "deployed") {
    line("stage", result.stage);
    line("reason", result.reason);
    throw new Error(`deployWorker failed at ${result.stage}: ${result.reason}`);
  }
  const { deployment } = result;
  line("sessionId", deployment.sessionId);
  line("branch", deployment.branch);
  line("worktree", deployment.worktree);

  rule("2. the four fields the #55 run could not observe");
  // Explicit nulls: `undefined` and "absent" are indistinguishable in JSON,
  // and that ambiguity is half of why #55's file went stale invisibly.
  line("workspace", deployment.workspace ?? null);
  line("surface", deployment.surface ?? null);
  line("workspaceDegraded", deployment.workspaceDegraded ?? null);
  line("trustDegraded", deployment.trustDegraded ?? null);
  console.log(
    "\n  workspace/surface are null BY REQUEST (`workspace: \"none\"`, the default):\n" +
      "  this probe must not open a cmux surface. Not a degradation.",
  );

  rule("3. did the pre-trust step actually fire? (#96, src/deploy/trust.ts)");
  const configPath = claudeConfigFile(env);
  const written = await Bun.file(configPath)
    .json()
    .catch(() => null);
  const projects = (written?.projects ?? {}) as Record<string, { hasTrustDialogAccepted?: boolean }>;
  // `trust.ts` keys the entry by `resolve(worktree)`. Looked up exactly, then
  // by suffix, so a path that normalised differently fails the NEXT check by
  // name instead of failing this one as "no entry at all".
  const entry =
    Object.entries(projects).find(([path]) => path === deployment.worktree) ??
    Object.entries(projects).find(([path]) => path.endsWith("/ticket-107"));
  check("the config file exists at the path trust.ts computed", written !== null, configPath);
  check(
    "trustDegraded is null — the write did not degrade",
    deployment.trustDegraded === undefined,
    deployment.trustDegraded ?? "null",
  );
  check(
    "the deployed worktree is marked hasTrustDialogAccepted",
    entry?.[1]?.hasTrustDialogAccepted === true,
    entry === undefined ? `no entry for ${deployment.worktree}` : entry[0],
  );
  check(
    "nothing was written to the scratch HOME's own .claude.json",
    !(await Bun.file(join(home, ".claude.json")).exists()),
    join(home, ".claude.json"),
  );
  console.log(`\n  projects keys in the scratch config: ${JSON.stringify(Object.keys(projects))}`);

  rule("4. the row, fsynced before the process existed (#55's claim, re-driven)");
  const registry = await loadRegistry(registryPaths(repo));
  line("rows", registry.sessions.length);
  check(
    "the row carries the preassigned session id",
    registry.sessions.map(({ sessionId }) => sessionId).join(",") === deployment.sessionId,
    registry.sessions.map(({ sessionId }) => sessionId).join(","),
  );
  console.log(
    `\n  ${(await Bun.file(registryPaths(repo).sessionsFile).text()).trim()}`,
  );

  rule("5. where the oracle stops: the session itself");
  const exit = await deployment.process.exited;
  line("exit code", exit.exitCode);
  line("stderr tail", exit.stderr.trim().slice(-200) || "(empty)");
  line("stdout tail", exit.stdout.trim().slice(-200) || "(empty)");
  console.log(
    "\n  A scratch CLAUDE_CONFIG_DIR is not logged in (measured, #107), so the\n" +
      "  session stops here and writes no transcript. Everything checked above\n" +
      "  happened before this point. This is NOT the subscription drive.",
  );
} finally {
  await rm(root, { force: true, recursive: true });
  console.log(`\nscratch removed: ${root}`);
}

rule(`PRE-TRUST PROBE: ${failed === 0 ? "all checks passed" : `${failed} FAILED`}`);
process.exit(failed === 0 ? 0 : 1);
