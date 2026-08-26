/**
 * Ticket #90 — the cmux door, driven against the REAL binary.
 *
 * `cmux` is a manifest `Double` in every §13 slot that names it. Production
 * reaches it through one seam (`src/events/notify.ts`) and two callers
 * (`src/deploy/tab.ts`, `src/events/consumer.ts`), and until this module every
 * one of those paths had only ever run against `FakeCmux`
 * (`src/events/scenarios.ts`). Against a fake, #7's assertion is circular: the
 * fake answers whatever the test wants. The hazard is a property of a real
 * cmux, so only a real cmux can prove the defence.
 *
 * WHAT #7 SAID, AND WHAT THIS TICKET MEASURED INSTEAD. #7 recorded that "an
 * unresolvable `--workspace` / `--surface`" is treated as the FOCUSED one and
 * exits 0. Driven here, that is true of ONE handle form and false of the
 * other, and the difference is the whole ticket:
 *
 *   cmux list-pane-surfaces --workspace workspace:9999      -> exit 0, answers
 *                                                              for the FOCUSED
 *                                                              workspace
 *   cmux list-pane-surfaces --workspace 00000000-0000-...   -> exit 1,
 *                                                              "not_found:
 *                                                              Pane or
 *                                                              workspace not
 *                                                              found"
 *
 * An unresolvable SHORT REF fails OPEN. An unresolvable UUID fails CLOSED.
 * Measured the same way on `read-screen`, `list-panes`, `surface-health` and
 * `close-surface` — see `docs/acceptance/cmux-door.txt` for the matrix. That
 * is why `resolveHandleForm` below exists and why the recommendation this
 * ticket carries is UUID-only for destructive verbs: it is not a stylistic
 * preference over resolve-then-act, it is the difference between a verb that
 * errors and a verb that acts on Johan's focused tab.
 *
 * THE TICKET'S PREMISE THAT HAS MOVED. #90 was written against
 * `createCmuxWorkspace` and asks this driver to call it. #95 deleted that
 * function: R6 forbids Argus to create a workspace at all, and the production
 * entry point is now `openWorkerTab`, which opens a TAB in the workspace Argus
 * already runs in. This driver drives what production actually has. It creates
 * ZERO workspaces, and every surface it closes is one it opened itself.
 */
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { closeWorkerTab, openWorkerTab } from "../deploy/tab.ts";
import { applyDigestUpdate, updateIndex } from "../eyes/digest/outputs.ts";
import {
  EVENT_SCHEMA_VERSION,
  notifyMissionControl,
  pollHermesSignals,
  readCmuxInventory,
  runCmux,
  sendWithCmux,
  type CmuxRun,
  type CmuxSend,
  type CmuxInventory,
} from "../events";
import type { ArgusEvent } from "../events/schema.ts";
import { appendSessionRow, loadRegistry, registryPaths } from "../provenance";

/** Opt in with `ARGUS_LIVE_CMUX=1`. Its own gate: no other opt-in opens it. */
export const LIVE_CMUX_GATE = "ARGUS_LIVE_CMUX";

/** A ref that no cmux has ever allocated, and a UUID that names nothing. */
export const BOGUS_WORKSPACE_REF = "workspace:99999";
export const BOGUS_UUID = "00000000-0000-0000-0000-000000000000";

export interface CmuxDoorCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface CmuxDoorReport {
  status: "gate-unset" | "no-cmux" | "ran";
  /** `cmux --version`, recorded because #7's behaviour is version-specific. */
  version: string;
  /** The workspace the tab was opened in, and the surface UUID discovered. */
  workspace?: string;
  surface?: string;
  treeBefore: string;
  treeAfter: string;
  checks: CmuxDoorCheck[];
}

const check = (name: string, ok: boolean, detail: string): CmuxDoorCheck => ({
  detail,
  name,
  ok,
});

