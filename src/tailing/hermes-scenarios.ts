/** Fixture-driven Hermes source halves for SPEC §13 scenarios 1 and 4. */
import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Sandbox,
  ScenarioHandler,
  ScenarioRegistry,
} from "../harness/index.ts";
import { ProvenanceClassifier } from "../provenance/index.ts";
import { createHermesSource } from "./hermes.ts";
import type { MessageEvent, TailEvent } from "./events.ts";
import { Tailer } from "./tailer.ts";

const fixtureRoot = fileURLToPath(
  new URL("../../tests/fixtures/hermes", import.meta.url),
);

async function tailFixture(
  sandbox: Sandbox,
  label: string,
): Promise<{ events: TailEvent[]; sessionId: string }> {
  const hermesRoot = sandbox.env.HERMES_HOME;
  if (!hermesRoot) throw new Error("sandbox is missing HERMES_HOME");
  const sessionId = `hermes-scenario-${label}`;
  const profile = join(hermesRoot, "profiles", `argus-hermes-${label}`);
  await mkdir(profile, { recursive: true });
  const db = new Database(join(profile, "state.db"));
  try {
    db.exec(await Bun.file(join(fixtureRoot, "state.sql")).text());
    const rows = (await Bun.file(join(fixtureRoot, "scenarios.sql")).text())
      .replaceAll("hermes-scenario-session", sessionId)
      .replaceAll("__CWD__", sandbox.repo.replaceAll("'", "''"));
    db.exec(rows);
  } finally {
    db.close();
  }
  const events = await new Tailer(createHermesSource({ hermesRoot })).catchUp();
  return { events, sessionId };
}

/** §13 scenario 1 Hermes half — state.db joins the shared transcript stream. */
export const hermesAutonomousBatchScenario: ScenarioHandler = async ({
  assert,
  sandbox,
}) => {
  const { events, sessionId } = await tailFixture(sandbox, "autonomous");
  const messages = events.filter(
    (event): event is MessageEvent =>
      event.type === "message" && event.sessionId === sessionId,
  );
  assert(
    messages.length === 2 &&
      messages[0]?.text === "Run the Hermes autonomous batch." &&
      messages[1]?.text === "Hermes completed the autonomous batch.",
    "Hermes-side messages reached the normalized stream",
  );
};

/** §13 scenario 4 Hermes half — source rows flow through the provenance seam. */
export const hermesPoisoningScenario: ScenarioHandler = async ({ assert, sandbox }) => {
  const { events, sessionId } = await tailFixture(sandbox, "poisoning");
  const classifier = new ProvenanceClassifier();
  classifier.registerSession({
    ts: "2026-04-27T08:26:40.000Z",
    sessionId,
    dispatchPrompt: "Run the Hermes autonomous batch.",
    agent: "hermes",
  });
  const records = events
    .filter((event) => event.sessionId === sessionId)
    .map((event) => classifier.handle(event).record)
    .filter((record) => record !== null);
  const assistant = records.find(({ event }) => event.role === "assistant");
  assert(
    assistant?.author === "agent" && !records.some(({ author }) => author === "johan"),
    "Hermes-authored assistant output never classifies Johan",
  );
};

function extend(
  registry: ScenarioRegistry,
  number: 1 | 4,
  hermesHalf: ScenarioHandler,
): void {
  const existing = registry.get(number);
  registry.register(number, async (context) => {
    if (existing !== undefined) await existing(context);
    await hermesHalf(context);
  });
}

/** Add the Hermes source assertions without replacing other tickets' halves. */
export function registerHermesScenarios(registry: ScenarioRegistry): void {
  extend(registry, 1, hermesAutonomousBatchScenario);
  extend(registry, 4, hermesPoisoningScenario);
}
