/**
 * SPEC §13 scenario 3 for the Retro eye — the rogue session: a session
 * nobody registered implements something with no ticket, and the harness
 * asserts a closed `retro` sub-issue was filed against the right parent with
 * a body that reflects the prompts and the diff.
 *
 * Everything downstream of "how the session got there" runs FOR REAL: real
 * git commits in the sandbox repo, the real provenance classifier over the
 * transcript, the real Digest eye writing the digest the Retro eye then reads
 * as its transcript signal, and the real filing path through `./gh.ts`. Only
 * two things are fixtures — the agent (a deterministic brain) and `gh`
 * itself, so no test run can write to GitHub.
 *
 * `RogueSessionDriver` is the seam the live harness swaps: there, an actual
 * unregistered Claude/Codex session types and commits, and the scenario body
 * below does not change.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Sandbox, ScenarioHandler, ScenarioRegistry } from "../../harness/index.ts";
import {
  classifierFromRegistry,
  createFixtureProvenanceDriver,
  loadRegistry,
  registryPaths,
  type ProvenanceRecord,
  type ProvenanceScenarioDriver,
} from "../../provenance";
import type { MessageEvent, TailEvent } from "../../tailing";
import { createBrainCap } from "../cap";
import { DigestEye } from "../digest/digest";
import type { Brain } from "../brain";
import { createFakeGh, type FakeGh } from "./fake-gh";
import { fixtureRetroBrain } from "./fixture-brain";
import { RetroEye, type RetroFiling } from "./retro";

/** One session the registry never saw (§7.4 ad hoc / a stray agent). */
export interface RogueSessionHandle {
  readonly sessionId: string;
  /** Johan types into his own session. */
  johanTypes(text: string): Promise<void>;
  /** The agent answers. */
  agentSays(text: string): Promise<void>;
  /** The agent writes a file and commits it — real git, in the sandbox repo. */
  implementsFile(options: {
    path: string;
    contents: string;
    message: string;
  }): Promise<string>;
}

export interface RogueSessionDriver {
  /** Start a session with NO registry row, in the sandbox's repo. */
  startUnregistered(options: {
    sandbox: Sandbox;
    sessionId: string;
    agent: string;
  }): Promise<RogueSessionHandle>;
  /** Every tail event the rogue sessions have produced, in order. */
  events(sandbox: Sandbox): Promise<TailEvent[]>;
}

const BASE_MS = Date.parse("2026-08-24T14:00:00.000Z");
const STEP_MS = 60_000;

interface RogueWorld {
  events: TailEvent[];
  clock: number;
  uuids: number;
}

async function git(
  sandbox: Sandbox,
  args: string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const child = Bun.spawn(["git", ...args], {
    cwd: sandbox.repo,
    env: sandbox.env,
    stderr: "pipe",
    stdout: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

/** The fixture rogue session: real commits, synthesized transcript events. */
export function createFixtureRogueDriver(): RogueSessionDriver {
  const worlds = new Map<string, RogueWorld>();
  const world = (sandbox: Sandbox): RogueWorld => {
    let state = worlds.get(sandbox.root);
    if (!state) {
      state = { events: [], clock: BASE_MS, uuids: 0 };
      worlds.set(sandbox.root, state);
    }
    return state;
  };

  return {
    async startUnregistered({ sandbox, sessionId, agent }) {
      const state = world(sandbox);
      state.events.push({
        type: "session-meta",
        sessionId,
        agent,
        cwd: sandbox.repo,
        ts: new Date(state.clock).toISOString(),
        file: join(sandbox.root, "transcripts", `${sessionId}.jsonl`),
      });

      const say = (text: string, role: MessageEvent["role"]): void => {
        state.clock += STEP_MS;
        state.events.push({
          type: "message",
          sessionId,
          role,
          text,
          ts: new Date(state.clock).toISOString(),
          uuid: `rogue-${(state.uuids += 1)}`,
          candidate: role === "user",
          file: join(sandbox.root, "transcripts", `${sessionId}.jsonl`),
        });
      };

      return {
        sessionId,
        async johanTypes(text) {
          say(text, "user");
        },
        async agentSays(text) {
          say(text, "assistant");
        },
        async implementsFile({ path, contents, message }) {
          const full = join(sandbox.repo, path);
          await mkdir(dirname(full), { recursive: true });
          await writeFile(full, contents);
          const added = await git(sandbox, ["add", "--", path]);
          if (added.exitCode !== 0) throw new Error(added.stderr);
          const committed = await git(sandbox, ["commit", "--quiet", "-m", message]);
          if (committed.exitCode !== 0) throw new Error(committed.stderr);
          const head = await git(sandbox, ["rev-parse", "HEAD"]);
          return head.stdout.trim();
        },
      };
    },

    async events(sandbox) {
      return [...world(sandbox).events];
    },
  };
}

/** Classify every tailed event through the sandbox's real registry. */
async function classify(
  sandbox: Sandbox,
  events: readonly TailEvent[],
): Promise<{ records: ProvenanceRecord[]; sessionDirs: Map<string, string> }> {
  const registry = await loadRegistry(registryPaths(sandbox.repo));
  const { classifier } = classifierFromRegistry(registry);
  const records: ProvenanceRecord[] = [];
  const sessionDirs = new Map<string, string>();
  for (const event of events) {
    if (event.type === "session-meta" && event.cwd !== undefined) {
      sessionDirs.set(event.sessionId, event.cwd);
    }
    const { record } = classifier.handle(event);
    if (record) records.push(record);
  }
  return { records, sessionDirs };
}

/** The digest brain: enough narrative for the Retro eye's transcript signal. */
function fixtureDigestBrain(): Brain {
  return {
    async evaluate({ prompt }) {
      const sessions = new Map<string, string[]>();
      for (const match of prompt.matchAll(
        /\[session=([^ \]]+) author=([^ \]]+)[^\]]*\]\n([^\n]*)/g,
      )) {
        const id = match[1]!;
        sessions.set(id, [...(sessions.get(id) ?? []), match[3]!]);
      }
      return {
        ok: true,
        text: JSON.stringify({
          sessions: [...sessions.entries()].map(([sessionId, texts]) => ({
            sessionId,
            narrative: texts.join(" / "),
            summary: "a session with no ticket",
            status: texts.some((text) => /done/i.test(text)) ? "done" : "running",
          })),
        }),
      };
    },
  };
}

