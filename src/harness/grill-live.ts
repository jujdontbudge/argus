/**
 * Ticket #89 — SPEC §14's FIRST acceptance bullet, driven live.
 *
 * The bullet, verbatim (SPEC.md:729-731):
 *
 *   "A grill session run through Hermes ends with: decisions in the digest,
 *   durable facts in MEMORY.md, Johan-authored preferences in USER.md, the
 *   exchange in Honcho and `archive.db` — with zero manual capture."
 *
 * It had never been run. All ten §13 scenarios are AFK scenarios; the grill
 * flow had unit tests and no harness scenario at all (`grep -rl grill
 * src/harness/` found nothing before this file). So the one flow SPEC §14
 * opens with was the one flow nothing end-to-end had ever exercised.
 *
 * FIVE STORES, NAMED, because "it's working" is only checkable if the list is
 * fixed in advance and each item has an address on disk or on the wire:
 *
 *   1. digest   `.argus/sessions/adhoc-<id>.md` + `.argus/sessions/INDEX.md`
 *   2. MEMORY   `.argus/memory/MEMORY.md` + the per-fact file beside it
 *   3. USER     `.argus/memory/USER.md`
 *   4. Honcho   the repo's workspace on the local instance
 *   5. archive  `.argus/archive.db`
 *
 * Four of the five must GAIN something. The fifth — USER.md — must not, and
 * that asymmetry is the honest part of this driver rather than a weakening of
 * it. See THE LIMIT below.
 *
 * WHAT IS REAL HERE. A real `claude` subscription session, started by
 * `startGrill` — the production entry point, not a copy — with the production
 * dispatch prompt, the production registry ordering (row fsynced before the
 * first keystroke) and the production `sendToWorker` for the answer. The five
 * real watcher processes run over it under the real `WatcherSupervisor`,
 * spawning real `argus watch` children whose eye brains are real `codex exec`
 * calls. Nothing about the five stores is written by this file.
 *
 * WHAT IS NOT, STATED HERE RATHER THAN DISCOVERED LATER. One substitution,
 * forced, and reported in the evidence file as a surviving double.
 *
 * `cmux` is NOT one of them any more. This driver was first written against a
 * `startGrill` that shelled `cmux new-workspace`, which Directive 14 forbids
 * the harness to do, and it carried a seam that rewrote that verb into
 * `new-surface`. #95 then made a deployed session a TAB in the workspace
 * Argus is already running in — so the substitution became the production
 * behaviour and was deleted rather than kept as a double that no longer
 * doubles anything. `CMUX_WORKSPACE_ID` is threaded into the sandbox env
 * because `createSandbox` strips every `CMUX_*` name, and `openWorkerTab`
 * reads that one to decide which workspace it may open a tab in.
 *
 * - **Johan is not here.** §7.2 step 3 is "Johan answers in the terminal
 *   directly", and a driver cannot be Johan. The answer is sent through
 *   `sendToWorker`, which registry-logs it, which classifies it
 *   `hermes`/`registry-send`.
 *
 * THE LIMIT, AND WHY IT IS NOT PAPERED OVER. Because the answer is
 * registry-logged by construction, it classifies Hermes-authored, and the
 * Reviewer's USER.md gate — "registry-verified JOHAN-AUTHORED findings only"
 * — must reject anything derived from it. So the assertion this driver writes
 * for store 3 is that `USER.md` stays **byte-identical**. The bullet's real
 * claim — that *Johan's* preferences reach USER.md from a grill — needs Johan
 * at the keyboard and is recorded as a cannot-simulate gap in
 * `docs/coverage/FEATURE-TEST-MATRIX.md` §5. Faking a Johan-authored message
 * to turn that assertion green would be forging the one provenance record the
 * whole §5 chain exists to protect; #78's driver threw rather than pretend,
 * and this one asserts the byte-identity instead.
 *
 * THE GATE IS ITS OWN, per #43's three-valued vocabulary and #74's reason for
 * not reusing someone else's opt-in. `ARGUS_LIVE_GRILL=1` buys one
 * subscription Claude session, five watcher processes and a handful of `codex
 * exec` brain calls; `ARGUS_LIVE_AGENTS=1` buys two one-sentence round trips.
 * Quietly upgrading the second into the first is how a gate stops being one.
 */
