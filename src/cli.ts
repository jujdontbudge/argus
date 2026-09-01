#!/usr/bin/env bun

import { lstat, mkdir, readlink, symlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HELP = `Argus — orchestration and self-learning toolkit

Usage: argus <command>

Commands:
  init     scaffold this repo for Argus (repo-local only; no machine wiring)
  up       init, converge machine wiring, and start this repo's eyes
  down     stop this repo's eyes
  status   inspect eyes and audits; acknowledge with --ack <audit-id>
  watch    run one eye
  grill    open a registered, attachable planning session (SPEC §7.2)
  dispatch run one AFK ticket-dispatch pass (SPEC §7.3)
  complete verify, merge, close and map finished tickets (SPEC §7.3.4)
  signals  consume push events and run one slow-poll fallback sweep
  search   search the transcript archive
  dash     serve the read-only local dashboard
  memory   one-time memory-store migrations
  install  install argus from this checkout

Flags:
  --ticket   (grill) owning GitHub ticket number (required)
  --mode     (grill) which planning skill to route to: grilling (default),
             spec, tickets, review, diagnosis. All route to Claude Code.
  --dry-run  (grill) print the routed skill and the exact opening prompt and
             stop; no workspace, no registry row, no session.
  --print-prompt (dispatch) print one fully assembled ticket prompt and stop;
                no claim, deployment or writes.
  --commit   (init, up) commit the integration files Argus wrote —
             .gitignore, AGENTS.md and docs/agents — as they stand in the
             working tree, in one "chore: adopt Argus" commit. Without it
             Argus commits nothing and prints the command instead.
  --from-now (up) seed every eye at the current transcript frontier; existing
             history stays untouched for a separate bounded import.
`;

export const MINIMUM_BUN_VERSION = "1.3.12";

export interface GrillArgs {
  dryRun: boolean;
  mode: string;
  model?: string;
  ticket: string;
  topic: string;
}

export type GrillArgsResult = GrillArgs | { error: string };

export function parseGrillArgs(args: readonly string[]): GrillArgsResult {
  let mode = "grilling";
  let model: string | undefined;
  let ticket: string | undefined;
  let dryRun = false;
  const topicParts: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--dry-run") {
      dryRun = true;
    } else if (argument === "--mode" || argument === "--model" || argument === "--ticket") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return { error: `argus grill: ${argument} needs a value` };
      }
      if (argument === "--mode") mode = value;
      else if (argument === "--model") model = value;
      else ticket = value;
      index += 1;
    } else if (argument.startsWith("--")) {
      return { error: `argus grill: unknown argument '${argument}'` };
    } else {
      topicParts.push(argument);
    }
  }

  const topic = topicParts.join(" ").trim();
  if (topic === "") return { error: "argus grill: a topic is required" };
  if (ticket === undefined) return { error: "argus grill: --ticket is required" };
  if (!/^\d+$/.test(ticket)) {
    return { error: `argus grill: --ticket must be a ticket number, got '${ticket}'` };
  }

  return { dryRun, mode, topic, ticket, ...(model !== undefined && { model }) };
}

function isVersionAtLeast(actual: string, minimum: string): boolean {
  const actualParts = actual.split("-", 1)[0]?.split(".").map(Number) ?? [];
  const minimumParts = minimum.split(".").map(Number);

  if (actualParts.length < 3 || actualParts.some(Number.isNaN)) {
    return false;
  }

  for (let index = 0; index < minimumParts.length; index += 1) {
    const difference = (actualParts[index] ?? 0) - (minimumParts[index] ?? 0);
    if (difference !== 0) return difference > 0;
  }

  return true;
}

async function install(): Promise<number> {
  const home = process.env.HOME;
  if (!home) {
    console.error("argus install: HOME is not set");
    return 1;
  }

  const binDirectory = join(home, ".local", "bin");
  const launcher = join(binDirectory, "argus");
  const cli = fileURLToPath(import.meta.url);
  const checkout = dirname(dirname(cli));

  try {
    await lstat(join(checkout, ".git"));
  } catch {
    console.error("argus install must run from a git checkout of Argus");
    return 1;
  }

  await mkdir(binDirectory, { recursive: true });
  try {
    const existingTarget = await readlink(launcher);
    if (existingTarget === cli) {
      console.log(`Argus is already installed at ${launcher}`);
      return 0;
    }

    console.error(
      `argus install: ${launcher} already points to ${existingTarget}; refusing to replace it`,
    );
    return 1;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }

  await symlink(cli, launcher);
  console.log(`Installed argus at ${launcher}`);
  return 0;
}

/**
 * `argus dispatch` — one pass of SPEC §7.3's AFK ticket dispatch (#56).
 *
 * ONE PASS, not a loop. Everything a pass needs to know it reads back from the
 * world it left behind — the tracker's assignments and the slot directory's
 * live pids — so running it again is safe, and running it on a cron is the
 * whole batch behaviour. A resident loop would add a process that must itself
 * be supervised, and would make the cap depend on that process staying alive.
 */