/** Run the real Digest eye once so the Retro eye reads a REAL digest. */
async function runDigest(
  sandbox: Sandbox,
  records: readonly ProvenanceRecord[],
): Promise<void> {
  let nowMs = 0;
  const eye = await DigestEye.open({
    repo: sandbox.repo,
    brain: fixtureDigestBrain(),
    cap: createBrainCap({
      directory: join(sandbox.root, "state/brain-slots"),
      maxConcurrency: 2,
      pollMs: 1,
    }),
    cadence: { quietWindowSeconds: 30, maxWaitSeconds: 120 },
    now: () => nowMs,
    sleep: async (ms) => {
      nowMs += ms;
    },
    onAlert: () => {},
  });
  await eye.ingest([...records]);
  const due = eye.dueAt();
  if (due !== null) {
    nowMs = due;
    await eye.tick();
  }
}

/** Open the Retro eye against the sandbox with the fake gh wired in. */
async function openRetroEye(sandbox: Sandbox, gh: FakeGh): Promise<RetroEye> {
  return RetroEye.open({
    repo: sandbox.repo,
    brain: fixtureRetroBrain(),
    cap: createBrainCap({
      directory: join(sandbox.root, "state/brain-slots"),
      maxConcurrency: 2,
      pollMs: 1,
    }),
    cadence: { quietWindowSeconds: 60, maxWaitSeconds: 600 },
    gh: gh.run,
    now: () => 0,
    sleep: async () => {},
    onAlert: () => {},
    onAudit: () => {},
  });
}

const JOHAN_PROMPT =
  "just add a retry to the fetch helper, don't bother opening a ticket for it";

/**
 * §13 scenario 3 — rogue session: an unregistered session implements
 * something with no ticket. Asserts the closed `retro` sub-issue, its parent,
 * and that its body reflects the prompts and the diff.
 */
