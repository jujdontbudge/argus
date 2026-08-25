/**
 * Ticket #36 — the LIVE `argus` command sweep.
 *
 * Every command is executed as a real subprocess against a real sandbox repo
 * built by the §13 harness (`createSandbox`): throwaway git repo, scratch HOME,
 * scratch ARGUS_REPOS_FILE / CLAUDE_CONFIG_DIR / CODEX_HOME / HERMES_HOME /
 * XDG dirs, and a cmux socket path that points nowhere real. Nothing here
 * touches ~/argus, ~/.claude, ~/.hermes, ~/.argus-repos, real launchd, or a
 * production cmux — the SPEC §13 isolation rule.
 *
 * Output is the transcript: exit code, stdout and stderr of every invocation,
 * recorded as run, not as expected.
 */
import { mkdir, readdir, readlink, rm, stat } from "node:fs/promises";
import { join } from "node:path";

import { ArchiverEye } from "../../src/eyes/archiver/archiver.ts";
import { createSandbox, type Sandbox } from "../../src/harness/index.ts";
import { ProvenanceClassifier } from "../../src/provenance/index.ts";
import { createClaudeCodeSource, Tailer } from "../../src/tailing/index.ts";
import { createWatcherSpawner } from "../../src/supervisor/daemon.ts";
import { EYE_NAMES, WatcherSupervisor } from "../../src/supervisor/runtime.ts";

const checkout = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const cli = join(checkout, "src/cli.ts");

interface Invocation {
  argv: string[];
  cwd: string;
  exitCode: number;
  stderr: string;
  stdout: string;
}

const transcript: Invocation[] = [];