/**
 * Which way does this handle form fail when it resolves to nothing? The one
 * measurement this whole ticket turns on, so it is production code rather than
 * a number copied into a document that cannot notice a cmux upgrade.
 *
 * `open` means cmux exited 0 and answered for something it was not asked
 * about. `closed` means cmux refused. A future cmux that fixes #7 flips the
 * ref row to `closed`, and the test that asserts this will say so.
 */
export async function resolveHandleForm(
  handle: string,
  run: CmuxRun = runCmux,
): Promise<{ exitCode: number; fails: "closed" | "open"; stderr: string }> {
  const result = await run(["list-pane-surfaces", "--workspace", handle]);
  return {
    exitCode: result.exitCode,
    fails: result.exitCode === 0 ? "open" : "closed",
    stderr: result.stderr.trim(),
  };
}

/** Every surface UUID in the inventory, with the workspace holding it. */
function surfaceOwners(inventory: CmuxInventory): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const workspace of inventory.workspaces) {
    for (const surface of workspace.surfaces) {
      owners.set(surface.id, [...(owners.get(surface.id) ?? []), workspace.id]);
    }
  }
  return owners;
}

async function scratchRepo(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `argus-cmux-door-${prefix}-`));
  await mkdir(join(root, ".argus", "registry"), { recursive: true });
  await mkdir(join(root, ".argus", "events"), { recursive: true });
  return root;
}

/**
 * Register a Hermes mission session pointing at `workspace`/`surface`, and
 * give it a terminal digest so §6's slow poll has something to sweep. This is
 * the registry shape `notifyMissionControl` and `pollHermesSignals` both read;
 * nothing below writes what production would write.
 */
async function registerMission(
  repo: string,
  sessionId: string,
  workspace: string,
  surface?: string,
): Promise<void> {
  await appendSessionRow(registryPaths(repo).sessionsFile, {
    agent: "hermes",
    dispatchPrompt: "#90 live cmux door drive",
    sessionId,
    ts: new Date().toISOString(),
    workspace,
    ...(surface !== undefined && { surface }),
  });
  const sessions = join(repo, ".argus", "sessions");
  const fileName = `90-${sessionId}.md`;
  await applyDigestUpdate(
    sessions,
    fileName,
    { agent: "hermes", startedBy: "hermes", ticket: "90" },
    { status: "done" },
  );
  await updateIndex(sessions, {
    agent: "hermes",
    file: fileName,
    johanTouched: false,
    startedBy: "hermes",
    status: "done",
    summary: "#90 live cmux door",
    ticket: "90",
  });
}

function missionEvent(repo: string, sessionId: string, id: string): ArgusEvent {
  return {
    agent: "claude-code",
    createdAt: new Date().toISOString(),
    id,
    kind: "end-of-session",
    message: "#90 live cmux door drive finished.",
    repo,
    schemaVersion: EVENT_SCHEMA_VERSION,
    sessionId,
  };
}

/**
 * The ordering assertion, made unfakeable. §5 rule 2 says the send is logged
 * BEFORE it is typed; a driver that checks `sends.jsonl` afterwards cannot
 * tell the two orders apart. So the check runs INSIDE the send: cmux stays
 * real, and the row either is already on disk at the moment cmux is called or
 * it is not.
 */
function orderingSend(repo: string, record: (ok: boolean, note: string) => void): CmuxSend {
  return async (request) => {
    const rows = (await loadRegistry(registryPaths(repo))).sends;
    const logged = rows.some((row) => row.text === request.text);
    record(
      logged,
      logged
        ? `sends.jsonl already held the row when cmux was called (${rows.length} row(s))`
        : "cmux was called with NO sends.jsonl row on disk — §5 rule 2 violated",
    );
    return sendWithCmux(request);
  };
}

export interface CmuxDoorOptions {
  env?: Readonly<Record<string, string | undefined>>;
  /** Seconds to let the shell echo the typed line before reading it back. */
  settleMs?: number;
}

/**
 * Drive the whole door: open a tab, send through `notify.ts`, read it back
 * through `consumer.ts`, point a send at a handle that resolves to nothing,
 * and close the tab. Every close is bracketed by a tree snapshot.
 */