import { copyFile, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";

import { sendToWorker } from "../deploy";
import { createCmuxResolve, createCmuxSend, runCmux, type CmuxRun } from "../events";
import {
  configuredHonchoApiKey,
  honchoQuery,
  probeLiveHoncho,
} from "../eyes/honcho/live-probe.ts";
import { startGrill, verifyEveryGrillSkill, type GrillSkillVerification } from "../grill/index.ts";
import { loadRegistry, registryPaths } from "../provenance/index.ts";
import {
  EYE_NAMES,
  WatcherSupervisor,
  type SupervisorStatus,
} from "../supervisor/runtime.ts";
import {
  createSandbox,
  createSandboxWatcherSpawner,
  LIVE_WATCHER_FLEET_LOCK_PATH,
  type Sandbox,
} from "./index.ts";
import { CODEX_AUTH_FILE, type LiveHalfOutcome } from "./live-gate.ts";
import { NATIVE_CLAUDE } from "./subscription-gate.ts";

/** Its own opt-in. See the docblock: this one is expensive. */
export const LIVE_GRILL_GATE = "ARGUS_LIVE_GRILL";

/**
 * The token the scripted session is asked to emit, and the only thing this
 * driver ever searches a store for. Distinct from any word in the dispatch
 * prompt, so finding it proves an ASSISTANT turn was captured rather than the
 * harness' own text being read back out of the table it was written into.
 */
export const GRILL_SENTINEL = "ARGUS-89-GRILL-OK";

/** What the stand-in answer says. Registry-logged, therefore Hermes-authored. */
export const SCRIPTED_ANSWER =
  "launchd, because a long-lived parent process dies with the terminal that " +
  "started it. Record that as the decision and finish.";

/**
 * A bounded topic. The grill skill's natural shape is rounds of questions
 * until the user is satisfied, which never terminates without Johan; this
 * caps it at one round and names the token that ends it.
 */
export const SCRIPTED_TOPIC = [
  "A SCRIPTED verification run of the grill flow itself (Argus ticket #89) — not a",
  "real planning session. Keep it to ONE round.",
  "",
  "The decision: should the Argus watcher fleet be supervised by launchd, or by a",
  "long-lived parent process?",
  "",
  "Ask exactly one question about that decision and wait. You will receive one",
  `answer. Acknowledge it in one short paragraph that contains the token ${GRILL_SENTINEL},`,
  "state the decision that was reached, and then stop asking questions.",
].join("\n");

export interface StoreSnapshot {
  /** `.argus/sessions/*.md`, INDEX.md excluded — the digest bodies. */
  digestFiles: string[];
  indexText: string;
  /** `.argus/memory/MEMORY.md`, verbatim. */
  memoryIndex: string;
  /** The per-fact files beside it; MEMORY.md and USER.md are not facts. */
  memoryFactFiles: string[];
  /** SHA-256 of USER.md's bytes. The store that must NOT move. */
  userSha: string;
  userBytes: number;
  archiveTotal: number;
  archiveAssistant: number;
  /** peer_id → message count on the repo's Honcho workspace. */
  honchoByPeer: Record<string, number>;
  /** The digest bodies themselves — the evidence, not just the filenames. */
  digestBodies: Record<string, string>;
  /** Each per-fact file's contents, same reason. */
  factBodies: Record<string, string>;
}

export interface GrillLiveReport {
  gate: LiveHalfOutcome;
  /** Every mode's routed id, resolved against THIS machine. */
  skills: GrillSkillVerification[];
  /** The grilling mode's id and where it came from. */
  routedSkill: string;
  routedSource: string;
  /** Did the session's own transcript show the skill loaded BY NAME? */
  skillLoadedByName: boolean;
  skillLoadEvidence: string[];
  sessionId: string | null;
  workspace: string | null;
  surface: string | null;
  /** The tab's screen when the session failed to start. Evidence, not a log. */
  launchScreen: string | null;
  before: StoreSnapshot | null;
  after: StoreSnapshot | null;
  /** Peak RSS in KiB across this process plus every watcher, sampled. */
  peakFleetRssKib: number;
  rssSamples: Array<{ atSeconds: number; totalKib: number; watchers: number }>;
  honchoWorkspace: string | null;
  notes: string[];
  versions: Record<string, string>;
}

export interface GrillLiveOptions {
  checkout: string;
  /** The cmux workspace tabs are opened in. Defaults to `CMUX_WORKSPACE_ID`. */
  hostWorkspace?: string;
  /** How long to let the session and the eyes work, in milliseconds. */
  budgetMilliseconds?: number;
}

/** SHA-256 of a file's bytes, or of nothing when it does not exist. */
async function sha256(path: string): Promise<{ sha: string; bytes: number }> {
  try {
    const buffer = await Bun.file(path).arrayBuffer();
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(buffer);
    return { bytes: buffer.byteLength, sha: hasher.digest("hex") };
  } catch {
    return { bytes: -1, sha: "<absent>" };
  }
}

async function listFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory)).sort();
  } catch {
    return [];
  }
}

