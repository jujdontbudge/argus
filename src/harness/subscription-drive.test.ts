import { expect, test } from "bun:test";
import { appendFile, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadScaledMs } from "../eyes/test-budget.ts";
import {
  classifierFromRegistry,
  loadRegistry,
  registryPaths,
  type ProvenanceRecord,
} from "../provenance/index.ts";
import {
  claudeProjectDir,
  createClaudeCodeSource,
  Tailer,
  type MessageEvent,
  type SessionMetaEvent,
} from "../tailing/index.ts";
import { createSandbox } from "./index.ts";
import { liveHalfTitle } from "./live-gate.ts";
import {
  describeSubscriptionGate,
  NATIVE_CLAUDE,
  probeSubscriptionMode,
  resolveSubscriptionGate,
} from "./subscription-gate.ts";
import { createSubscriptionAgentSpawner } from "./subscription-mode.ts";

/**
 * Ticket #49 — the §13 Claude drive that does not need a token.
 *
 * `src/tailing/claude-code.ts` had never met a real Opus 5 transcript. #41's
 * hermetic seam could not give it one without a `CLAUDE_CODE_OAUTH_TOKEN`
 * nobody had provisioned, and the escalation to a scratch HOME that made the
 * token necessary was never the directive: §13's original isolation was
 * REPO-level. This drive restores that reading — a normal terminal Claude
 * session, real HOME so subscription auth simply works, `cwd` pointed at the
 * throwaway sandbox so the transcript lands under its own slug.
 *
 * Isolation here is SCRIPTED SCOPE, not an OS boundary, and that is stated in
 * SPEC §13 rather than implied. The session is asked for one sentence of
 * benign work with no tools; every destructive step in the harness goes
 * through `SandboxScope`, which `sandbox-scope.test.ts` proves refuses paths
 * and pids outside the sandbox.
 *
 * AMENDED BY #50. This drive is where `promptSource: "sdk"` was found, and it
 * pinned the defect so it could not regress unnoticed while the policy ticket
 * ran. That ticket has run: the drive now registers the dispatch it sends —
 * which is what #43's drives always did, and what makes the §13.4 assertion
 * below mean something — and pins the FIXED verdict on the same real shape.
 */
const checkout = fileURLToPath(new URL("../../", import.meta.url));
const gate = resolveSubscriptionGate(probeSubscriptionMode());

console.log(describeSubscriptionGate(gate));

const LIVE_BUDGET_MS = loadScaledMs(300_000, 900_000);

/** One sentence, no tools, no writes. "Benign scripted work only", literally. */
const DISPATCH =
  "You are working ticket #49. Reply with exactly the word ACKNOWLEDGED and " +
  "nothing else. Do not run any commands and do not write any files.";

