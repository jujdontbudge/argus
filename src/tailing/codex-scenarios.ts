/** Fixture-driven Codex source halves for SPEC §13 scenarios 1 and 3. */
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  Sandbox,
  ScenarioHandler,
  ScenarioRegistry,
} from "../harness/index.ts";
import { createCodexSource } from "./codex.ts";
import type { TailEvent } from "./events.ts";
import { Tailer } from "./tailer.ts";

const fixtureRoot = fileURLToPath(
  new URL("../../tests/fixtures/codex", import.meta.url),
);

async function tailFixture(
  sandbox: Sandbox,
  fixtureName: string,
  rolloutName: string,
): Promise<TailEvent[]> {
  const codexHome = sandbox.env.CODEX_HOME;
  if (!codexHome) throw new Error("sandbox is missing CODEX_HOME");
  const directory = join(codexHome, "sessions/2026/08/25");
  await mkdir(directory, { recursive: true });
  const fixture = await Bun.file(join(fixtureRoot, fixtureName)).text();
  await writeFile(
    join(directory, rolloutName),
    fixture.replaceAll("__CWD__", sandbox.repo),
  );
  return new Tailer(createCodexSource({ codexHome })).catchUp();
}

/** §13 scenario 1 Codex half — Codex sessions participate in the shared stream. */
export const codexAutonomousBatchScenario: ScenarioHandler = async ({
  assert,
  sandbox,
}) => {
  const events = await tailFixture(
    sandbox,
    "scenario-autonomous-batch.jsonl",
    "rollout-2026-08-25T10-00-00-55555555-5555-5555-5555-555555555555.jsonl",
  );
  const messages = events.filter((event) => event.type === "message");
  assert(
    messages.length === 2 &&
      messages[0]?.text === "Run the autonomous ticket batch." &&
      messages[1]?.text === "The autonomous batch is complete.",
    "Codex autonomous-session messages fed the normalized stream",
  );
};

/** §13 scenario 3 Codex half — an undeployed session still resolves to the repo. */
export const codexRogueSessionScenario: ScenarioHandler = async ({
  assert,
  sandbox,
}) => {
  const events = await tailFixture(
    sandbox,
    "scenario-rogue-session.jsonl",
    "rollout-2026-08-25T11-00-00-66666666-6666-6666-6666-666666666666.jsonl",
  );
  const meta = events.find(
    (event) =>
      event.type === "session-meta" &&
      event.sessionId === "66666666-6666-6666-6666-666666666666",
  );
  const prompt = events.find(
    (event) =>
      event.type === "message" &&
      event.role === "user" &&
      event.sessionId === "66666666-6666-6666-6666-666666666666",
  );
  assert(
    meta?.repo === (await realpath(sandbox.repo)) &&
      prompt?.candidate === true &&
      prompt.text === "Implement an unregistered rogue change.",
    "rogue Codex session attributed to the sandbox repo",
  );
};

function extend(
  registry: ScenarioRegistry,
  number: 1 | 3,
  codexHalf: ScenarioHandler,
): void {
  const existing = registry.get(number);
  registry.register(number, async (context) => {
    if (existing !== undefined) await existing(context);
    await codexHalf(context);
  });
}

/** Add the Codex source assertions without replacing other tickets' halves. */
export function registerCodexScenarios(registry: ScenarioRegistry): void {
  extend(registry, 1, codexAutonomousBatchScenario);
  extend(registry, 3, codexRogueSessionScenario);
}