async function text(path: string): Promise<string> {
  try {
    return await Bun.file(path).text();
  } catch {
    return "";
  }
}

function archiveCounts(databasePath: string): { total: number; assistant: number } {
  try {
    const database = new Database(databasePath, { readonly: true });
    const total =
      database.query<{ n: number }, []>("SELECT count(*) AS n FROM archive_messages").get()
        ?.n ?? 0;
    const assistant =
      database
        .query<{ n: number }, []>(
          "SELECT count(*) AS n FROM archive_messages WHERE role = 'assistant'",
        )
        .get()?.n ?? 0;
    database.close();
    return { assistant, total };
  } catch {
    return { assistant: -1, total: -1 };
  }
}

async function honchoPeerCounts(
  apiKey: string | null,
  workspace: string | null,
): Promise<Record<string, number>> {
  if (apiKey === null || workspace === null) return {};
  const counts: Record<string, number> = {};
  try {
    const sessions = await honchoQuery<{ items: Array<{ id: string }> }>(
      apiKey,
      `/v3/workspaces/${encodeURIComponent(workspace)}/sessions/list`,
      {},
    );
    for (const session of sessions.items) {
      const listed = await honchoQuery<{ items: Array<{ peer_id: string }> }>(
        apiKey,
        `/v3/workspaces/${encodeURIComponent(workspace)}/sessions/${encodeURIComponent(session.id)}/messages/list`,
        {},
      );
      for (const message of listed.items) {
        counts[message.peer_id] = (counts[message.peer_id] ?? 0) + 1;
      }
    }
  } catch {
    // A store that cannot be read is reported as unread, never as empty.
    return { "<unreadable>": -1 };
  }
  return counts;
}