async function argus(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
): Promise<Invocation> {
  const child = Bun.spawn([process.execPath, cli, ...argv], {
    cwd,
    env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const invocation = { argv, cwd, exitCode, stderr, stdout };
  transcript.push(invocation);
  return invocation;
}

/**
 * `argus watch <eye>` is a DAEMON since #39 — it is supposed to stay up, so
 * `argus()` above (which awaits exit) would hang here forever. That helper was
 * written when watch was a stub that exited 1 immediately; a run that returns
 * promptly is now the failure, not the pass. Observe the child for a window,
 * record whether it is still alive, then stop it and report how it took the
 * signal (#39 claims SIGTERM is clean even mid-backoff).
 */
async function watchDaemon(
  argv: string[],
  cwd: string,
  env: Record<string, string>,
  observeMilliseconds = 1_500,
): Promise<Invocation & { alive: boolean; pid: number; signalled: boolean }> {
  const child = Bun.spawn([process.execPath, cli, ...argv], {
    cwd,
    env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const pid = child.pid;
  const early = await Promise.race([
    child.exited.then((code) => ({ code, exited: true })),
    Bun.sleep(observeMilliseconds).then(() => ({ code: null, exited: false })),
  ]);
  const alive = !early.exited;
  if (alive) child.kill("SIGTERM");
  const exitCode = await child.exited;
  const [stdout, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  const invocation = { argv, cwd, exitCode, stderr, stdout };
  transcript.push(invocation);
  return { ...invocation, alive, pid, signalled: alive };
}

function show(label: string, invocation: Invocation): void {
  console.log(`\n$ argus ${invocation.argv.join(" ")}      # ${label}`);
  console.log(`  exit ${invocation.exitCode}`);
  for (const line of invocation.stdout.split("\n").filter(Boolean)) {
    console.log(`  out| ${line}`);
  }
  for (const line of invocation.stderr.split("\n").filter(Boolean)) {
    console.log(`  err| ${line}`);
  }
}

/** Byte-exact snapshot of a tree, for the idempotency comparison. */
async function snapshot(root: string): Promise<string> {
  const entries: string[] = [];
  const visit = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const path = join(directory, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        entries.push(`d ${relative}`);
        await visit(path, relative);
      } else if (entry.isSymbolicLink()) {
        entries.push(`l ${relative} -> ${await readlink(path)}`);
      } else {
        entries.push(
          `f ${relative} ${Bun.SHA256.hash(
            await Bun.file(path).arrayBuffer(),
            "hex",
          )}`,
        );
      }
    }
  };
  await visit(root, "");
  return entries.join("\n");
}

/** Seed `.argus/archive.db` with real archived transcript content. */
async function seedArchive(sandbox: Sandbox): Promise<void> {
  const session = "acceptance-sweep-session";
  const directory = join(sandbox.root, "sweep-transcripts");
  await mkdir(directory, { recursive: true });
  const file = join(directory, `${session}.jsonl`);
  const line = (
    uuid: string,
    role: "user" | "assistant",
    text: string,
    ts: string,
  ): string =>
    `${JSON.stringify({
      type: role,
      message:
        role === "user"
          ? { role, content: text }
          : { role, content: [{ type: "text", text }] },
      timestamp: ts,
      ...(role === "user" && { promptSource: "typed" }),
      uuid,
      sessionId: session,
      cwd: sandbox.repo,
      version: "2.1.245",
      isSidechain: false,
    })}\n`;
  await Bun.write(
    file,
    line("sweep-u-1", "user", "How did we solve the torn status read?", "2026-08-25T09:00:00.000Z") +
      line(
        "sweep-a-1",
        "assistant",
        "We solved the torn status read by writing supervisor status temp-then-rename.",
        "2026-08-25T09:00:05.000Z",
      ),
  );

  const classifier = new ProvenanceClassifier();
  classifier.registerSession({
    ts: "2026-08-25T09:00:00.000Z",
    sessionId: session,
    agent: "claude",
    ticket: "36",
    dispatchPrompt: "How did we solve the torn status read?",
  });

  const archiver = await ArchiverEye.open({ repo: sandbox.repo });
  try {
    const batch = await archiver.catchUp(
      new Tailer(createClaudeCodeSource({ dir: directory })),
      classifier,
    );
    console.log(
      `  archived ${batch.inserted}/${batch.received} messages into .argus/archive.db`,
    );
  } finally {
    archiver.close();
  }
}

const sandbox = await createSandbox({ checkout });
const env = { ...sandbox.env } as Record<string, string>;

try {
  console.log("=".repeat(78));
  console.log("ARGUS LIVE COMMAND SWEEP — ticket #36");
  console.log("=".repeat(78));
  console.log(`checkout        ${checkout}`);
  console.log(`sandbox root    ${sandbox.root}`);
  console.log(`sandbox repo    ${sandbox.repo}`);
  console.log(`scratch HOME    ${env.HOME}`);
  console.log(`scratch registry ${env.ARGUS_REPOS_FILE}`);
  console.log(`scratch CLAUDE  ${env.CLAUDE_CONFIG_DIR}`);
  console.log(`scratch HERMES  ${env.HERMES_HOME}`);
  console.log(`scratch CODEX   ${env.CODEX_HOME}`);
  console.log(`scratch cmux    ${env.CMUX_SOCKET_PATH}`);

  console.log("\n" + "-".repeat(78));
  console.log("1. argus --help");
  console.log("-".repeat(78));
  show("help", await argus(["--help"], sandbox.repo, env));

  console.log("\n" + "-".repeat(78));
  console.log("2. argus up  (first run — performed by the harness sandbox factory)");
  console.log("-".repeat(78));
  transcript.push({
    argv: ["up"],
    cwd: sandbox.repo,
    exitCode: sandbox.up.exitCode,
    stderr: sandbox.up.stderr,
    stdout: sandbox.up.stdout,
  });
  show("up #1 (fresh repo)", transcript.at(-1)!);

  const afterFirstUp = await snapshot(join(sandbox.repo, ".argus"));
  const agentsAfterFirstUp = await Bun.file(join(sandbox.repo, "AGENTS.md")).text();
  const registryAfterFirstUp = await Bun.file(env.ARGUS_REPOS_FILE!).text();
  const claudeSettings = join(sandbox.repo, ".claude/settings.local.json");
  const settingsAfterFirstUp = await Bun.file(claudeSettings).text();
  const codexConfig = join(env.CODEX_HOME!, "config.toml");
  const codexAfterFirstUp = await Bun.file(codexConfig).text();

  console.log("\n" + "-".repeat(78));
  console.log("3. argus up  (second run — idempotency)");
  console.log("-".repeat(78));
  show("up #2 (idempotent)", await argus(["up"], sandbox.repo, env));

  const afterSecondUp = await snapshot(join(sandbox.repo, ".argus"));
  console.log("\n  IDEMPOTENCY CHECKS");
  console.log(
    `  .argus/ tree byte-identical across the two ups .. ${
      afterFirstUp === afterSecondUp ? "YES" : "NO"
    }`,
  );
  console.log(
    `  AGENTS.md byte-identical ....................... ${
      agentsAfterFirstUp ===
      (await Bun.file(join(sandbox.repo, "AGENTS.md")).text())
        ? "YES"
        : "NO"
    }`,
  );
  console.log(
    `  ~/.argus-repos byte-identical (no dupe rows) ... ${
      registryAfterFirstUp === (await Bun.file(env.ARGUS_REPOS_FILE!).text())
        ? "YES"
        : "NO"
    }`,
  );
  console.log(
    `  .claude/settings.local.json byte-identical ..... ${
      settingsAfterFirstUp === (await Bun.file(claudeSettings).text()) ? "YES" : "NO"
    }`,
  );
  console.log(
    `  $CODEX_HOME/config.toml byte-identical ......... ${
      codexAfterFirstUp === (await Bun.file(codexConfig).text()) ? "YES" : "NO"
    }`,
  );
  console.log(`  registry rows: ${JSON.stringify(registryAfterFirstUp)}`);

  console.log("\n" + "-".repeat(78));
  console.log("4. argus up  (from a nested subdirectory — repo-root resolution)");
  console.log("-".repeat(78));
  const nested = join(sandbox.repo, "src/deep/nest");
  await mkdir(nested, { recursive: true });
  show("up from subdir", await argus(["up"], nested, env));

  console.log("\n" + "-".repeat(78));
  console.log("5. argus status");
  console.log("-".repeat(78));
  show("status (repo enrolled)", await argus(["status"], sandbox.repo, env));

  console.log("\n" + "-".repeat(78));
  console.log("6. argus search  (against seeded archive content)");
  console.log("-".repeat(78));
  show("search with no archive", await argus(["search", "torn"], sandbox.repo, env));
  await seedArchive(sandbox);
  console.log(
    `\n  seeded ${(await stat(join(sandbox.repo, ".argus/archive.db"))).size} bytes of .argus/archive.db`,
  );
  show("search hit", await argus(["search", "torn status read"], sandbox.repo, env));
  show("search from a subdir", await argus(["search", "temp-then-rename"], nested, env));
  show("search miss", await argus(["search", "zzz-nothing-matches-this"], sandbox.repo, env));
  show("search with no query", await argus(["search"], sandbox.repo, env));

  console.log("\n" + "-".repeat(78));
  console.log("7. argus watch <eye>  — for each of the five eyes");
  console.log("-".repeat(78));
  console.log(
    "  (a real daemon MUST still be alive after the observation window;",
  );
  console.log("   #36 measured all five as `exit 1 — not implemented yet`)");
  for (const eye of EYE_NAMES) {
    const daemon = await watchDaemon(
      ["watch", eye, "--repo", sandbox.repo],
      sandbox.repo,
      env,
    );
    show(`watch ${eye}`, daemon);
    console.log(
      `  ==> pid ${daemon.pid} ${
        daemon.alive
          ? `ALIVE after the window, then exited ${daemon.exitCode} on SIGTERM`
          : `DIED on its own with exit ${daemon.exitCode}  <-- NOT a daemon`
      }`,
    );
  }

  console.log("\n  the two legible refusals #39 claims (these DO exit on their own):");
  show(
    "watch with an unknown eye",
    await argus(["watch", "nosuchteye", "--repo", sandbox.repo], sandbox.repo, env),
  );
  const unenrolled = join(sandbox.root, "unenrolled-repo");
  await mkdir(unenrolled, { recursive: true });
  show(
    "watch an unenrolled repo",
    await argus(["watch", "reviewer", "--repo", unenrolled], unenrolled, env),
  );

  console.log("\n" + "-".repeat(78));
  console.log("7b. the REAL supervisor daemon spawning those same `argus watch` children");
  console.log("-".repeat(78));
  console.log(
    "  (this is exactly what `runSupervisorDaemon` does in production:",
  );
  console.log("   createWatcherSpawner([bunPath, cliPath]) -> `argus watch <eye> --repo <repo>`)");
  const statusPath = join(sandbox.root, "state", "live-sweep-supervisor.json");
  const supervisor = new WatcherSupervisor({
    registryPath: env.ARGUS_REPOS_FILE!,
    restartDelayMilliseconds: 50,
    // The sandbox env is REQUIRED now that watch is real. In production the
    // daemon omits it so children inherit the daemon's own environment, which
    // is the real one; here that would point them at the real ~/.argus-repos,
    // where the sandbox repo is not enrolled, so each child refuses and the
    // supervisor restarts it forever. That reads as a restart storm but is an
    // artifact of the sweep, not of the supervisor — see scenarios 6 and the
    // watch-stability probe, which both pass sandbox.env.
    spawn: createWatcherSpawner([process.execPath, cli], sandbox.env),
    statusPath,
  });
  // The supervisor restarts dying children from an un-awaited handler, so its
  // own failures arrive as unhandled rejections. Count them instead of letting
  // Bun paint the transcript with stack traces.
  const supervisorErrors: string[] = [];
  const onRejection = (error: unknown): void => {
    supervisorErrors.push(
      error instanceof Error ? `${error.name}: ${error.message.split("\n")[0]}` : String(error),
    );
  };
  process.on("unhandledRejection", onRejection);
  const seenPids = new Set<number>();
  try {
    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
      try {
        await supervisor.reconcile();
      } catch (error) {
        onRejection(error);
      }
      try {
        const snapshot = (await Bun.file(statusPath).json()) as {
          watchers: Array<{ eye: string; pid: number }>;
        };
        for (const watcher of snapshot.watchers) seenPids.add(watcher.pid);
      } catch {
        // the status file is mid-rename or has not been written yet
      }
      await Bun.sleep(50);
    }
    console.log(`\n  after 3s of real supervision of ${EYE_NAMES.length} eyes:`);
    console.log(`    distinct watcher PIDs spawned .. ${seenPids.size}`);
    console.log(
      `    verdict ........................ ${
        seenPids.size > EYE_NAMES.length
          ? "RESTART LOOP — every `argus watch` child exits 1 immediately"
          : "watchers stayed up"
      }`,
    );
    const enoent = supervisorErrors.filter((error) => error.includes("ENOENT"));
    console.log(`    supervisor's own failures ...... ${supervisorErrors.length}`);
    console.log(
      `    of which ENOENT on status.tmp .. ${enoent.length}${
        enoent.length > 0
          ? "  <-- #writeStatus renames a FIXED temp path; concurrent writers collide"
          : ""
      }`,
    );
    if (enoent[0] !== undefined) console.log(`    e.g. ${enoent[0]}`);
  } finally {
    try {
      await supervisor.stop();
    } catch (error) {
      onRejection(error);
    }
    process.off("unhandledRejection", onRejection);
  }

  console.log("\n" + "-".repeat(78));
  console.log("8. argus down, then argus status");
  console.log("-".repeat(78));
  show("down", await argus(["down"], sandbox.repo, env));
  console.log(
    `  registry after down: ${JSON.stringify(
      await Bun.file(env.ARGUS_REPOS_FILE!).text(),
    )}`,
  );
  show("status (after down)", await argus(["status"], sandbox.repo, env));

  console.log("\n" + "-".repeat(78));
  console.log("9. clone-is-install bootstrap");
  console.log("-".repeat(78));
  const installHome = join(sandbox.root, "install-home");
  await mkdir(installHome, { recursive: true });
  const installEnv = { ...env, HOME: installHome };
  show("install (fresh scratch HOME)", await argus(["install"], checkout, installEnv));
  const launcher = join(installHome, ".local/bin/argus");
  console.log(`  ${launcher} -> ${await readlink(launcher)}`);
  show("install (second run — idempotent)", await argus(["install"], checkout, installEnv));

  const launcherRun = Bun.spawnSync([launcher, "--help"], { env: installEnv });
  console.log(`\n$ ${launcher} --help      # the installed launcher actually runs`);
  console.log(`  exit ${launcherRun.exitCode}`);
  for (const line of launcherRun.stdout.toString().split("\n").filter(Boolean)) {
    console.log(`  out| ${line}`);
  }

  const notACheckout = join(sandbox.root, "not-a-checkout");
  await mkdir(join(notACheckout, "src"), { recursive: true });
  await Bun.write(join(notACheckout, "src/cli.ts"), await Bun.file(cli).text());
  const refused = Bun.spawnSync(
    [process.execPath, join(notACheckout, "src/cli.ts"), "install"],
    { env: { ...installEnv, HOME: join(sandbox.root, "install-home-2") } },
  );
  console.log(`\n$ argus install      # from a non-checkout copy (must refuse)`);
  console.log(`  exit ${refused.exitCode}`);
  console.log(`  err| ${refused.stderr.toString().trim()}`);

  console.log("\n" + "-".repeat(78));
  console.log("10. argus <unknown>");
  console.log("-".repeat(78));
  show("unknown command", await argus(["nope"], sandbox.repo, env));

  console.log("\n" + "-".repeat(78));
  console.log("11. argus up outside a git repository");
  console.log("-".repeat(78));
  const outside = join(sandbox.root, "outside-git");
  await mkdir(outside, { recursive: true });
  show("up outside git", await argus(["up"], outside, env));

  console.log("\n" + "=".repeat(78));
  console.log("SWEEP SUMMARY");
  console.log("=".repeat(78));
  for (const invocation of transcript) {
    console.log(
      `  exit ${String(invocation.exitCode).padStart(3)}  argus ${invocation.argv.join(" ")}`,
    );
  }
} finally {
  await sandbox.teardown();
  await rm(join(sandbox.root), { force: true, recursive: true });
  console.log("\nsandbox torn down.");
}