export function rogueSessionScenario(
  driver: ProvenanceScenarioDriver = createFixtureProvenanceDriver(),
  rogueDriver: RogueSessionDriver = createFixtureRogueDriver(),
): ScenarioHandler {
  return async ({ assert, assertSandboxed, sandbox }) => {
    assert(sandbox.up.exitCode === 0, "sandbox was converged by argus up");
    const gh = createFakeGh({ repo: "fixture-owner/sandbox" });
    // The frontier as the tracker sees it: one open ticket about this area.
    gh.seed({
      number: 15,
      title: "Harden the fetch helper",
      body: "Retries, timeouts and error paths for src/fetch-helper.ts.",
    });

    const eye = await openRetroEye(sandbox, gh);
    // Whatever `argus up` left behind is the state of the world, not work.
    await eye.prime();

    // A registered ticket session doing its job — the control: covered work
    // must file NOTHING, however loudly it commits.
    const deployed = await driver.deploy({
      sandbox,
      sessionId: "sess-seven",
      agent: "codex",
      ticket: "7",
      dispatchPrompt: "You are a BUILD worker for ticket #7: add the widget.",
    });
    await deployed.agentSays("Implemented the widget. DONE.");
    await writeFile(join(sandbox.repo, "widget.ts"), "export const widget = 1;\n");
    await git(sandbox, ["add", "--", "widget.ts"]);
    await git(sandbox, ["commit", "--quiet", "-m", "feat: add the widget (#7)"]);

    // The rogue session: nobody registered it, and it implements something.
    const rogue = await rogueDriver.startUnregistered({
      sandbox,
      sessionId: "sess-rogue",
      agent: "claude",
    });
    await rogue.johanTypes(JOHAN_PROMPT);
    const sha = await rogue.implementsFile({
      path: "src/fetch-helper.ts",
      contents:
        "export async function fetchWithRetry(url: string): Promise<Response> {\n" +
        "  for (let attempt = 0; attempt < 3; attempt += 1) {\n" +
        "    const response = await fetch(url);\n" +
        "    if (response.ok) return response;\n" +
        "  }\n" +
        "  throw new Error(`fetch failed: ${url}`);\n" +
        "}\n",
      message: "add retry to the fetch helper",
    });
    await rogue.agentSays("Added fetchWithRetry with three attempts. DONE.");

    // The real classifier over both transcripts, then the real Digest eye.
    const { records, sessionDirs } = await classify(sandbox, [
      ...(await driver.events(sandbox)),
      ...(await rogueDriver.events(sandbox)),
    ]);
    await runDigest(sandbox, records);
    for (const [sessionId, cwd] of sessionDirs) {
      eye.observeSession({ sessionId, cwd });
    }
    await eye.ingest(records);

    const johanRecords = records.filter((record) => record.author === "johan");
    assert(
      johanRecords.length === 1 && johanRecords[0]!.text === JOHAN_PROMPT,
      "provenance classified exactly Johan's rogue prompt as Johan-authored",
    );

    const filings: RetroFiling[] = await eye.scan();

    assert(filings.length === 1, "exactly one retro was filed for the rogue work");
    const filing = filings[0]!;
    assert(filing.outcome === "filed", "the retro reached the tracker");

    const retros = gh.issues.filter((issue) => issue.labels.includes("retro"));
    assert(
      retros.length === 1 && retros[0]!.number === filing.issue,
      "the tracker holds exactly one retro-labeled issue",
    );
    const retro = retros[0]!;
    assert(
      retro.title === "Retro: add retry to the fetch helper",
      "the retro is titled `Retro: <what was done>`",
    );
    assert(retro.state === "closed", "the retro was filed CLOSED (no approval queue)");
    assert(
      retro.closeReason === "completed",
      "it is closed as completed — the work already happened",
    );
    assert(
      retro.parent === 15,
      "it is a sub-issue of the nearest plausible parent (#15)",
    );
    assert(
      gh.calls.some(
        (call) =>
          call[0] === "api" &&
          call[1] === "repos/fixture-owner/sandbox/issues/15/sub_issues" &&
          call[2] === "-F",
      ),
      "the link went through the GitHub sub_issues API",
    );
    assert(
      retro.body.includes(JOHAN_PROMPT),
      "the body reflects Johan's prompts",
    );
    assert(
      retro.body.includes("+export async function fetchWithRetry") &&
        retro.body.includes(sha.slice(0, 7)),
      "the body reflects the diff and cites the commit",
    );
    assert(
      retro.body.includes("sess-rogue"),
      "the body names the session the work came from",
    );
    assert(
      !retro.body.includes("add the widget"),
      "the covered ticket-7 work is NOT in the retro",
    );
    assert(
      !gh.issues.some((issue) => issue.title.includes("widget")),
      "the registered ticket session's own work filed no retro",
    );

    // Nothing in this scenario may touch real GitHub or real machine state.
    for (const cwd of gh.cwds) {
      assertSandboxed(cwd, "every gh call ran inside the sandbox");
    }

    // Filing is once-only: a second sweep of the same world files nothing.
    assert((await eye.scan()).length === 0, "the same rogue work is not re-filed");
  };
}

/** Register scenario 3 into the §13 harness registry (slot 3). */
export function registerRetroScenarios(
  registry: ScenarioRegistry,
  driver: ProvenanceScenarioDriver = createFixtureProvenanceDriver(),
  rogueDriver: RogueSessionDriver = createFixtureRogueDriver(),
): void {
  registry.register(3, rogueSessionScenario(driver, rogueDriver));
}