async function dispatch(args: string[]): Promise<number> {
  const usage = "Usage: argus dispatch [--print-prompt <ticket>]";
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(usage);
    return 0;
  }
  if (args[0] === "--print-prompt") {
    const ticketNumber = args[1];
    if (args.length !== 2 || ticketNumber === undefined || !/^\d+$/.test(ticketNumber)) {
      console.error(`argus dispatch: expected --print-prompt <ticket>\n${usage}`);
      return 1;
    }

    const { gitRoot } = await import("./up/git.ts");
    const repo = await gitRoot(process.cwd());
    if (repo === null) {
      console.error("argus dispatch: current directory is not inside a git repository");
      return 1;
    }

    const { runGh, trackerRepoName } = await import("./eyes/retro/gh.ts");
    const { buildDispatchPrompt, readDispatchTicket } = await import(
      "./dispatch/dispatch.ts"
    );
    try {
      const tracker = await trackerRepoName(repo, runGh);
      if (tracker === null) {
        console.error("argus dispatch: no GitHub tracker for this repository");
        return 1;
      }
      const ticket = await readDispatchTicket(ticketNumber, tracker, {
        cwd: repo,
        gh: runGh,
      });
      const { routeAgent } = await import("./dispatch/routing.ts");
      const routing = routeAgent(ticket.labels);
      const prompt = await buildDispatchPrompt(ticket, tracker, {
        gh: runGh,
        repo,
        ...(routing.status === "routed" && { agent: routing.agent }),
      });
      console.log(prompt);
      return 0;
    } catch (error) {
      console.error(`argus dispatch: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  if (args.length > 0) {
    console.error(`argus dispatch: unknown argument '${args[0]}'\n${usage}`);
    return 1;
  }

  const { gitRoot } = await import("./up/git.ts");
  const repo = await gitRoot(process.cwd());
  if (repo === null) {
    console.error("argus dispatch: current directory is not inside a git repository");
    return 1;
  }

  const { dispatchFrontier } = await import("./dispatch/index.ts");
  const report = await dispatchFrontier({ repo });

  for (const recovered of report.recovered) {
    console.log(
      `recovered #${recovered.ticket}: ${recovered.outcome} (${recovered.detail})`,
    );
  }
  for (const deployed of report.dispatched) {
    console.log(
      `dispatched #${deployed.ticket} -> ${deployed.agent} session ${deployed.sessionId}` +
        ` on ${deployed.branch}` +
        (deployed.workspace === undefined ? "" : ` (cmux ${deployed.workspace})`),
    );
  }
  for (const skipped of report.skipped) {
    console.log(`skipped #${skipped.ticket}: ${skipped.reason}`);
  }
  console.log(
    `${report.dispatched.length} dispatched; ${report.inFlight}/${report.maxConcurrency} ` +
      `sessions in flight; ${report.excluded.length} tickets held back`,
  );
  for (const reason of report.degraded) console.error(`DEGRADED: ${reason}`);
  // A degraded pass is a visible failure, never a quiet success (ADR-0001).
  return report.degraded.length > 0 ? 1 : 0;
}

/**
 * `argus complete` — one pass of SPEC §7.3.4's verify/merge/close/map loop
 * (#57).
 *
 * One pass, like `argus dispatch`, and for the same reason: everything it
 * needs it reads back from the world — this sweep's completion signals and the
 * durable verification queue — so running it again is safe and running it on a
 * cron is the whole behaviour.
 *
 * A pass that REFUSED something exits non-zero. A red gate is not a crash, but
 * it is also not a success, and a cron that only ever sees 0 is a cron nobody
 * ever looks at (ADR-0001's posture).
 */
async function complete(): Promise<number> {
  const { gitRoot } = await import("./up/git.ts");
  const repo = await gitRoot(process.cwd());
  if (repo === null) {
    console.error("argus complete: current directory is not inside a git repository");
    return 1;
  }

  const { completeReadyTickets } = await import("./complete/index.ts");
  const report = await completeReadyTickets({ repo });

  for (const outcome of report.completed) {
    console.log(`#${outcome.ticket}: ${outcome.status} — ${outcome.detail}`);
  }
  const merged = report.completed.filter(({ status }) => status === "merged").length;
  console.log(
    `${merged} merged and closed into ${report.base}; ` +
      `${report.queued} still awaiting verification`,
  );
  for (const reason of report.degraded) console.error(`DEGRADED: ${reason}`);
  return report.degraded.length > 0 ? 1 : 0;
}

