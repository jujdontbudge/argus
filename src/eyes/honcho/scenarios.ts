/** Fixture-driven Honcho halves for SPEC §13 scenarios 2 and 9. */
import type { Sandbox, ScenarioHandler, ScenarioRegistry } from "../../harness";
import {
  classifierFromRegistry,
  createFixtureProvenanceDriver,
  loadRegistry,
  registryPaths,
  takeoverScenario,
  type ProvenanceScenarioDriver,
} from "../../provenance";
import type {
  HonchoIngestionClient,
  HonchoMessageInput,
  HonchoPeerInput,
  HonchoSessionInput,
  HonchoWorkspaceInput,
} from "../../up/bindings";
import { HonchoEye, loadHonchoBinding } from "./honcho";

class FixtureHoncho implements HonchoIngestionClient {
  readonly messages: Array<{
    workspace: string;
    session: string;
    message: HonchoMessageInput;
  }> = [];

  async ensureWorkspace(_input: HonchoWorkspaceInput) {
    return "created" as const;
  }

  async ensurePeer(_workspace: string, _input: HonchoPeerInput) {
    return "created" as const;
  }

  async ensureSession(_workspace: string, _input: HonchoSessionInput) {
    return "created" as const;
  }

  async createMessages(
    workspace: string,
    session: string,
    messages: readonly HonchoMessageInput[],
  ): Promise<void> {
    for (const message of messages) {
      this.messages.push({ workspace, session, message });
    }
  }

  representation(workspace: string, peer: HonchoMessageInput["peer_id"]): string[] {
    return this.messages
      .filter(
        (entry) =>
          entry.workspace === workspace && entry.message.peer_id === peer,
      )
      .map(({ message }) => message.content);
  }
}

async function runEye(
  sandbox: Sandbox,
  driver: ProvenanceScenarioDriver,
): Promise<{ fixture: FixtureHoncho; workspace: string }> {
  const registry = await loadRegistry(registryPaths(sandbox.repo));
  const { classifier } = classifierFromRegistry(registry);
  const records = [];
  for (const event of await driver.events(sandbox)) {
    const { record } = classifier.handle(event);
    if (record !== null) records.push(record);
  }
  const fixture = new FixtureHoncho();
  const eye = await HonchoEye.open({
    repo: sandbox.repo,
    client: fixture,
    autoFlush: false,
    onAlert: () => {},
  });
  await eye.ingest(records);
  await eye.flush();
  const { workspace } = await loadHonchoBinding(sandbox.repo);
  return { fixture, workspace };
}

/** §13 scenario 2 — classifier takeover plus the user-peer observation. */
export function honchoTakeoverScenario(
  driver: ProvenanceScenarioDriver = createFixtureProvenanceDriver(),
): ScenarioHandler {
  const provenanceHalf = takeoverScenario(driver);
  return async (context) => {
    await provenanceHalf(context);
    const { fixture, workspace } = await runEye(context.sandbox, driver);
    context.assert(
      fixture
        .representation(workspace, "johan")
        .includes("stop — ship the auth fix first, then come back"),
      "the takeover directive was logged as a Johan-peer observation",
    );
  };
}

/** §13 scenario 9 — peer-id routing is the structural isolation guarantee. */
export function honchoSemanticIsolationScenario(
  driver: ProvenanceScenarioDriver = createFixtureProvenanceDriver(),
): ScenarioHandler {
  return async ({ assert, sandbox }) => {
    const session = await driver.deploy({
      sandbox,
      sessionId: "sess-honcho-isolation",
      agent: "codex",
      ticket: "32",
      dispatchPrompt: "Implement the Honcho eye without changing Johan's profile.",
    });
    await session.hermesSend("Keep going; this is an orchestration nudge.");
    await session.agentSays("Agent decoy: Johan prefers yarn and Emacs.");
    await session.johanTypes("I prefer bun and Cursor for this project.");

    const { fixture, workspace } = await runEye(sandbox, driver);
    assert(
      JSON.stringify(fixture.representation(workspace, "johan")) ===
        JSON.stringify(["I prefer bun and Cursor for this project."]),
      "Johan's representation contains only Johan-authored messages",
    );
    assert(
      fixture.messages.length === 4 &&
        fixture.messages.filter(({ message }) => message.peer_id === "johan")
          .length === 1,
      "agent and orchestration messages remain on their own peers",
    );
  };
}

function extend(
  registry: ScenarioRegistry,
  number: 2 | 9,
  honchoHalf: ScenarioHandler,
): void {
  const existing = registry.get(number);
  registry.register(number, async (context) => {
    if (existing !== undefined) await existing(context);
    await honchoHalf(context);
  });
}

/** Extend only the Honcho eye's required §13 slots; preserve earlier halves. */
export function registerHonchoScenarios(
  registry: ScenarioRegistry,
  driver: ProvenanceScenarioDriver = createFixtureProvenanceDriver(),
): void {
  extend(registry, 2, honchoTakeoverScenario(driver));
  extend(registry, 9, honchoSemanticIsolationScenario(driver));
}