test.skipIf(gate.claude.status !== "run")(
  liveHalfTitle(
    "§13 subscription drive: a real Claude Opus 5 session, real HOME, no token",
    gate.claude,
  ),
  async () => {
    const sandbox = await createSandbox({ checkout });
    const projects = join(homedir(), ".claude/projects");

    try {
      const worktree = await sandbox.createWorktree("live-subscription");
      const realWorktree = await realpath(worktree);
      const slug = claudeProjectDir(realWorktree, projects);

      const result = await createSubscriptionAgentSpawner({
        // The native install by name. Several `claude` shims are ahead of it
        // on PATH here, one of which is the `claude-api1` launcher #36
        // measured hanging without ever producing an assistant turn.
        executables: { claude: NATIVE_CLAUDE },
        scope: sandbox.scope,
      }).spawn({
        agent: "claude",
        command: ["claude", "-p", DISPATCH, "--model", "claude-opus-5"],
        cwd: worktree,
        env: sandbox.env,
        tab: `argus-test-${sandbox.id}-claude-subscription`,
      });

      expect({ exitCode: result.exitCode, stderr: result.stderr?.slice(-400) })
        .toEqual({ exitCode: 0, stderr: result.stderr?.slice(-400) });

      // ITS OWN SLUG. The sandbox cwd is what keeps a subscription session
      // out of every other project's transcripts, so this is the assertion
      // that the containment actually happened.
      const written = (await readdir(slug)).filter((name) => name.endsWith(".jsonl"));
      expect(written.length).toBeGreaterThan(0);

      const events = await new Tailer(
        createClaudeCodeSource({ dir: slug }),
      ).catchUp();

      const metas = events.filter(
        (event): event is SessionMetaEvent => event.type === "session-meta",
      );
      // Evidence, printed: this is the first real Opus transcript this source
      // has ever read, so the drive reports its shape rather than only its
      // verdict. `bun test` shows this above the result.
      console.log(
        `argus #49 drive: ${events.length} events from ${written.length} live transcript(s) — ` +
          JSON.stringify({
            recordTypes: [...new Set(events.map((event) => event.type))].sort(),
            metas: metas.map(({ cwd, repo, version }) => ({ cwd, repo, version })),
          }),
      );

      // §7.3 on a REAL transcript for the first time. The cwd half is what
      // #49 had to fix the parser to make meaningful at all: a real session
      // opens with cwd-less `queue-operation` records, and the old latch
      // emitted a cwd-less meta and then suppressed the real one forever.
      expect(metas.map(({ cwd }) => cwd)).toContain(realWorktree);
      expect(metas.every((meta) => meta.cwd !== undefined)).toBe(true);

      // The OTHER half of §7.3/#22 is missing, and the drive pins that rather
      // than implying coverage: `repo` — the worktree-to-parent-repo mapping
      // the Codex source resolves in `repositoryFor` — is never resolved by
      // the Claude source at all. Not a wrong answer, a feature this source
      // has never had; visible only now that a real session in a real
      // worktree has been read. It needs its own ticket and its own scenario
      // grading, so here it is asserted as the KNOWN gap it is.
      expect(metas.every((meta) => meta.repo === undefined)).toBe(true);

      const messages = events.filter(
        (event): event is MessageEvent => event.type === "message",
      );
      const dispatched = messages.find((message) =>
        message.text.includes("ticket #49"),
      );
      expect(dispatched).toBeDefined();
      expect(
        messages.some(
          (message) =>
            message.role === "assistant" && message.text.includes("ACKNOWLEDGED"),
        ),
      ).toBe(true);

      // #50: what Hermes would have logged before opening the session (§5
      // rule 1). #49's version of this drive registered NOTHING, which made
      // its §13.4 assertion below pass for the wrong reason — the dispatch was
      // dropped as a non-candidate, so there was nothing left to attribute to
      // anyone. The harness is playing Hermes here exactly as it does in #43's
      // drives, so it logs the row Hermes logs.
      const { sessionsFile } = registryPaths(sandbox.repo);
      await mkdir(dirname(sessionsFile), { recursive: true });
      await appendFile(
        sessionsFile,
        `${JSON.stringify({
          ts: dispatched!.ts,
          sessionId: dispatched!.sessionId,
          agent: "claude",
          ticket: "49",
          dispatchPrompt: DISPATCH,
          workspace: worktree,
        })}\n`,
      );

      const { classifier } = classifierFromRegistry(
        await loadRegistry(registryPaths(sandbox.repo)),
      );
      const records: ProvenanceRecord[] = [];
      for (const event of events) {
        const { record } = classifier.handle(event);
        if (record) records.push(record);
      }

      // §13.4, and the invariant that matters most: the class of bug #36
      // found the first time a live agent met this system was a CLI's own
      // injected user-role content classifying as Johan. On a real Opus
      // transcript, nothing does.
      expect(
        records
          .filter((record) => record.author === "johan")
          .map((record) => record.event.text.slice(0, 120)),
      ).toEqual([]);

      // #49 FOUND the finding here and pinned it as the defect it was: a real
      // `claude -p` prompt carries `promptSource: "sdk"`, which was neither
      // "typed" nor "queued", so the candidate filter dropped it and the
      // dispatch landed `system`/`non-candidate` instead of
      // `hermes`/`dispatch-prompt`. #50 FIXED it, so the pin now asserts the
      // fix on the same real shape rather than the defect — same live
      // evidence, opposite verdict, and still the only assertion in this tree
      // that reads a genuinely headless transcript end to end.
      expect(dispatched!.promptSource).toBe("sdk");
      expect(dispatched!.candidate).toBe(true);
      expect(
        records
          .filter((record) => record.event === dispatched)
          .map(({ author, via }) => ({ author, via })),
      ).toEqual([{ author: "hermes", via: "dispatch-prompt" }]);

      // And the raw record behind it, because `MessageEvent` does not carry
      // `origin` and the fix turns on it: a real 2.1.246 headless dispatch
      // prompt carries NO `origin` at all, while the CLI's own injected
      // user-role records carry `origin.kind`. If a future CLI starts
      // stamping dispatch prompts with an origin kind, this is where that
      // shows up — before it can quietly make Argus deaf again.
      const lines = (
        await Promise.all(
          written.map((name) => readFile(join(slug, name), "utf8")),
        )
      ).flatMap((text) => text.split("\n").filter((line) => line.trim() !== ""));
      const raw = lines
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .find(
          (record) =>
            record.type === "user" &&
            typeof (record.message as { content?: unknown })?.content === "string" &&
            ((record.message as { content: string }).content).includes("ticket #49"),
        );
      expect({
        promptSource: raw?.promptSource,
        entrypoint: raw?.entrypoint,
        origin: raw?.origin,
      }).toEqual({ promptSource: "sdk", entrypoint: "sdk-cli", origin: undefined });
    } finally {
      await sandbox.teardown();
    }
  },
  LIVE_BUDGET_MS,
);
