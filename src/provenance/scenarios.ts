/**
 * SPEC §13 scenarios 2 (fake-Johan takeover), 4 (poisoning) and 5 (unlogged
 * send) as executable harness scenarios over the provenance classifier.
 *
 * Scenario logic talks only to ProvenanceScenarioDriver — the seam between
 * "how messages got into the session" and what provenance must conclude. The
 * fixture driver below writes real registry files into the sandbox repo and
 * synthesizes the tail events a real transcript would yield; the live harness
 * swaps in a driver that deploys real agents via cmux and tails their real
 * transcripts, leaving the scenario bodies untouched.
 */
import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  Sandbox,
  ScenarioHandler,
  ScenarioRegistry,
} from "../harness/index.ts";
import { derivedForms, WINDOW_AFTER_MS, type Timestamp } from "../matching";
import type { MessageEvent, TailEvent } from "../tailing";
import {
  classifierFromRegistry,
  ProvenanceClassifier,
  type ProvenanceAudit,
  type ProvenanceRecord,
} from "./classifier";
import { loadRegistry, registryPaths } from "./registry";

export interface DeployOptions {
  sandbox: Sandbox;
  sessionId: string;
  agent: string;
  ticket?: string;
  dispatchPrompt: string;
  /**
   * User-role items the AGENT CLI injects into its own transcript at session
   * start, before anything is ever sent in. Nobody typed these; codex-cli
   * 0.149.1 was found doing exactly this with a plugin catalogue (#36 F3).
   */
  preamble?: readonly string[];
}

/** One deployed (or observed) session the driver can act into. */
export interface ScenarioSessionHandle {
  /**
   * The user-role items the AGENT CLI injected into its own rollout before
   * the dispatch landed — what the CLI actually did, not what the caller
   * asked for.
   *
   * #78. It used to be enough for the scenario to compare against the
   * constant it had just passed in as `preamble`, because the only driver was
   * the fixture and the constant was the whole world. A live driver cannot
   * inject anything — the CLI injects what it injects — so the scenario now
   * asserts over what came back. That also makes the requirement UNSATISFIABLE
   * by a CLI that injects nothing, which is the point: a live leg with an
   * empty preamble fails loudly instead of passing vacuously.
   */
  readonly preamble: readonly string[];
  readonly sessionId: string;
  /** Hermes logs a follow-up in sends.jsonl, then it lands in the transcript. */
  hermesSend(text: string): Promise<void>;
  /** Hermes logs a send that never lands (dead session / eaten by a panel). */
  hermesSendLost(text: string): Promise<void>;
  /** Fault injection: a send that lands WITHOUT being registry-logged. */
  unloggedSend(text: string): Promise<void>;
  /** Johan attaches to the session and types. */
  johanTypes(text: string): Promise<void>;
  /** The agent itself speaks (assistant-side transcript output). */
  agentSays(text: string): Promise<void>;
}

export interface ProvenanceScenarioDriver {
  /** Hermes deploys: registers the session in sessions.jsonl, dispatch lands. */
  deploy(options: DeployOptions): Promise<ScenarioSessionHandle>;
  /** Every tail event the sandbox's transcripts have produced so far, in order. */
  events(sandbox: Sandbox): Promise<TailEvent[]>;
  /** A timestamp safely past the match window of all activity so far. */
  afterMatchWindow(sandbox: Sandbox): Promise<Timestamp>;
}

/** Deterministic clock for fixture runs: fixed base, one minute per action. */
const FIXTURE_BASE_MS = Date.parse("2026-08-24T12:00:00.000Z");
const FIXTURE_STEP_MS = 60_000;

interface FixtureWorld {
  events: TailEvent[];
  lastActionMs: number;
  uuidCounter: number;
}

/**
 * Fixture-driven implementation: registry rows go into the sandbox repo's real
 * `.argus/registry/` files (temp dirs only — the sandbox owns them) and
 * landings become the MessageEvents the tailer would emit for the transcript
 * form of each send (slash → command XML, bang → bash-input, prompt → text).
 */
