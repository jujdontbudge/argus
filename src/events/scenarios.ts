import { appendFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { signalPathsScenario } from "../eyes/digest/scenarios.ts";
import type { ScenarioHandler, ScenarioRegistry } from "../harness/index.ts";
import {
  createFixtureProvenanceDriver,
  registryPaths,
  type ProvenanceScenarioDriver,
} from "../provenance";
import { handleClaudeStop, handleCodexNotify } from "./hooks.ts";
import type { CmuxSend } from "./notify.ts";
import { parseArgusEvent } from "./schema.ts";

/** §13 scenario 7 — retain the digest poll half, then add the push half. */
export function eventSignalPathsScenario(
  driver: ProvenanceScenarioDriver = createFixtureProvenanceDriver(),
): ScenarioHandler {
  const digestHalf = signalPathsScenario(driver);
  return async (context) => {
    await digestHalf(context);
    const { assert, sandbox } = context;
    const paths = registryPaths(sandbox.repo);
    await appendFile(
      paths.sessionsFile,
      `${JSON.stringify({
        ts: "2026-08-25T12:00:00.000Z",
        sessionId: "hermes-mission-scenario-7",
        agent: "hermes",
        dispatchPrompt: "Run Argus mission control.",
        workspace: "workspace:scenario-7",
      })}\n`,
    );

    let registryWasAhead = true;
    let cmuxCalls = 0;
    const send: CmuxSend = async (request) => {
      const sends = (await Bun.file(paths.sendsFile).text())
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { text?: unknown });
      cmuxCalls += 1;
      registryWasAhead =
        registryWasAhead && sends.some(({ text }) => text === request.text);
      return { ok: true };
    };
    const runtime = {
      now: () => new Date("2026-08-25T12:00:01.000Z"),
      send,
    };
    const [finished, blocked] = await Promise.all([
      handleClaudeStop(
        {
          hook_event_name: "Stop",
          session_id: "sess-finisher",
          cwd: sandbox.repo,
          last_assistant_message: "Implemented ticket #8, gates green. DONE.",
        },
        runtime,
      ),
      handleCodexNotify(
        {
          type: "agent-turn-complete",
          "thread-id": "sess-blocker",
          cwd: sandbox.repo,
          "last-assistant-message":
            "BLOCKED: I need the production API key from Johan to continue.",
        },
        runtime,
      ),
    ]);

    const eventFiles = (await readdir(join(sandbox.repo, ".argus", "events"))).filter(
      (file) => file.endsWith(".json"),
    );
    const events = await Promise.all(
      eventFiles.map(async (file) =>
        parseArgusEvent(
          await Bun.file(join(sandbox.repo, ".argus", "events", file)).text(),
        ),
      ),
    );
    assert(
      finished.status === "emitted" &&
        blocked.status === "emitted" &&
        events.length === 2 &&
        events.every((event) => event !== null) &&
        events.map((event) => event!.kind).sort().join(",") ===
          "blocked-on-human,session-ended",
      "hooks promptly wrote finish and block event files",
    );
    assert(
      registryWasAhead && cmuxCalls === 2,
      "every mission-control send was logged before cmux",
    );
  };
}

/** Extend scenario 7; never replace its already-registered digest behavior. */
export function registerEventScenarios(
  registry: ScenarioRegistry,
  driver: ProvenanceScenarioDriver = createFixtureProvenanceDriver(),
): void {
  registry.register(7, eventSignalPathsScenario(driver));
}
