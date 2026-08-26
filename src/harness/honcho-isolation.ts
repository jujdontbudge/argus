/**
 * Ticket #76 — SPEC §13.9 against a REAL Honcho instance.
 *
 * WHAT WAS WRONG. Slot 9's own manifest called it out in `verdicts.ts`: "no
 * Honcho workspace is queried. `FixtureHoncho` is an in-memory array in
 * `src/eyes/honcho/scenarios.ts`". SPEC §13.9 says "**query the repo's Honcho
 * workspace**", and nothing in that slot ever did. An in-memory
 * `Array.filter` on `peer_id` cannot demonstrate semantic isolation — it
 * demonstrates that `Array.filter` works. The requirement was UNCOVERED, not
 * partial, and it was UNCOVERED because the only code in the tree that talked
 * to a real instance was `src/eyes/honcho/live.test.ts`, behind its own gate
 * and outside this slot.
 *
 * WHAT THIS IS. The same two sandbox repos slot 9 already builds, converged by
 * the same `argus up`, ingested through the same production `HonchoEye` — but
 * with `HttpHonchoClient` pointed at the URL each repo's OWN `.argus/
 * honcho.yaml` binding names, and then **queried back out of the live
 * service**. The isolation asserted is Honcho's own: its peer filter, its
 * per-peer search and its workspace scoping, answered by the service over
 * rows it stored. Nothing here filters an array the harness owns.
 *
 * WHAT IT DELIBERATELY DOES NOT CLAIM. Honcho's Deriver — the thing that turns
 * stored messages into a *derived representation* — waits for 512 tokens or 30
 * minutes before it runs. This drive is four short messages per repo and stays
 * under that threshold on purpose. So the representation endpoint is queried
 * and reported verbatim, and `13.9.representation-johan-only` stays PARTIAL
 * saying exactly that: what is proven live is ATTRIBUTION and SCOPE, not
 * derivation. Asserting "no foreign content in an empty representation" as
 * coverage would be scenario 10's dormant-directory mistake in a new file.
 *
 * NO FIXTURE FALLBACK, AND NO SEAM. There is no client parameter, no fake
 * spawner and no evidence seam: if the gate is shut or the service is absent,
 * this scenario FAILS its first assertion rather than quietly grading itself
 * on a double. That is #68's rule — `gate-unset` when nobody asked, `not-run`
 * when someone asked and the service or its credential is genuinely missing,
 * and never a silent pass.
 *
 * THE VERDICT IT EARNS, STATED PLAINLY. STRUCTURAL. #63's LIVE means "a real
 * agent ran under this scenario and its own output was graded", reachable only
 * through `recordLiveEvidence`, and this slot spawns no agent — the messages
 * are the fixture provenance driver's, classified by the real classifier. So
 * it declares the `agent` and `brain` doubles and keeps the STRUCTURAL word.
 * What it stops declaring is `honcho`, which is the double SPEC §13.9 is
 * actually about. Widening LIVE to mean "some real dependency was involved"
 * would buy this slot a better-looking word by deleting the property that
 * makes every other slot's verdict worth reading.
 *
 * SPEC §1 items 7 and 8. Not one line here consults an Anthropic or OpenAI
 * credential. The key it does read is a LOCAL self-hosted Honcho's bearer
 * token; no model is called, no metered access is required, and the drive
 * stays under the Deriver's threshold so it cannot start one either.
 */
import {
  HonchoEye,
  loadHonchoBinding,
} from "../eyes/honcho/honcho.ts";
import {
  honchoQuery,
  LIVE_HONCHO_URL,
  removeScratchWorkspace,
} from "../eyes/honcho/live-probe.ts";
import { LIVE_HONCHO_GATE } from "../eyes/live-gate.ts";
import {
  classifierFromRegistry,
  createFixtureProvenanceDriver,
  loadRegistry,
  registryPaths,
  type ProvenanceScenarioDriver,
} from "../provenance/index.ts";
import { HttpHonchoClient } from "../up/bindings.ts";
import type { Sandbox, ScenarioHandler } from "./index.ts";
import type { LiveHalfOutcome } from "./live-gate.ts";
import {
  gradeScenario,
  type LabeledScenarioManifest,
  type ScenarioGrade,
} from "./verdicts.ts";