export async function driveCmuxDoor(
  options: CmuxDoorOptions = {},
): Promise<CmuxDoorReport> {
  const env = options.env ?? Bun.env;
  const checks: CmuxDoorCheck[] = [];
  const empty = { checks, status: "gate-unset" as const, treeAfter: "", treeBefore: "", version: "" };
  if (env[LIVE_CMUX_GATE] !== "1") return empty;

  const versionRun = await runCmux(["--version"]).catch(() => null);
  if (versionRun === null || versionRun.exitCode !== 0) {
    return { ...empty, status: "no-cmux" };
  }
  const version = versionRun.stdout.trim();

  const target = env["CMUX_WORKSPACE_ID"];
  const treeBefore = (await runCmux(["--id-format", "both", "tree", "--all"])).stdout;
  const report = (status: CmuxDoorReport["status"], treeAfter: string): CmuxDoorReport => ({
    checks,
    status,
    treeAfter,
    treeBefore,
    version,
  });
  if (target === undefined || target === "") {
    checks.push(check("running inside cmux", false, "no CMUX_WORKSPACE_ID"));
    return report("no-cmux", treeBefore);
  }

  // ---- the handle-form matrix, the measurement the ticket turns on --------
  const refForm = await resolveHandleForm(BOGUS_WORKSPACE_REF);
  const uuidForm = await resolveHandleForm(BOGUS_UUID);
  checks.push(
    check(
      "unresolvable SHORT REF fails open (#7's hazard, still present)",
      refForm.fails === "open",
      `${BOGUS_WORKSPACE_REF} -> exit ${refForm.exitCode}` +
        (refForm.fails === "open"
          ? " and answered for a workspace it was not asked about"
          : ` and refused: ${refForm.stderr} — cmux ${version} has FIXED #7 for refs`),
    ),
    check(
      "unresolvable UUID fails closed (why destructive verbs take UUIDs only)",
      uuidForm.fails === "closed",
      `${BOGUS_UUID} -> exit ${uuidForm.exitCode} ${uuidForm.stderr}`,
    ),
  );

  // ---- step 1: open the tab through production ---------------------------
  const opened = await openWorkerTab({ title: "argus90-live", workspace: target });
  if (opened.status !== "opened") {
    checks.push(check("openWorkerTab", false, opened.reason));
    return report("ran", treeBefore);
  }
  checks.push(check("openWorkerTab", true, `surface ${opened.surface} in ${opened.workspace}`));

  // Assertion 1: the discovered handle names the tab that was created, and no
  // other. `openWorkerTab` returns a UUID, so "no other" is checkable across
  // the WHOLE machine rather than within the workspace it was asked about.
  const afterOpen = await readCmuxInventory();
  const owners = afterOpen === null ? new Map() : surfaceOwners(afterOpen);
  const holders = owners.get(opened.surface) ?? [];
  checks.push(
    check(
      "the discovered ref names the tab that was created, and no other",
      holders.length === 1 && holders[0] === opened.workspace,
      `surface ${opened.surface} resolves in ${holders.length} workspace(s): ${
        holders.join(", ") || "none"
      }`,
    ),
  );

  const repo = await scratchRepo("live");
  const bogusRepo = await scratchRepo("bogus");
  let treeAfter = treeBefore;
  try {
    // ---- step 2: a registry-logged send through notify.ts ---------------
    const sessionId = `cmux-door-${process.pid}`;
    await registerMission(repo, sessionId, opened.workspace, opened.surface);
    let ordering: CmuxDoorCheck | null = null;
    const sent = await notifyMissionControl(
      repo,
      missionEvent(repo, sessionId, "live-90"),
      {
        onError: () => {},
        send: orderingSend(repo, (ok, note) => {
          ordering = check("the registry row was written BEFORE the send", ok, note);
        }),
      },
    );
    checks.push(
      check(
        "notifyMissionControl reached the tab",
        sent.status === "sent",
        sent.status === "sent" ? "cmux send + send-key enter exited 0" : sent.reason,
      ),
    );
    if (ordering !== null) checks.push(ordering);

    // ---- step 3: read it back through consumer.ts ------------------------
    await Bun.sleep(options.settleMs ?? 1_500);
    const signals = await pollHermesSignals(repo, {
      cmux: runCmux,
      resolveRepo: async () => repo,
    });
    const screenText = signals.map((signal) => signal.prompt).join("\n");
    checks.push(
      check(
        "the line sent in step 2 appears in step 3's read-screen output",
        screenText.includes(sessionId),
        signals.length === 0
          ? "pollHermesSignals returned no signal at all"
          : `${signals.length} signal(s); worker screen ${
              screenText.includes("Worker screen") ? "was attached" : "was NOT attached"
            }`,
      ),
    );

    // ---- step 4: the send that must degrade ------------------------------
    // A stale mission handle, in the form that fails OPEN. This is the only
    // assertion here that can actually fail; the rest is its scaffolding.
    const bogusSession = `cmux-door-bogus-${process.pid}`;
    await registerMission(bogusRepo, bogusSession, BOGUS_WORKSPACE_REF);
    const degraded = await notifyMissionControl(
      bogusRepo,
      missionEvent(bogusRepo, bogusSession, "bogus-90"),
      { onError: () => {} },
    );
    checks.push(
      check(
        "a send to a bogus workspace handle DEGRADES and reports failure",
        degraded.status === "degraded",
        degraded.status === "degraded"
          ? degraded.reason
          : "notifyMissionControl reported SUCCESS for an unresolvable handle",
      ),
    );

    // ...and it must not have typed into anything else. The tab from step 1
    // is the witness: if the guard had let the send through, cmux would have
    // put the line on the FOCUSED surface, and step 1's tab is the only
    // surface this driver is entitled to read.
    await Bun.sleep(options.settleMs ?? 1_500);
    const witness = await runCmux(["read-screen", "--surface", opened.surface]);
    checks.push(
      check(
        "the bogus line did not land on the tab from step 1",
        witness.exitCode === 0 && !witness.stdout.includes(bogusSession),
        witness.exitCode === 0
          ? `read-screen exit 0; ${bogusSession} ${
              witness.stdout.includes(bogusSession) ? "IS PRESENT — leaked" : "absent"
            }`
          : `read-screen exited ${witness.exitCode}`,
      ),
    );
  } finally {
    // ---- step 5: teardown, bracketed -------------------------------------
    const closed = await closeWorkerTab({
      surface: opened.surface,
      workspace: opened.workspace,
    });
    treeAfter = (await runCmux(["--id-format", "both", "tree", "--all"])).stdout;
    checks.push(
      check(
        "closeWorkerTab removed the tab it opened",
        closed.status === "closed",
        closed.status === "closed" ? `closed ${opened.surface}` : closed.reason,
      ),
      check(
        "the tab is gone from the whole-machine tree",
        !treeAfter.includes(opened.surface),
        `${opened.surface} ${treeAfter.includes(opened.surface) ? "still present" : "absent"}`,
      ),
    );
    await rm(repo, { force: true, recursive: true });
    await rm(bogusRepo, { force: true, recursive: true });
  }

  return {
    ...report("ran", treeAfter),
    surface: opened.surface,
    workspace: opened.workspace,
  };
}

/** The whole-machine census Directive 14 asks for, as a pair of counts. */
export function censusOf(tree: string): { surfaces: number; workspaces: number } {
  const count = (needle: string): number =>
    tree.split("\n").filter((line) => line.includes(`${needle} `)).length;
  return { surfaces: count("surface"), workspaces: count("workspace") };
}

/** True when the drive left the machine exactly as it found it. */
export function censusUnchanged(report: CmuxDoorReport): boolean {
  const before = censusOf(report.treeBefore);
  const after = censusOf(report.treeAfter);
  return before.surfaces === after.surfaces && before.workspaces === after.workspaces;
}
