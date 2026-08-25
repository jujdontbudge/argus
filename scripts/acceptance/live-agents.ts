/**
 * Ticket #36 — the LIVE test-agent drive.
 *
 * SPEC §13's simulation driver, run for real: a genuine Codex sol high session
 * (`codex -c model_reasoning_effort=high`, gpt-5.6-sol) is deployed into a
 * throwaway worktree of a harness sandbox repo, driven through a dispatch
 * prompt, a registry-logged Hermes nudge and an UNLOGGED fake-Johan takeover,
 * and then a second unregistered session commits real work. Everything Argus
 * asserts afterwards is read from the transcript the model actually wrote —
 * no fixture JSONL anywhere in this file.
 *
 * Isolation (SPEC §13): harness sandbox repo + scratch HOME/state, a scratch
 * $CODEX_HOME whose only production import is a copy of `auth.json` (the one
 * touchpoint a live call needs, exactly as the live-luna brain tests do), and
 * throwaway git worktrees. No production dispatcher, no live worker, no real
 * ~/argus, ~/.claude, ~/.hermes, ~/.argus-repos, no real cmux.
 */
import { appendFile, copyFile, mkdir, readdir } from "node:fs/promises";
import { realpath } from "node:fs/promises";
import { join } from "node:path";

import { createSandbox, type Sandbox } from "../../src/harness/index.ts";
import {
  CODEX_AUTH_FILE,
  describeLiveAgentGate,
  probeLiveAgents,
  resolveLiveAgentGate,
} from "../../src/harness/live-gate.ts";
import {
  classifierFromRegistry,
  loadRegistry,
  registryPaths,
  type ProvenanceRecord,
} from "../../src/provenance/index.ts";
import { attributeChanges } from "../../src/eyes/retro/attribution.ts";
import { scanGit } from "../../src/eyes/retro/git.ts";
import { openRetro } from "../../src/eyes/retro/retro.ts";
import { createCodexSource, Tailer } from "../../src/tailing/index.ts";
import type { MessageEvent, SessionMetaEvent } from "../../src/tailing/index.ts";

const CODEX_MODEL_ARGS = ["-c", "model_reasoning_effort=high"];
const liveGate = resolveLiveAgentGate(probeLiveAgents());
console.log(describeLiveAgentGate(liveGate));
if (liveGate.codex.status !== "run") process.exit(0);