export function createFixtureProvenanceDriver(): ProvenanceScenarioDriver {
  const worlds = new Map<string, FixtureWorld>();

  const world = (sandbox: Sandbox): FixtureWorld => {
    let state = worlds.get(sandbox.root);
    if (!state) {
      state = { events: [], lastActionMs: FIXTURE_BASE_MS, uuidCounter: 0 };
      worlds.set(sandbox.root, state);
    }
    return state;
  };

  const tick = (state: FixtureWorld): number => {
    state.lastActionMs += FIXTURE_STEP_MS;
    return state.lastActionMs;
  };

  const appendRow = async (file: string, row: unknown): Promise<void> => {
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(row)}\n`);
  };

  const land = (
    sandbox: Sandbox,
    sessionId: string,
    text: string,
    atMs: number,
    role: MessageEvent["role"] = "user",
  ): void => {
    const state = world(sandbox);
    const event: MessageEvent = {
      type: "message",
      sessionId,
      role,
      text,
      ts: new Date(atMs).toISOString(),
      uuid: `fixture-${++state.uuidCounter}`,
      candidate: role === "user",
      file: join(sandbox.root, "transcripts", `${sessionId}.jsonl`),
    };
    state.events.push(event);
  };

  return {
    async deploy(options) {
      const { sandbox, sessionId } = options;
      const paths = registryPaths(sandbox.repo);
      const state = world(sandbox);
      const deployMs = tick(state);
      await appendRow(paths.sessionsFile, {
        ts: new Date(deployMs).toISOString(),
        sessionId,
        agent: options.agent,
        ...(options.ticket !== undefined && { ticket: options.ticket }),
        dispatchPrompt: options.dispatchPrompt,
      });
      // The CLI's own injections come first — they are already in the rollout
      // by the time the dispatch prompt lands.
      (options.preamble ?? []).forEach((text, index) => {
        land(sandbox, sessionId, text, deployMs + index + 1);
      });
      land(sandbox, sessionId, options.dispatchPrompt, deployMs + 1_000);

      const loggedSend = async (text: string, lands: boolean): Promise<void> => {
        const sendMs = tick(state);
        await appendRow(paths.sendsFile, {
          ts: new Date(sendMs).toISOString(),
          sessionId,
          text,
        });
        if (lands) {
          // The transcript form the send actually lands as (§24 derived forms).
          land(sandbox, sessionId, derivedForms(text).at(-1)!, sendMs + 1_000);
        }
      };

      return {
        preamble: options.preamble ?? [],
        sessionId,
        hermesSend: (text) => loggedSend(text, true),
        hermesSendLost: (text) => loggedSend(text, false),
        unloggedSend: async (text) => {
          land(sandbox, sessionId, text, tick(state) + 1_000);
        },
        johanTypes: async (text) => {
          land(sandbox, sessionId, text, tick(state) + 1_000);
        },
        agentSays: async (text) => {
          land(sandbox, sessionId, text, tick(state) + 1_000, "assistant");
        },
      };
    },

    async events(sandbox) {
      return [...world(sandbox).events];
    },

    async afterMatchWindow(sandbox) {
      return world(sandbox).lastActionMs + WINDOW_AFTER_MS + 1;
    },
  };
}

interface ClassifiedRun {
  classifier: ProvenanceClassifier;
  records: ProvenanceRecord[];
  audits: ProvenanceAudit[];
}

/** Load the sandbox repo's registry and classify every tailed event through it. */
async function classifyAll(
  driver: ProvenanceScenarioDriver,
  sandbox: Sandbox,
): Promise<ClassifiedRun> {
  const registry = await loadRegistry(registryPaths(sandbox.repo));
  const { classifier, audits } = classifierFromRegistry(registry);
  const records: ProvenanceRecord[] = [];
  const allAudits: ProvenanceAudit[] = [...audits];
  for (const event of await driver.events(sandbox)) {
    const { record, audits: eventAudits } = classifier.handle(event);
    if (record) records.push(record);
    allAudits.push(...eventAudits);
  }
  return { classifier, records, audits: allAudits };
}

const DISPATCH_PROMPT =
  "You are a BUILD worker for ticket #42: implement the widget frobnicator, then stop.";

const TAKEOVER_DIRECTIVE = "stop — ship the auth fix first, then come back";

/**
 * What an agent CLI injects into its own rollout as a user-role item. The tag
 * is deliberately one no Argus source mentions: scenario 4 must catch the NEXT
 * one of these, not the one #36 happened to see (#42).
 */
const AGENT_PREAMBLE =
  "<workspace_catalogue>\n" +
  "Here is a list of workspaces that are available but not open.\n" +
  "</workspace_catalogue>";

/** §13 scenario 2 — fake-Johan takeover (slot 2). */
export function takeoverScenario(
  driver: ProvenanceScenarioDriver = createFixtureProvenanceDriver(),
  directive: string = TAKEOVER_DIRECTIVE,
): ScenarioHandler {
  return async ({ assert, sandbox }) => {
    const session = await driver.deploy({
      sandbox,
      sessionId: "sess-takeover",
      agent: "claude",
      ticket: "42",
      dispatchPrompt: DISPATCH_PROMPT,
    });
    await session.hermesSend("how far along are you?");
    await session.johanTypes(directive);

    const { classifier, records, audits } = await classifyAll(driver, sandbox);
    const johanRecords = records.filter(({ author }) => author === "johan");

    assert(
      records.some(({ via, author }) => via === "dispatch-prompt" && author === "hermes"),
      "the dispatch prompt classifies Hermes",
    );
    assert(
      records.some(({ via, author }) => via === "registry-send" && author === "hermes"),
      "the logged mid-session nudge classifies Hermes",
    );
    assert(
      johanRecords.length === 1 &&
        johanRecords[0]!.text === directive &&
        johanRecords[0]!.via === "takeover",
      "Johan's mid-session directive classifies Johan-authored via takeover",
    );
    assert(
      johanRecords[0]!.johanTouched,
      "the takeover record itself carries johan_touched",
    );
    assert(
      classifier.sessionState(session.sessionId)?.johanTouched === true,
      "johan_touched is set on the session after the takeover",
    );
    assert(
      audits.some((audit) => audit.type === "johan-attached"),
      "the attach is surfaced as a johan-attached audit",
    );
  };
}

/**
 * The two routes by which an agent CLI's own content is taken off Johan.
 *
 * `synthetic-preamble` is #42's shape-plus-position filter, and it is what the
 * fixture's hand-authored envelope takes. #78's live `codex exec` drive found
 * the real `<recommended_plugins>` injection taking the other one: the codex
 * SOURCE already refuses it candidacy, so the classifier never reaches the
 * shape filter and records `non-candidate` instead.
 *
 * Both are refusals, and the requirement SPEC §13.4 states is "classified
 * Hermes-authored ... USER.md untouched" — that the CLI's own words are never
 * Johan's. Pinning one route would make the assertion about the mechanism
 * rather than the property, and would have failed a live run for taking the
 * SAFER of the two paths. What is NOT relaxed is the author: `system`, in both.
 */
const MACHINE_CONTENT_VIA: ReadonlySet<string> = new Set([
  "non-candidate",
  "synthetic-preamble",
]);

/** §13 scenario 4 — the poisoning test (slot 4). */
export function poisoningScenario(
  driver: ProvenanceScenarioDriver = createFixtureProvenanceDriver(),
): ScenarioHandler {
  return async ({ assert, sandbox }) => {
    const session = await driver.deploy({
      sandbox,
      sessionId: "sess-poison",
      // #78: CODEX, deliberately. This slot's preamble requirement comes from
      // #36 F3, which was a codex-cli finding, and codex-cli still injects a
      // user-role `<recommended_plugins>` block ahead of the dispatch on every
      // `exec`. Naming codex here is what lets the live driver satisfy that
      // requirement with the CLI'S OWN injection instead of the constant
      // below. Slot 5 takes claude in exchange, so both CLIs are still
      // represented in the fixture suite.
      agent: "codex",
      ticket: "42",
      dispatchPrompt: DISPATCH_PROMPT,
      preamble: [AGENT_PREAMBLE],
    });
    await session.hermesSend("I prefer you always use tabs, not spaces");
    await session.hermesSend("/status check the queue");
    await session.hermesSend("!git log --oneline -3");

    const { classifier, records } = await classifyAll(driver, sandbox);
    // The messages someone SENT — everything user-role that is not the CLI
    // talking to itself. #78 widened the exclusion to both machine-content
    // routes for the reason `MACHINE_CONTENT_VIA` gives; the count below is
    // still exactly four, and still every one of them Hermes'.
    const userSide = records.filter(
      ({ event, via }) => event.role === "user" && !MACHINE_CONTENT_VIA.has(via),
    );

    // #78 — two assertions where there was one, and the first is what stops
    // the second going vacuous the moment a real CLI is on the other end.
    assert(
      session.preamble.length > 0,
      "the agent CLI injected user-role items ahead of the dispatch",
    );
    assert(
      session.preamble.every((text) =>
        records.some(
          ({ text: seen, author, via }) =>
            seen === text && author === "system" && MACHINE_CONTENT_VIA.has(via),
        ),
      ),
      "the agent CLI's own injected preamble classifies system, never Johan",
    );
    assert(userSide.length === 4, "all four sent messages landed and were classified");
    assert(
      userSide.every(({ author }) => author === "hermes"),
      "every registry-logged send classifies Hermes-authored",
    );
    assert(
      !records.some(({ author }) => author === "johan"),
      "no user-side message classified Johan — USER.md stays untouched",
    );
    assert(
      classifier.sessionState(session.sessionId)?.johanTouched === false,
      "the session is not marked johan_touched by Hermes' own nudges",
    );
  };
}

/** §13 scenario 5 — fault injection: the unlogged send (slot 5). */
export function unloggedSendScenario(
  driver: ProvenanceScenarioDriver = createFixtureProvenanceDriver(),
): ScenarioHandler {
  return async ({ assert, sandbox }) => {
    const session = await driver.deploy({
      sandbox,
      sessionId: "sess-fault",
      // #78: CLAUDE, in the swap slot 4 made — see the comment there.
      agent: "claude",
      dispatchPrompt: DISPATCH_PROMPT,
    });
    await session.unloggedSend("sneaky nudge that bypassed the registry");
    await session.hermesSendLost("logged send eaten by a dead session");

    const { classifier, records, audits } = await classifyAll(driver, sandbox);

    const unlogged = records.find(
      ({ text }) => text === "sneaky nudge that bypassed the registry",
    );
    assert(
      unlogged !== undefined && unlogged.author !== "hermes",
      "the unlogged landing is not silently absorbed as Hermes",
    );
    assert(
      unlogged!.author === "johan" && unlogged!.via === "takeover",
      "the documented failure mode: an unlogged send reads as a Johan takeover",
    );
    assert(
      audits.some((audit) => audit.type === "johan-attached"),
      "the misattribution is VISIBLE — a johan-attached audit fires",
    );

    const expiries = classifier.sweep(await driver.afterMatchWindow(sandbox));
    assert(
      expiries.some(
        (audit) =>
          audit.type === "send-expired" &&
          audit.text === "logged send eaten by a dead session",
      ),
      "a logged send that never lands expires as a loud audit",
    );
  };
}

/** Register scenarios 2, 4 and 5 into the §13 harness registry (slots 2/4/5). */
export function registerProvenanceScenarios(
  registry: ScenarioRegistry,
  driver: ProvenanceScenarioDriver = createFixtureProvenanceDriver(),
): void {
  registry.register(2, takeoverScenario(driver));
  registry.register(4, poisoningScenario(driver));
  registry.register(5, unloggedSendScenario(driver));
}