/** The Honcho workspace `argus up` bound this repo to. */
async function boundHonchoWorkspace(repo: string): Promise<string | null> {
  const binding = await text(join(repo, ".argus", "honcho.yaml"));
  const match = /^workspace:\s*([^#\n]+?)\s*$/m.exec(binding);
  return match === null ? null : match[1]!;
}

export async function snapshotStores(
  repo: string,
  honchoApiKey: string | null,
  honchoWorkspace: string | null,
): Promise<StoreSnapshot> {
  const sessionsDirectory = join(repo, ".argus", "sessions");
  const memoryDirectory = join(repo, ".argus", "memory");
  const user = await sha256(join(memoryDirectory, "USER.md"));
  const memoryFiles = await listFiles(memoryDirectory);
  const archive = archiveCounts(join(repo, ".argus", "archive.db"));
  const digestNames = (await listFiles(sessionsDirectory)).filter(
    (name) => name.endsWith(".md") && name !== "INDEX.md",
  );
  const factNames = memoryFiles.filter(
    (name) => name.endsWith(".md") && name !== "MEMORY.md" && name !== "USER.md",
  );
  const digestBodies: Record<string, string> = {};
  for (const name of digestNames) {
    digestBodies[name] = await text(join(sessionsDirectory, name));
  }
  const factBodies: Record<string, string> = {};
  for (const name of factNames) {
    factBodies[name] = await text(join(memoryDirectory, name));
  }
  return {
    digestBodies,
    factBodies,
    archiveAssistant: archive.assistant,
    archiveTotal: archive.total,
    digestFiles: digestNames,
    honchoByPeer: await honchoPeerCounts(honchoApiKey, honchoWorkspace),
    indexText: await text(join(sessionsDirectory, "INDEX.md")),
    memoryFactFiles: factNames,
    memoryIndex: await text(join(memoryDirectory, "MEMORY.md")),
    userBytes: user.bytes,
    userSha: user.sha,
  };
}

async function rssKib(pid: number): Promise<number> {
  const child = Bun.spawn(["ps", "-o", "rss=", "-p", String(pid)], {
    stderr: "ignore",
    stdout: "pipe",
  });
  const out = (await new Response(child.stdout).text()).trim();
  await child.exited;
  const value = Number.parseInt(out, 10);
  return Number.isNaN(value) ? 0 : value;
}

async function version(argv: readonly string[]): Promise<string> {
  try {
    const child = Bun.spawn([...argv], { stderr: "pipe", stdout: "pipe" });
    const [out, err] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    await child.exited;
    return (out.trim() || err.trim()).split("\n")[0] ?? "";
  } catch {
    return "<not runnable>";
  }
}

/**
 * Does the session's own transcript show the routed skill loaded BY NAME?
 *
 * The assertion is deliberately about the TRANSCRIPT and not about the
 * resolver: `installed.ts` proves the id exists on this machine, and this
 * proves `claude` actually reached it on this run. A `Skill` tool call naming
 * the id, or the skill's own body arriving as tool output, are the two shapes
 * that count. The dispatch prompt also contains the id — it says "Use the
 * <id> skill" — so a bare substring search over the whole file would match
 * the harness' own words, and the `user`-role dispatch record is skipped for
 * exactly that reason.
 */
export async function skillLoadedInTranscript(
  transcript: string,
  skillId: string,
): Promise<{ loaded: boolean; evidence: string[] }> {
  const evidence: string[] = [];
  let content: string;
  try {
    content = await Bun.file(transcript).text();
  } catch {
    return { evidence: ["transcript not readable"], loaded: false };
  }
  for (const line of content.split("\n")) {
    if (line.trim() === "") continue;
    let record: { type?: string; message?: { role?: string; content?: unknown } };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue;
    }
    // The harness authored the dispatch, so its copy of the id proves nothing.
    if (record.message?.role === "user" && record.type === "user") {
      const raw = JSON.stringify(record.message.content ?? "");
      if (!raw.includes("tool_result")) continue;
    }
    const serialized = JSON.stringify(record);
    if (!serialized.includes(skillId)) continue;
    const isToolUse = /"name"\s*:\s*"Skill"/.test(serialized);
    const isToolResult = serialized.includes("tool_result");
    if (isToolUse || isToolResult) {
      evidence.push(`${record.type ?? "?"}: ${serialized.slice(0, 220)}`);
    }
  }
  return { evidence, loaded: evidence.length > 0 };
}

export async function runGrillLive(
  options: GrillLiveOptions,
): Promise<GrillLiveReport> {
  const notes: string[] = [];
  const rssSamples: GrillLiveReport["rssSamples"] = [];
  const budget = options.budgetMilliseconds ?? 15 * 60 * 1000;
  const hostWorkspace = options.hostWorkspace ?? Bun.env.CMUX_WORKSPACE_ID ?? "";

  const report: GrillLiveReport = {
    after: null,
    before: null,
    gate: { reason: "", status: "run" },
    honchoWorkspace: null,
    notes,
    peakFleetRssKib: 0,
    routedSkill: "",
    routedSource: "",
    rssSamples,
    launchScreen: null,
    sessionId: null,
    surface: null,
    skillLoadEvidence: [],
    skillLoadedByName: false,
    skills: [],
    versions: {},
    workspace: null,
  };

  if (hostWorkspace === "") {
    report.gate = {
      reason: "CMUX_WORKSPACE_ID is unset — no host workspace to open a tab in",
      status: "not-run",
    };
    return report;
  }
  if (!(await Bun.file(NATIVE_CLAUDE).exists())) {
    report.gate = {
      reason: `the native claude CLI is not at ${NATIVE_CLAUDE}`,
      status: "not-run",
    };
    return report;
  }

  report.versions = {
    bun: Bun.version,
    claude: await version([NATIVE_CLAUDE, "--version"]),
    cmux: await version(["cmux", "--version"]),
    codex: await version(["codex", "--version"]),
  };

  const honchoProbe = await probeLiveHoncho();
  if (honchoProbe.live === null) {
    notes.push(`Honcho: ${honchoProbe.reason ?? "unavailable"}`);
  }
  const honchoApiKey = await configuredHonchoApiKey();

  const cmux = runCmux;
  let sandbox: Sandbox | null = null;
  let supervisor: WatcherSupervisor | null = null;
  let tabRef: string | null = null;

  try {
    sandbox = await createSandbox({ checkout: options.checkout });
    const repo = await realpath(sandbox.repo);
    notes.push(`sandbox ${sandbox.root}`);
    notes.push(`argus up exit ${sandbox.up.exitCode}`);

    // The two credentials a sandbox needs and cannot invent. Both are LOCAL
    // or subscription-backed: SPEC §1 items 7 and 8 forbid metered API access
    // and neither of these is that. The Claude credential is deliberately
    // absent from this list — subscription mode reaches it through the real
    // HOME and nothing is ever copied (#49).
    if (await Bun.file(CODEX_AUTH_FILE).exists()) {
      await mkdir(sandbox.env.CODEX_HOME!, { recursive: true });
      await copyFile(CODEX_AUTH_FILE, join(sandbox.env.CODEX_HOME!, "auth.json"));
      notes.push("codex auth.json copied into the scratch CODEX_HOME");
    } else {
      notes.push("no ~/.codex/auth.json — the eye brains will not be able to run");
    }
    const honchoConfig = join(homedir(), ".honcho/config.json");
    if (await Bun.file(honchoConfig).exists()) {
      await mkdir(join(sandbox.home, ".honcho"), { recursive: true });
      await copyFile(honchoConfig, join(sandbox.home, ".honcho/config.json"));
      notes.push("local Honcho config copied into the scratch HOME");
      // `argus up` already ran without it, so the binding has to converge again.
      const again = Bun.spawn(
        [process.execPath, join(options.checkout, "src/cli.ts"), "up"],
        { cwd: repo, env: sandbox.env, stderr: "pipe", stdout: "pipe" },
      );
      notes.push(`argus up (re-converge, with Honcho) exit ${await again.exited}`);
    }

    report.honchoWorkspace = await boundHonchoWorkspace(repo);
    report.skills = await verifyEveryGrillSkill(repo);
    const grilling = report.skills.find(({ mode }) => mode === "grilling")!;
    report.routedSkill = grilling.id;
    report.routedSource =
      grilling.resolution.status === "resolved" ? grilling.resolution.source : "missing";

    report.before = await snapshotStores(repo, honchoApiKey, report.honchoWorkspace);

    // ---- the production grill path -------------------------------------
    const started = await startGrill(
      {
        executable: NATIVE_CLAUDE,
        mode: "grilling",
        model: "claude-opus-5",
        repo,
        topic: SCRIPTED_TOPIC,
      },
      // `createSandbox` strips every CMUX_* name; `openWorkerTab` needs this
      // one to know which workspace it is allowed to open a tab in, and
      // refuses outright without it (R6: Argus never creates a workspace).
      { env: { ...sandbox.env, CMUX_WORKSPACE_ID: hostWorkspace } },
    );
    if (started.status !== "started") {
      report.gate = {
        reason: `startGrill ${started.status}: ${started.reason}`,
        status: "not-run",
      };
      return report;
    }
    report.sessionId = started.sessionId;
    report.workspace = started.workspace;
    // `GrillResult` does not carry the surface, but the registry row does —
    // `deployWorker` wrote it as `surfaceRef`, and it is the handle every
    // later send resolves against, so it is the right one to clean up too.
    const registered = await loadRegistry(registryPaths(repo));
    report.surface =
      registered.sessions.findLast(({ sessionId }) => sessionId === started.sessionId)
        ?.surface ?? null;
    tabRef = report.surface;
    notes.push(`grill session ${started.sessionId} in cmux tab ${report.surface} of ${started.workspace}`);
    if (started.degraded.length > 0) notes.push(...started.degraded.map((d) => `degraded: ${d}`));

    // ---- the five real watchers ----------------------------------------
    const statusPath = join(sandbox.root, "state", "grill-live-status.json");
    supervisor = new WatcherSupervisor({
      fleetLockPath: LIVE_WATCHER_FLEET_LOCK_PATH,
      registryPath: sandbox.env.ARGUS_REPOS_FILE!,
      restartDelayMilliseconds: 50,
      spawn: createSandboxWatcherSpawner(
        [process.execPath, fileURLToPath(new URL("../cli.ts", import.meta.url))],
        // Everything scratch EXCEPT where Claude transcripts live. #49's
        // subscription mode runs the session under the real HOME by
        // necessity — that is where the credential is — so its transcript
        // lands in the real `~/.claude/projects`, while the sandbox points
        // CLAUDE_CONFIG_DIR at an empty scratch directory. A watcher reading
        // the scratch one finds nothing and reports an empty archive, which
        // reads exactly like an eye that failed. The read is repo-scoped
        // (`sessionsForRepo`), so only the sandbox session's transcript is
        // consumed, and nothing is ever written there.
        {
          env: { ...sandbox.env, CLAUDE_CONFIG_DIR: join(homedir(), ".claude") },
        },
      ),
      statusPath,
    });
    await supervisor.reconcile();

    const startedAt = Date.now();
    const scope = sandbox.scope;
    /** Read, adopt and measure in one step: no pid is known before it is scoped. */
    const sampleFleet = async (): Promise<number> => {
      let status: SupervisorStatus | null = null;
      try {
        status = (await Bun.file(statusPath).json()) as SupervisorStatus;
      } catch {
        status = null;
      }
      let total = await rssKib(process.pid);
      let watchers = 0;
      for (const watcher of status?.watchers ?? []) {
        if (watcher.repo !== repo) continue;
        scope.adopt(watcher.pid);
        watchers += 1;
        total += await rssKib(watcher.pid);
      }
      rssSamples.push({
        atSeconds: Math.round((Date.now() - startedAt) / 1000),
        totalKib: total,
        watchers,
      });
      report.peakFleetRssKib = Math.max(report.peakFleetRssKib, total);
      return watchers;
    };

    for (let attempt = 0; attempt < 120; attempt += 1) {
      await Bun.sleep(250);
      if ((await sampleFleet()) >= EYE_NAMES.length) break;
    }
    notes.push(`watcher fleet: ${rssSamples.at(-1)?.watchers ?? 0}/${EYE_NAMES.length} up`);

    // ---- did the session actually START? -------------------------------
    //
    // The transcript file is the only honest answer. `startGrill` returning
    // `started` means the launch line was DELIVERED, which is a claim about
    // cmux and not about `claude`: `cmux send` exits 0 whatever the shell
    // then does with the keystrokes. A driver that took `started` at its word
    // would go on to grade five empty stores as an eye problem.
    let transcriptPath: string | null = null;
    let trusted = false;
    for (let attempt = 0; attempt < 90; attempt += 1) {
      await Bun.sleep(2000);
      await sampleFleet();
      transcriptPath = await findTranscript(repo, started.sessionId);
      if (transcriptPath !== null) break;
      if (report.surface === null) continue;
      const screen = await cmux([
        "read-screen",
        "--surface",
        report.surface,
        "--lines",
        "40",
      ]);
      // Claude Code's first-run trust dialog. A grill into a repo `claude` has
      // never seen stops here, and NOTHING in the flow notices: the launch
      // line ran, `startGrill` returned `started`, and the session is sitting
      // on a modal with no transcript. Answering it is what Johan would do on
      // attaching, and it is not a §5 rule 2 send — a menu selection lands in
      // a TUI, not in a transcript, so there is nothing for it to be
      // misattributed as. Recorded as a finding either way.
      if (!trusted && /trust this folder/i.test(screen.stdout)) {
        notes.push("FINDING: the session blocked on Claude Code's trust-folder dialog");
        await cmux(["send-key", "--surface", report.surface, "--", "enter"]);
        trusted = true;
      }
    }
    if (transcriptPath === null) {
      notes.push(
        "NO TRANSCRIPT after 120s — the launch line was delivered and the session " +
          "never started; see the screen capture below",
      );
      if (report.surface !== null) {
        const screen = await cmux([
          "read-screen",
          "--surface",
          report.surface,
          "--lines",
          "40",
        ]);
        report.launchScreen = screen.stdout;
      }
    } else {
      notes.push(`transcript appeared: ${transcriptPath}`);
    }

    // ---- the stand-in answer, through the registry-logged send ---------
    if (transcriptPath !== null) {
      const askedBy = Date.now();
      let answered = false;
      while (Date.now() - askedBy < 3 * 60 * 1000) {
        await Bun.sleep(5000);
        await sampleFleet();
        if (!(await hasAssistantTurn(transcriptPath))) continue;
        const sent = await sendToWorker(
          { repo, sessionId: started.sessionId, text: SCRIPTED_ANSWER },
          { resolve: createCmuxResolve(cmux), send: createCmuxSend(cmux) },
        );
        notes.push(`stand-in answer: ${sent.status}`);
        answered = sent.status === "sent";
        break;
      }
      if (!answered) notes.push("the session produced no assistant turn to answer");
    }

    // ---- let the eyes work ---------------------------------------------
    while (Date.now() - startedAt < budget) {
      await Bun.sleep(10_000);
      await sampleFleet();
      const snapshot = await snapshotStores(repo, honchoApiKey, report.honchoWorkspace);
      const digested = snapshot.digestFiles.length > report.before.digestFiles.length;
      const remembered =
        snapshot.memoryFactFiles.length > report.before.memoryFactFiles.length;
      const archived = snapshot.archiveAssistant > report.before.archiveAssistant;
      if (digested && remembered && archived) break;
    }

    report.after = await snapshotStores(repo, honchoApiKey, report.honchoWorkspace);

    if (transcriptPath !== null) {
      const loaded = await skillLoadedInTranscript(transcriptPath, report.routedSkill);
      report.skillLoadedByName = loaded.loaded;
      report.skillLoadEvidence = loaded.evidence;
    }

    const registry = await loadRegistry(registryPaths(repo));
    notes.push(
      `registry: ${registry.sessions.length} session row(s), ${registry.sends.length} send row(s)`,
    );
    return report;
  } finally {
    // Every watcher this driver started, stopped, before anything else — the
    // fleet is the expensive residue and #86 is why it is first.
    if (supervisor !== null) {
      try {
        await supervisor.stop();
      } catch (error) {
        notes.push(`supervisor.stop failed: ${String(error)}`);
      }
    }
    if (tabRef !== null) {
      // Production's own closer, which refuses an unresolved handle rather
      // than closing Johan's focused tab — half of Directive 14.
      try {
        const { closeWorkerTab } = await import("../deploy/tab.ts");
        const closed = await closeWorkerTab(
          { surface: tabRef, workspace: hostWorkspace },
          runCmux,
        );
        notes.push(`grill tab ${tabRef}: ${JSON.stringify(closed)}`);
      } catch (error) {
        notes.push(`could not close the grill tab ${tabRef}: ${String(error)}`);
      }
    }
    if (report.honchoWorkspace !== null && honchoApiKey !== null) {
      try {
        const { removeScratchWorkspace } = await import("../eyes/honcho/live-probe.ts");
        await removeScratchWorkspace(honchoApiKey, report.honchoWorkspace);
        notes.push(`Honcho scratch workspace ${report.honchoWorkspace} removed`);
      } catch (error) {
        notes.push(`Honcho cleanup failed: ${String(error)}`);
      }
    }
    if (sandbox !== null) {
      try {
        await sandbox.teardown();
      } catch (error) {
        notes.push(`sandbox teardown failed: ${String(error)}`);
      }
    }
  }
}

/** Has `claude` written an assistant turn yet? The end-of-turn signal. */
async function hasAssistantTurn(transcript: string): Promise<boolean> {
  try {
    const content = await Bun.file(transcript).text();
    return content
      .split("\n")
      .some((line) => line.includes('"role":"assistant"') || line.includes('"role": "assistant"'));
  } catch {
    return false;
  }
}

/** `~/.claude/projects/<slug>/<sessionId>.jsonl`, found by id not by slug. */
async function findTranscript(repo: string, sessionId: string): Promise<string | null> {
  const root = join(homedir(), ".claude", "projects");
  const { claudeProjectDir } = await import("../tailing/claude-code.ts");
  const candidate = join(claudeProjectDir(repo, root), `${sessionId}.jsonl`);
  if (await Bun.file(candidate).exists()) return candidate;
  // The slug is derived from the path, and a realpath'd sandbox can differ
  // from the path `claude` saw. Fall back to a scan for the id itself.
  for (const project of await listFiles(root)) {
    const path = join(root, project, `${sessionId}.jsonl`);
    if (await Bun.file(path).exists()) return path;
  }
  return null;
}

export async function removeIfEmpty(path: string): Promise<void> {
  await rm(path, { force: true, recursive: true });
}