const checks: Array<{ ok: boolean; what: string }> = [];
function check(ok: boolean, what: string): void {
  checks.push({ ok, what });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}`);
}

interface CodexRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function codex(
  argv: string[],
  cwd: string,
  codexHome: string,
  env: Record<string, string>,
): Promise<CodexRun> {
  const child = Bun.spawn(["codex", "exec", ...argv], {
    cwd,
    env: { ...env, CODEX_HOME: codexHome },
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/** The rollout files codex wrote, newest last. */
async function rollouts(codexHome: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".jsonl")) found.push(path);
    }
  };
  await walk(join(codexHome, "sessions"));
  return found.sort();
}

function sessionIdOf(rollout: string): string {
  const match = rollout.match(
    /rollout-[\d-]+T[\d-]+-([0-9a-f-]{36})\.jsonl$/,
  );
  if (!match?.[1]) throw new Error(`cannot read a session id from ${rollout}`);
  return match[1];
}

const sandbox: Sandbox = await createSandbox({
  checkout: new URL("../../", import.meta.url).pathname.replace(/\/$/, ""),
});
const env = { ...sandbox.env } as Record<string, string>;
const codexHome = join(sandbox.root, "state", "codex-live");

try {
  console.log("=".repeat(78));
  console.log("ARGUS LIVE TEST-AGENT DRIVE — ticket #36");
  console.log("=".repeat(78));
  console.log(`sandbox repo   ${sandbox.repo}`);
  console.log(`scratch CODEX_HOME ${codexHome}`);
  console.log(`argus up exit  ${sandbox.up.exitCode}`);

  await mkdir(codexHome, { recursive: true });
  await copyFile(CODEX_AUTH_FILE, join(codexHome, "auth.json"));

  const version = Bun.spawnSync(["codex", "--version"]).stdout.toString().trim();
  console.log(`codex CLI      ${version}`);

  // Open and PRIME the real Retro eye before any agent touches the sandbox:
  // a fresh install must never retro the repo's own history (the sandbox's
  // bootstrap commit and `argus up`'s .gitignore commit are not rogue work).
  // The brain is the real one from .argus/config.yaml — gpt-5.6-luna via
  // `codex exec`, the same live brain the eye uses in production.
  const retro = await openRetro(sandbox.repo, {
    capDirectory: join(sandbox.root, "state/brain-slots"),
    onAlert: (alert) => console.log(`  retro ALERT ${JSON.stringify(alert)}`),
    onAudit: (audit) => console.log(`  retro audit ${JSON.stringify(audit)}`),
  });
  await retro.prime();
  console.log("retro eye     primed (live brain, cursor anchored on repo history)");

  // ---------------------------------------------------------------- ticket
  const ticketWorktree = await sandbox.createWorktree("live-ticket");
  const DISPATCH =
    "You are working ticket #36 in this repo. Create a file called NOTES.md " +
    "containing exactly one line: `ticket-36 live acceptance`. Then stop.";

  console.log("\n" + "-".repeat(78));
  console.log("1. deploy a REAL Codex sol high session (the dispatch prompt)");
  console.log("-".repeat(78));
  const deployed = await codex(
    [
      ...CODEX_MODEL_ARGS,
      "--cd",
      ticketWorktree,
      "--sandbox",
      "workspace-write",
      DISPATCH,
    ],
    ticketWorktree,
    codexHome,
    env,
  );
  console.log(`  exit ${deployed.exitCode}`);
  console.log(
    deployed.stdout
      .split("\n")
      .slice(-8)
      .map((line) => `  out| ${line}`)
      .join("\n"),
  );
  if (deployed.exitCode !== 0) {
    console.log(deployed.stderr.split("\n").map((l) => `  err| ${l}`).join("\n"));
    throw new Error("the live codex deployment failed");
  }

  const afterDeploy = await rollouts(codexHome);
  const ticketRollout = afterDeploy.at(-1)!;
  const ticketSession = sessionIdOf(ticketRollout);
  console.log(`\n  rollout      ${ticketRollout}`);
  console.log(`  session id   ${ticketSession}`);

  // Hermes registers the deployment BEFORE the session opens (§5 rule 1). It
  // is written after the fact here only because the harness, not Hermes, is
  // the dispatcher in this run; the content is what Hermes would have logged.
  const paths = registryPaths(sandbox.repo);
  await appendFile(
    paths.sessionsFile,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      sessionId: ticketSession,
      agent: "codex",
      ticket: "36",
      dispatchPrompt: DISPATCH,
      workspace: ticketWorktree,
    })}\n`,
  );

  console.log("\n" + "-".repeat(78));
  console.log("2. a registry-LOGGED Hermes nudge into the live session");
  console.log("-".repeat(78));
  const NUDGE = "status check — how far along are you?";
  await appendFile(
    paths.sendsFile,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      sessionId: ticketSession,
      text: NUDGE,
      kind: "prompt",
    })}\n`,
  );
  const nudged = await codex(
    [
      "resume",
      ...CODEX_MODEL_ARGS,
      "-c",
      "sandbox_mode=workspace-write",
      "-c",
      "approval_policy=never",
      ticketSession,
      NUDGE,
    ],
    ticketWorktree,
    codexHome,
    env,
  );
  console.log(`  exit ${nudged.exitCode}  (logged to sends.jsonl BEFORE typing)`);
  if (nudged.exitCode !== 0) {
    console.log(nudged.stderr.split("\n").slice(0, 6).map((l) => `  err| ${l}`).join("\n"));
    throw new Error("the live Hermes nudge failed to reach the session");
  }

  console.log("\n" + "-".repeat(78));
  console.log("3. an UNLOGGED fake-Johan takeover typed into the same session");
  console.log("-".repeat(78));
  const TAKEOVER =
    "stop — ship the auth fix first, then come back. I prefer bun over npm here.";
  const takenOver = await codex(
    [
      "resume",
      ...CODEX_MODEL_ARGS,
      "-c",
      "sandbox_mode=workspace-write",
      "-c",
      "approval_policy=never",
      ticketSession,
      TAKEOVER,
    ],
    ticketWorktree,
    codexHome,
    env,
  );
  console.log(`  exit ${takenOver.exitCode}  (NOT logged — this is Johan typing)`);
  if (takenOver.exitCode !== 0) {
    console.log(takenOver.stderr.split("\n").slice(0, 6).map((l) => `  err| ${l}`).join("\n"));
    throw new Error("the live fake-Johan takeover failed to reach the session");
  }

  // ------------------------------------------------------- rogue session
  console.log("\n" + "-".repeat(78));
  console.log("4. a ROGUE unregistered Codex session that commits real work");
  console.log("-".repeat(78));
  const rogueWorktree = await sandbox.createWorktree("live-rogue");
  const rogue = await codex(
    [
      ...CODEX_MODEL_ARGS,
      "--cd",
      rogueWorktree,
      "--sandbox",
      "workspace-write",
      "Add a file RATE_LIMIT.md with one line describing a token bucket, then " +
        "git add it and git commit with the message 'feat: document the rate limiter'. Then stop.",
    ],
    rogueWorktree,
    codexHome,
    env,
  );
  console.log(`  exit ${rogue.exitCode}  (no sessions.jsonl row — unregistered)`);
  const rogueSession = sessionIdOf((await rollouts(codexHome)).at(-1)!);
  console.log(`  rogue session id ${rogueSession}`);

  // ----------------------------------------------------------- assertions
  console.log("\n" + "-".repeat(78));
  console.log("5. what Argus reads back from the transcripts the model wrote");
  console.log("-".repeat(78));

  const events = await new Tailer(createCodexSource({ codexHome })).catchUp();
  const messages = events.filter(
    (event): event is MessageEvent => event.type === "message",
  );
  const metas = events.filter(
    (event): event is SessionMetaEvent => event.type === "session-meta",
  );
  console.log(
    `  tailed ${events.length} events (${messages.length} messages, ${metas.length} session-metas) from ${
      (await rollouts(codexHome)).length
    } live rollouts\n`,
  );

  check(
    messages.some(
      (message) =>
        message.sessionId === ticketSession && message.text.includes("ticket #36"),
    ),
    "the live dispatch prompt is in the normalized stream",
  );
  check(
    messages.some(
      (message) =>
        message.sessionId === ticketSession && message.text === NUDGE,
    ),
    "the logged Hermes nudge is in the normalized stream",
  );
  check(
    messages.some(
      (message) =>
        message.sessionId === ticketSession && message.text === TAKEOVER,
    ),
    "the unlogged fake-Johan directive is in the normalized stream",
  );
  check(
    messages.some(
      (message) =>
        message.sessionId === ticketSession && message.role === "assistant",
    ),
    "the live model's own assistant turns are in the normalized stream",
  );
  for (const meta of metas) {
    console.log(
      `  session-meta ${meta.sessionId.slice(0, 8)} cwd=${meta.cwd} repo=${meta.repo}`,
    );
  }
  const realRepo = await realpath(sandbox.repo);
  const realTicketWorktree = await realpath(ticketWorktree);
  check(
    metas.some(
      (meta) =>
        meta.sessionId === ticketSession &&
        meta.cwd === realTicketWorktree &&
        meta.repo === realRepo,
    ),
    "the live session's worktree cwd maps to the parent sandbox repo (SPEC §7.3)",
  );

  const registry = await loadRegistry(paths);
  const { classifier } = classifierFromRegistry(registry);
  const records: ProvenanceRecord[] = [];
  const audits = [];
  for (const event of events) {
    const output = classifier.handle(event);
    if (output.record) records.push(output.record);
    audits.push(...output.audits);
  }
  const ticketRecords = records.filter(
    (record) => record.event.sessionId === ticketSession,
  );
  const johan = ticketRecords.filter((record) => record.author === "johan");

  console.log("");
  check(
    ticketRecords.some(
      (record) => record.via === "dispatch-prompt" && record.author === "hermes",
    ),
    "§13.4 — the live dispatch prompt classifies Hermes-authored",
  );
  check(
    ticketRecords.some(
      (record) =>
        record.via === "registry-send" &&
        record.author === "hermes" &&
        record.event.text === NUDGE,
    ),
    "§13.4 — the logged nudge classifies Hermes-authored (USER.md stays clean)",
  );
  for (const record of johan) {
    console.log(
      `  johan-authored: via=${record.via} text=${JSON.stringify(record.event.text.slice(0, 70))}`,
    );
  }
  check(
    johan.length === 1 &&
      johan[0]!.event.text === TAKEOVER &&
      johan[0]!.via === "takeover",
    "§13.2 — the unlogged directive is the ONLY Johan-authored message, via takeover",
  );
  check(
    johan[0]?.johanTouched === true &&
      classifier.sessionState(ticketSession)?.johanTouched === true,
    "§13.2 — johan_touched is set on the record and on the session",
  );
  check(
    audits.some((audit) => audit.type === "johan-attached"),
    "§13.5 — the attach surfaces as a loud johan-attached audit, never silence",
  );

  const scan = await scanGit({ repo: sandbox.repo });
  const attribution = attributeChanges(scan, {
    sessions: registry.sessions,
    sessionDirs: new Map(
      metas
        .filter((meta) => meta.cwd !== undefined)
        .map((meta) => [meta.sessionId, meta.cwd!] as const),
    ),
  });
  console.log("");
  console.log(
    `  git scan: ${scan.roots.length} roots, rogue=${attribution.rogue.length}, attributed=${attribution.attributed.length}`,
  );
  for (const rogueChange of attribution.rogue) {
    for (const commit of rogueChange.commits) {
      console.log(`    ROGUE ${commit.sha.slice(0, 8)} ${commit.subject}`);
    }
  }
  for (const covered of attribution.attributed) {
    console.log(
      `    COVERED by ticket #${covered.coverage.ticket}: ${covered.dir}`,
    );
  }
  check(
    attribution.rogue.some((change) =>
      change.commits.some((commit) =>
        commit.subject.includes("document the rate limiter"),
      ),
    ),
    "§13.3 — the live rogue commit is unattributable and becomes retro signal",
  );
  check(
    !attribution.rogue.some((change) => change.dir === ticketWorktree),
    "§13.3 — the registered ticket session's own worktree files no retro",
  );

  console.log("\n  the REAL Retro eye over the same live work:");
  for (const meta of metas) {
    if (meta.cwd !== undefined) {
      retro.observeSession({ sessionId: meta.sessionId, cwd: meta.cwd });
    }
  }
  await retro.ingest(records);
  const filings = await retro.scan();
  for (const filing of filings) {
    console.log(
      `    ${filing.outcome}  ${JSON.stringify(filing.title)}  parent=${filing.parent ?? "none"} rule=${filing.parentRule}${
        filing.reason ? ` reason=${filing.reason}` : ""
      }`,
    );
  }
  check(
    filings.length === 1,
    "§13.3 — the primed eye files exactly one retro (repo history is not accused)",
  );
  check(
    filings[0] !== undefined &&
      /rate.?limit|token bucket/i.test(filings[0].title),
    "§13.3 — the retro the LIVE brain wrote names the rogue work",
  );
  check(
    filings[0]?.outcome === "digest-note" && filings[0].reason !== undefined,
    "§13.3 — tracker-less sandbox degrades LOUDLY to a digest note, never silence",
  );
  check(
    (await retro.scan()).length === 0,
    "§13.3 — a second sweep re-files nothing",
  );

  console.log("\n" + "=".repeat(78));
  const failed = checks.filter(({ ok }) => !ok);
  console.log(
    `LIVE AGENT DRIVE: ${checks.length - failed.length}/${checks.length} checks passed`,
  );
  for (const { what } of failed) console.log(`  FAILED: ${what}`);
  console.log("=".repeat(78));
  process.exitCode = failed.length === 0 ? 0 : 1;
} finally {
  await sandbox.teardown();
}