/** The two scripted repos. Distinct words, so any bleed is unmistakable. */
interface RepoScript {
  agentSays: string;
  dispatch: string;
  hermesSend: string;
  johanTypes: string;
  sessionId: string;
}

const PRIMARY: RepoScript = {
  agentSays: "Agent decoy: Johan prefers yarn and Emacs.",
  dispatch: "Implement the Honcho eye without changing Johan's profile.",
  hermesSend: "Keep going; this is an orchestration nudge.",
  johanTypes: "I prefer bun and Cursor for this project.",
  sessionId: "sess-honcho-isolation-primary",
};

const OTHER: RepoScript = {
  agentSays: "Agent decoy: the neighbour repo runs on npm and vim.",
  dispatch: "Work the neighbour repo's ticket; do not touch the first repo.",
  hermesSend: "Neighbour nudge; keep to this repo.",
  johanTypes: "In the neighbour repo I prefer pnpm and Zed.",
  sessionId: "sess-honcho-isolation-peer",
};

interface LiveMessage {
  content: string;
  peer_id: string;
}

interface DrivenRepo {
  messages: LiveMessage[];
  pending: number;
  representation: string;
  script: RepoScript;
  url: string;
  workspace: string;
}

export interface HonchoIsolationOptions {
  /** A local Honcho bearer credential. Never logged, compared or shortened. */
  apiKey: string | null;
  gate: LiveHalfOutcome;
}

/** The banner every `bun test` prints, gate open or shut. */
export function describeHonchoIsolationGate(gate: LiveHalfOutcome): string {
  if (gate.status === "gate-unset") {
    return `argus: the §13.9 LIVE Honcho isolation slot is SKIPPED — set ${LIVE_HONCHO_GATE}=1 to run it against a real local instance`;
  }
  const banner = gate.status === "run" ? "RUN" : "NOT RUN";
  return [
    `${LIVE_HONCHO_GATE}=1 — the §13.9 LIVE Honcho isolation slot is ${banner}: ${gate.reason}`,
    "  SPEC §1: a LOCAL self-hosted Honcho only — no Anthropic or OpenAI key, no metered access, no model call",
  ].join("\n");
}

/**
 * Everything one repo contributes: a scripted session, classified by the real
 * provenance classifier, delivered by the production eye, then read back out
 * of the live service.
 */
async function driveRepo(
  sandbox: Sandbox,
  driver: ProvenanceScenarioDriver,
  script: RepoScript,
  apiKey: string,
): Promise<DrivenRepo> {
  const session = await driver.deploy({
    sandbox,
    sessionId: script.sessionId,
    agent: "codex",
    ticket: "32",
    dispatchPrompt: script.dispatch,
  });
  await session.hermesSend(script.hermesSend);
  await session.agentSays(script.agentSays);
  await session.johanTypes(script.johanTypes);

  const { classifier } = classifierFromRegistry(
    await loadRegistry(registryPaths(sandbox.repo)),
  );
  const records = [];
  for (const event of await driver.events(sandbox)) {
    const { record } = classifier.handle(event);
    if (record !== null) records.push(record);
  }

  // The binding `argus up` wrote for THIS repo — not a URL this file invented.
  const { url, workspace } = await loadHonchoBinding(sandbox.repo);
  const eye = await HonchoEye.open({
    repo: sandbox.repo,
    client: new HttpHonchoClient(url, apiKey, 10_000),
    autoFlush: false,
    onAlert: () => {},
    retry: {
      baseDelayMs: 100,
      maxDelayMs: 500,
      // A live instance that dies mid-drive must fail the slot, not retry
      // forever behind a test timeout that says nothing about why.
      signal: AbortSignal.timeout(60_000),
    },
  });
  try {
    await eye.ingest(records);
    await eye.flush();
    const pending = await eye.pendingCount();
    const listed = await honchoQuery<{ items: LiveMessage[] }>(
      apiKey,
      `/v3/workspaces/${encodeURIComponent(workspace)}/sessions/${encodeURIComponent(script.sessionId)}/messages/list`,
      {},
    );
    const { representation } = await honchoQuery<{ representation: string }>(
      apiKey,
      `/v3/workspaces/${encodeURIComponent(workspace)}/peers/johan/representation`,
      {},
    );
    return {
      messages: listed.items.map(({ content, peer_id }) => ({
        content,
        peer_id,
      })),
      pending,
      representation,
      script,
      url,
      workspace,
    };
  } finally {
    eye.close();
  }
}