/**
 * `argus grill "<topic>"` — SPEC §7.2, Johan's planning entry point (#62).
 *
 * The one Argus command that opens a session FOR Johan rather than at an
 * agent: a registered, attachable Claude session in a fresh cmux workspace on
 * this repo, routed to a planning skill, announced with `cmux notify`.
 *
 * It refuses rather than degrades when cmux cannot give it a resolved
 * workspace, because §7.2 step 3 is "Johan answers in the terminal directly"
 * and a headless planning session has nobody to answer it. `--dry-run` is the
 * way to see the routed skill and the exact opening prompt without spending a
 * session on it.
 */
async function grill(args: string[]): Promise<number> {
  const usage =
    'Usage: argus grill "<topic>" --ticket <n>' +
    ' [--mode <grilling|spec|tickets|review|diagnosis>] [--model <model>] [--dry-run]';
  const { isGrillMode, resolveGrillDispatch, resolveGrillModel, grillPrompt, startGrill } = await import(
    "./grill/index.ts"
  );
  const parsed = parseGrillArgs(args);
  if ("error" in parsed) {
    console.error(`${parsed.error}\n${usage}`);
    return 1;
  }
  const { dryRun, mode, model, ticket, topic } = parsed;
  if (!isGrillMode(mode)) {
    console.error(`argus grill: unknown mode '${mode}'\n${usage}`);
    return 1;
  }

  const { gitRoot } = await import("./up/git.ts");
  const repo = await gitRoot(process.cwd());
  if (repo === null) {
    console.error("argus grill: current directory is not inside a git repository");
    return 1;
  }

  if (dryRun) {
    // #97: the dry run resolves the mode the way the real dispatch does, so a
    // mode no session could invoke is REFUSED here too. A dry run that printed
    // a prompt the live command would refuse to send would be the same silent
    // wrong answer one step earlier.
    const dispatch = await resolveGrillDispatch(repo, mode);
    if (dispatch.status === "refused") {
      console.error(`argus grill: ${dispatch.reason}`);
      return 1;
    }
    const { invocation } = dispatch;
    console.log(`model: ${await resolveGrillModel(repo, model)}`);
    console.log(`repo:  ${repo}`);
    console.log(`skill: ${invocation.skill} (${invocation.source}, ${invocation.form})`);
    console.log(`from:  ${invocation.path}`);
    console.log("prompt:");
    console.log(grillPrompt({ invocation, ticket, topic }));
    console.log("\nDry run: no cmux workspace, no registry row and no session.");
    return 0;
  }

  const result = await startGrill({
    mode,
    repo,
    topic,
    ticket,
    ...(model !== undefined && { model }),
  });

  if (result.status === "refused") {
    console.error(`argus grill: ${result.reason}`);
    return 1;
  }
  if (result.status === "failed") {
    // The row is durable and the session is not. Say both, because the
    // classifier is about to raise `dispatch-expired` for this session id and
    // that audit is unreadable without the name.
    console.error(`argus grill: ${result.reason}`);
    if (result.sessionId !== undefined) {
      console.error(
        `the deployment row for session ${result.sessionId} stays (a row is never retracted);` +
          " expect a dispatch-expired audit for it",
      );
    }
    return 1;
  }

  console.log(`session ${result.sessionId} (${result.skill}) in cmux ${result.workspace}`);
  console.log(result.attach);
  for (const reason of result.degraded) console.error(`DEGRADED: ${reason}`);
  // A grill that started is a success even unannounced: Johan has the ref
  // above, and the line the notifier failed to deliver is printed here.
  return 0;
}

async function search(args: string[]): Promise<number> {
  const query = args.join(" ").trim();
  if (query.length === 0) {
    console.error('Usage: argus search "<query>"');
    return 1;
  }

  const { gitRoot } = await import("./up/git.ts");
  const repo = await gitRoot(process.cwd());
  if (repo === null) {
    console.error("argus search: current directory is not inside a git repository");
    return 1;
  }
  if (!(await Bun.file(join(repo, ".argus/archive.db")).exists())) {
    console.error(`argus search: no archive exists for ${repo}`);
    return 1;
  }

  const { openArchiveSearch } = await import("./search/index.ts");
  const archive = openArchiveSearch({ repo });
  try {
    const results = archive.query(query);
    if (results.length === 0) {
      console.log(`No archived messages matched "${query}".`);
      return 0;
    }
    for (const result of results) {
      const attribution = [
        result.ts,
        `session=${result.sessionId}`,
        `agent=${result.agent ?? "unknown"}`,
        `role=${result.role}`,
        `provenance=${result.provenance}`,
        ...(result.ticket !== null ? [`ticket=#${result.ticket}`] : []),
      ].join("  ");
      console.log(attribution);
      console.log(`  ${result.snippet}`);
    }
    return 0;
  } finally {
    archive.close();
  }
}

