import { appendFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { signalPathsScenario } from "../eyes/digest/scenarios.ts";
import type { ScenarioHandler, ScenarioRegistry } from "../harness/index.ts";
import {
  createFixtureProvenanceDriver,
  registryPaths,
  type ProvenanceScenarioDriver,
} from "../provenance";
import { pollHermesSignals } from "./consumer.ts";
import { handleClaudeStop, handleCodexNotify } from "./hooks.ts";
import type { CmuxRun } from "./notify.ts";
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

    const polledWithoutPush = await pollHermesSignals(sandbox.repo);
    assert(
      polledWithoutPush.map(({ status }) => status).sort().join(",") ===
        "blocked,done" &&
        polledWithoutPush.every(({ source }) => source === "poll"),
      "the production slow poll delivered finish and block when no push arrived",
    );
    assert(
      (await pollHermesSignals(sandbox.repo)).length === 0,
      "the slow poll cursor delivered each terminal status once",
    );

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
    const cmux: CmuxRun = async (args) => {
      if (args[0] === "list-workspaces") {
        return {
          exitCode: 0,
          stderr: "",
          stdout: "  workspace:scenario-7  argus/mission\n",
        };
      }
      if (args[0] === "send-key") {
        return { exitCode: 0, stderr: "", stdout: "" };
      }
      if (args[0] !== "send") {
        return { exitCode: 2, stderr: `unexpected cmux call: ${args.join(" ")}`, stdout: "" };
      }
      const sends = (await Bun.file(paths.sendsFile).text())
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { text?: unknown });
      const text = args.at(-1);
      cmuxCalls += 1;
      registryWasAhead =
        registryWasAhead && sends.some((row) => row.text === text);
      return { exitCode: 0, stderr: "", stdout: "" };
    };
    const runtime = {
      cmux,
      now: () => new Date("2026-08-25T12:00:01.000Z"),
    };
    const [finished, blocked] = await Promise.all([
      handleClaudeStop(
        {
          hook_event_name: "Stop",
          session_id: "sess-push-finisher",
          cwd: sandbox.repo,
          last_assistant_message: "Implemented ticket #8, gates green. DONE.",
        },
        runtime,
      ),
      handleCodexNotify(
        {
          type: "agent-turn-complete",
          "thread-id": "sess-push-blocker",
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
          "blocked-on-human,end-of-session",
      "hooks promptly wrote finish and block event files",
    );
    assert(
      registryWasAhead && cmuxCalls === 2,
      "every guarded mission-control send was logged before cmux",
    );
    assert(
      (await pollHermesSignals(sandbox.repo, { cmux })).length === 0,
      "successful pushes were not delivered again by the slow poll",
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