/** The live instance's OWN peer filter, answered server-side. */
async function johanPeerMessages(
  apiKey: string,
  workspace: string,
  sessionId: string,
): Promise<LiveMessage[]> {
  const listed = await honchoQuery<{ items: LiveMessage[] }>(
    apiKey,
    `/v3/workspaces/${encodeURIComponent(workspace)}/sessions/${encodeURIComponent(sessionId)}/messages/list`,
    { filters: { peer_id: "johan" } },
  );
  return listed.items.map(({ content, peer_id }) => ({ content, peer_id }));
}

/** Every word the OTHER repo's session put into the world. */
function foreignWords(script: RepoScript): string[] {
  return [script.agentSays, script.dispatch, script.hermesSend, script.johanTypes];
}

export function liveHonchoIsolationScenario(
  options: HonchoIsolationOptions,
): ScenarioHandler {
  return async ({ assert, sandbox }) => {
    const { apiKey, gate } = options;
    // FIRST, and it is the anti-silent-pass property: no reachable instance
    // means this slot fails. It never falls back to `FixtureHoncho`.
    assert(
      gate.status === "run" && apiKey !== null,
      "a real Honcho instance is reachable — this slot never falls back to a fixture",
    );
    assert(sandbox.up.exitCode === 0, "primary sandbox was converged by argus up");

    const key = apiKey!;
    const driver = createFixtureProvenanceDriver();
    const peer = await sandbox.createPeer();
    const scratch: DrivenRepo[] = [];
    const clean = async (): Promise<void> => {
      while (scratch.length > 0) {
        const repo = scratch.pop()!;
        await removeScratchWorkspace(key, repo.workspace, [repo.script.sessionId]);
      }
    };

    try {
      assert(peer.up.exitCode === 0, "peer sandbox was converged by argus up");

      const primary = await driveRepo(sandbox, driver, PRIMARY, key);
      scratch.push(primary);
      const other = await driveRepo(peer, driver, OTHER, key);
      scratch.push(other);

      assert(
        primary.url === LIVE_HONCHO_URL && other.url === LIVE_HONCHO_URL,
        "each repo's own argus up binding points at the live Honcho instance",
      );
      assert(
        primary.pending === 0 && other.pending === 0,
        "production's Honcho eye delivered both repos' batches to the live instance",
      );
      assert(
        primary.workspace !== other.workspace,
        "the two repos bound different live Honcho workspaces",
      );

      // The live service's own peer filter — not an array this file owns.
      const johan = await johanPeerMessages(
        key,
        primary.workspace,
        PRIMARY.sessionId,
      );
      assert(
        JSON.stringify(johan.map(({ content }) => content)) ===
          JSON.stringify([PRIMARY.johanTypes]) &&
          johan.every(({ peer_id }) => peer_id === "johan"),
        "the live instance's peer filter returns exactly Johan's typed message",
      );
      const byPeer = (repo: DrivenRepo, peerId: string): string[] =>
        repo.messages
          .filter((message) => message.peer_id === peerId)
          .map(({ content }) => content);
      assert(
        byPeer(primary, "codex").includes(PRIMARY.agentSays) &&
          byPeer(primary, "hermes").includes(PRIMARY.hermesSend) &&
          !byPeer(primary, "johan").includes(PRIMARY.agentSays) &&
          !byPeer(primary, "johan").includes(PRIMARY.hermesSend),
        "the live instance keeps the agent decoy and the Hermes nudge off Johan's peer",
      );
      assert(
        primary.messages.length === 4 &&
          byPeer(primary, "johan").length === 1,
        "the live workspace holds exactly the four messages this repo's eye sent",
      );

      // Semantic isolation, as SPEC §13.9 states it: one repo's words are not
      // in the other repo's workspace, answered by the service.
      const contents = (repo: DrivenRepo): string =>
        repo.messages.map(({ content }) => content).join("\n");
      assert(
        foreignWords(OTHER).every((word) => !contents(primary).includes(word)),
        "the live primary workspace holds nothing authored in the peer repo",
      );
      assert(
        foreignWords(PRIMARY).every((word) => !contents(other).includes(word)),
        "the live peer workspace holds nothing authored in the primary repo",
      );

      // Queried and reported, never counted as proof of derivation — see the
      // docblock and `13.9.representation-johan-only`'s shortfall.
      console.log(
        [
          "",
          "live Honcho evidence:",
          `  primary workspace   ${primary.workspace}`,
          `  peer workspace      ${other.workspace}`,
          `  johan representation (primary): ${JSON.stringify(primary.representation)}`,
          `  johan representation (peer):    ${JSON.stringify(other.representation)}`,
        ].join("\n"),
      );
      assert(
        [...foreignWords(OTHER), PRIMARY.agentSays, PRIMARY.hermesSend].every(
          (word) => !primary.representation.includes(word),
        ),
        "the live Johan representation carries no other peer's or repo's words",
      );

      await clean();
      assert(
        scratch.length === 0,
        "the live instance accepted deletion of both scratch workspaces",
      );
    } finally {
      try {
        await clean();
      } catch (error) {
        console.error(
          `argus: scratch Honcho cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      await peer.teardown();
    }
  };
}

/**
 * The live rendering's own manifest. Additive, exactly as #74's journey slots
 * are: it never re-grades the fixture slot 9, and it never inherits slot 9's
 * structural coverage for anything this drive does not itself reach.
 */
export const HONCHO_ISOLATION_MANIFESTS: readonly LabeledScenarioManifest[] = [
  {
    // `honcho` is gone; `agent` and `brain` stay. See the docblock: no agent
    // is spawned here, so STRUCTURAL is the honest word and LIVE is not.
    doubles: ["agent", "brain"],
    number: "9-live",
    title: "Semantic isolation — real local Honcho instance (opt-in)",
    requirements: [
      {
        assertions: [
          "a real Honcho instance is reachable — this slot never falls back to a fixture",
          "each repo's own argus up binding points at the live Honcho instance",
          "production's Honcho eye delivered both repos' batches to the live instance",
          "the live workspace holds exactly the four messages this repo's eye sent",
          "the live instance accepted deletion of both scratch workspaces",
        ],
        id: "13.9.query-workspace",
        shortfall: "",
        spec: "query the repo's Honcho workspace",
      },
      {
        assertions: [
          "the live instance's peer filter returns exactly Johan's typed message",
          "the live instance keeps the agent decoy and the Hermes nudge off Johan's peer",
          "the live Johan representation carries no other peer's or repo's words",
        ],
        id: "13.9.representation-johan-only",
        shortfall:
          "what the live instance proves here is ATTRIBUTION and SCOPE — its own peer filter, over rows it stored — not DERIVATION. Honcho's Deriver waits for 512 tokens or 30 minutes, and this drive is four short messages per repo and deliberately stays under that threshold, so the representation it returns is empty. The endpoint is queried and printed rather than trusted, and an empty representation containing no foreign words is reported as what it is: not proof that a derived Johan representation excludes non-Johan content",
        spec: "the Johan representation derives only from Johan-authored messages",
      },
      {
        assertions: [
          "the two repos bound different live Honcho workspaces",
          "the live primary workspace holds nothing authored in the peer repo",
          "the live peer workspace holds nothing authored in the primary repo",
        ],
        id: "13.9.repo-isolation",
        shortfall:
          "two repos' words are now proven separate BY THE SERVICE rather than by an in-memory filter — but the two sandboxes still get different `HERMES_HOME`s and different basenames, so AUDIT.md §4 item 11's `argus-<basename>` collision between two same-named repos under one real HOME is still not exercised",
        spec: "query the repo's Honcho workspace [per-repo isolation]",
      },
      {
        assertions: [],
        id: "13.9.johan-representation-live-agent",
        shortfall:
          "UNCOVERED by design: the messages this slot stores are the fixture provenance driver's, classified by the real classifier. No live agent typed them, so no live session's words have ever been shown to route correctly on a real instance. Closing this needs a subscription call, which SPEC §13.9's property does not require and this slot does not spend",
        spec: "the Johan representation derives only from Johan-authored messages [from a live session]",
      },
    ],
  },
];

/** Grade one live-isolation report against the slot it renders. */
export function gradeHonchoIsolation(
  report: Parameters<typeof gradeScenario>[1],
): ScenarioGrade[] {
  return HONCHO_ISOLATION_MANIFESTS.map((manifest) =>
    gradeScenario(manifest, report),
  );
}
