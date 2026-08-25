/** Fixture-driven SPEC §13 archiver halves for scenarios 1 and 6. */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  ScenarioHandler,
  ScenarioRegistry,
} from "../../harness/index.ts";
import { ProvenanceClassifier } from "../../provenance";
import { createClaudeCodeSource, Tailer } from "../../tailing";
import { ArchiverEye } from "./archiver";

const SESSION = "archiver-fixture-session";
const DISPATCH = "Autonomously archive this batch.";
const T0 = "2026-08-24T14:00:00.000Z";

function messageLine(
  uuid: string,
  role: "user" | "assistant",
  text: string,
  ts: string,
): string {
  return `${JSON.stringify({
    type: role,
    message:
      role === "user"
        ? { role, content: text }
        : { role, content: [{ type: "text", text }] },
    timestamp: ts,
    ...(role === "user" && { promptSource: "typed" }),
    uuid,
    sessionId: SESSION,
    cwd: "/tmp/argus-harness",
    version: "2.1.241",
    isSidechain: false,
  })}\n`;
}

function classifier(): ProvenanceClassifier {
  const value = new ProvenanceClassifier();
  value.registerSession({
    ts: T0,
    sessionId: SESSION,
    agent: "codex",
    ticket: "26",
    dispatchPrompt: DISPATCH,
  });
  return value;
}

async function transcriptFixture(root: string): Promise<{
  file: string;
  source: ReturnType<typeof createClaudeCodeSource>;
}> {
  const directory = join(root, "transcripts");
  const file = join(directory, `${SESSION}.jsonl`);
  await mkdir(directory, { recursive: true });
  await writeFile(
    file,
    messageLine("fixture-u-1", "user", DISPATCH, T0) +
      messageLine(
        "fixture-a-1",
        "assistant",
        "The autonomous batch is running.",
        "2026-08-24T14:01:00.000Z",
      ),
  );
  return { file, source: createClaudeCodeSource({ dir: directory }) };
}

/** §13 scenario 1 archiver half — passive archive grows during the batch. */
export const archiveAutonomousBatchScenario: ScenarioHandler = async ({
  assert,
  sandbox,
}) => {
  const { source } = await transcriptFixture(sandbox.root);
  const eye = await ArchiverEye.open({ repo: sandbox.repo });
  try {
    const before = eye.messageCount();
    const batch = await eye.catchUp(new Tailer(source), classifier());
    assert(
      batch.received === 2 && batch.inserted === 2,
      "every autonomous-batch message reached the archive",
    );
    assert(
      eye.messageCount() > before,
      "archive grew during the autonomous batch",
    );
  } finally {
    eye.close();
  }
};

/**
 * §13 scenario 6 archiver half — simulate SIGKILL after Tailer.catchUp has
 * advanced only its in-memory cursor, before the archive transaction begins.
 */
export const archiverWatcherDeathScenario: ScenarioHandler = async ({
  assert,
  sandbox,
}) => {
  const { file, source } = await transcriptFixture(sandbox.root);
  let eye = await ArchiverEye.open({ repo: sandbox.repo });
  const initial = await eye.catchUp(new Tailer(source), classifier());
  assert(
    initial.inserted === 2 && eye.messageCount() === 2,
    "two messages committed before watcher death",
  );

  await appendFile(
    file,
    messageLine(
      "fixture-a-2",
      "assistant",
      "This message arrived while the watcher was dying.",
      "2026-08-24T14:02:00.000Z",
    ) +
      messageLine(
        "fixture-u-2",
        "user",
        "Backfill this exact message too.",
        "2026-08-24T14:03:00.000Z",
      ),
  );

  // The doomed process reads both lines, then is killed: no eye transaction.
  const doomed = new Tailer(source, { cursors: eye.cursors() });
  const uncommitted = await doomed.catchUp();
  assert(
    uncommitted.filter(({ type }) => type === "message").length === 2,
    "the killed batch contained two uncommitted messages",
  );
  eye.close();

  eye = await ArchiverEye.open({ repo: sandbox.repo });
  try {
    const backfill = await eye.catchUp(
      new Tailer(source, { cursors: eye.cursors() }),
      classifier(),
    );
    const replay = await eye.catchUp(new Tailer(source), classifier());
    assert(
      backfill.received === 2 &&
        backfill.inserted === 2 &&
        replay.received === 4 &&
        replay.inserted === 0 &&
        eye.messageCount() === 4,
      "kill-before-commit backfill has the exact message count with no duplicates",
    );
  } finally {
    eye.close();
  }
};

function extend(
  registry: ScenarioRegistry,
  number: 1 | 6,
  archiverHalf: ScenarioHandler,
): void {
  const existing = registry.get(number);
  registry.register(number, async (context) => {
    if (existing !== undefined) await existing(context);
    await archiverHalf(context);
  });
}

/** Add the archiver assertions without replacing other tickets' scenario halves. */
export function registerArchiverScenarios(registry: ScenarioRegistry): void {
  extend(registry, 1, archiveAutonomousBatchScenario);
  extend(registry, 6, archiverWatcherDeathScenario);
}