/** `argus dash` is an on-demand reader (#128), never a supervised eye. */
async function dash(args: string[]): Promise<number> {
  let requestedRepo = process.cwd();
  let port: number | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--repo" || flag === "--port") {
      const value = args[++index];
      if (!value || value.startsWith("--")) { console.error("Usage: argus dash [--repo <path>] [--port <n>]"); return 1; }
      if (flag === "--repo") requestedRepo = value;
      else { port = Number(value); if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error("argus dash: invalid port"); return 1; } }
    } else { console.error(`argus dash: unknown argument '${flag}'`); return 1; }
  }
  const { gitRoot } = await import("./up/git.ts");
  const repo = await gitRoot(requestedRepo);
  if (repo === null) { console.error(`argus dash: no git repository contains ${requestedRepo}`); return 1; }
  const { createDashServer } = await import("./dash/index.ts");
  const server = createDashServer({ repo, ...(port !== undefined && { port }) });
  console.log(`Argus dashboard: http://${server.hostname}:${server.port}/`);
  await new Promise<void>(() => {});
  return 0;
}

async function signals(args: string[]): Promise<number> {
  const repoFlag = args.indexOf("--repo");
  if (repoFlag !== -1 && !args[repoFlag + 1]) {
    console.error("Usage: argus signals [--repo <path>]");
    return 1;
  }
  const unknown = args.filter(
    (argument, index) => argument !== "--repo" && index !== repoFlag + 1,
  );
  if (unknown.length > 0) {
    console.error(`argus signals: unknown argument '${unknown[0]}'`);
    return 1;
  }

  const { pollHermesSignals, resolveArgusRepo, runCmux } = await import(
    "./events/index.ts"
  );
  const requestedRepo = repoFlag === -1 ? process.cwd() : args[repoFlag + 1]!;
  const repo = await resolveArgusRepo(requestedRepo);
  if (repo === null) {
    console.error(`argus signals: no Argus repository contains ${requestedRepo}`);
    return 1;
  }
  const pending = await pollHermesSignals(repo, { cmux: runCmux });
  for (const { prompt } of pending) console.log(prompt);
  return 0;
}

export async function main(args: string[]): Promise<number> {
  const bunVersion = process.versions.bun;
  if (!bunVersion || !isVersionAtLeast(bunVersion, MINIMUM_BUN_VERSION)) {
    console.error(
      `argus requires Bun >= ${MINIMUM_BUN_VERSION}; found ${bunVersion ?? "unknown"}`,
    );
    return 1;
  }

  if (args.length === 0 || args[0] === "--help" || args[0] === "-h") {
    console.log(HELP);
    return 0;
  }

  if (args[0] === "init" || args[0] === "up") {
    const command = args[0];
    const flags = args.slice(1);
    const allowed =
      command === "up" ? new Set(["--commit", "--from-now"]) : new Set(["--commit"]);
    const unknown = flags.find((flag) => !allowed.has(flag));
    if (unknown !== undefined) {
      console.error(`argus ${command}: unknown argument '${unknown}'`);
      return 1;
    }
    const options = {
      commit: flags.includes("--commit"),
      fromNow: flags.includes("--from-now"),
    };
    const { convergeUp, initRepo } = await import("./up.ts");
    try {
      return command === "init"
        ? await initRepo(process.cwd(), options)
        : await convergeUp(process.cwd(), options);
    } catch (error) {
      // A converger that cannot converge says why and fails; it never leaves
      // a raw rejection for the user to decode (ADR-0001).
      console.error(error instanceof Error ? error.message : String(error));
      return 1;
    }
  }

  if (args[0] === "down") {
    const { down } = await import("./supervisor/commands.ts");
    return down();
  }

  if (args[0] === "status") {
    const { status } = await import("./supervisor/commands.ts");
    return status(args.slice(1));
  }

  if (args[0] === "supervisor") {
    const { runSupervisorDaemon } = await import("./supervisor/daemon.ts");
    return runSupervisorDaemon();
  }

  if (args[0] === "dispatch") {
    return dispatch(args.slice(1));
  }

  if (args[0] === "complete") {
    return complete();
  }

  if (args[0] === "grill") {
    return grill(args.slice(1));
  }

  if (args[0] === "search") {
    return search(args.slice(1));
  }

  if (args[0] === "dash") return dash(args.slice(1));

  if (args[0] === "signals") {
    return signals(args.slice(1));
  }

  if (args[0] === "memory" && args[1] === "claude-mem") {
    const { claudeMemCommand } = await import("./memory/cli.ts");
    return claudeMemCommand(args.slice(2));
  }

  if (args[0] === "watch") {
    const { runWatcher } = await import("./watch.ts");
    return runWatcher(args.slice(1));
  }

  if (args[0] === "install") {
    return install();
  }

  console.error(`argus: unknown command '${args[0]}'`);
  return 1;
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
