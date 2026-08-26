/**
 * Ticket #54: build the FIXED evaluation set by driving the PRODUCTION eyes.
 *
 * The prompts are not hand-rolled. A recording `Brain` is handed to the real
 * `ReviewerEye` / `DigestEye`, which builds and sends its own prompt and its
 * own `--output-schema`; we capture exactly those bytes. The Retro drift case
 * uses the exported `buildDriftPrompt` + `DRIFT_OUTPUT_SCHEMA`, which is the
 * same pair `RetroEye.judgeDrift` hands to `brain.evaluate` (retro.ts:632).
 *
 * Output: cases/<id>.json — {id, eye, prompt, schema, cwd, groundTruth}.
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Brain, BrainRequest } from "../../../../src/eyes/brain";
import type { BrainCap } from "../../../../src/eyes/cap";
import { DigestEye } from "../../../../src/eyes/digest/digest";
import {
  buildDriftPrompt,
  type DriftCandidate,
  type DriftQuestion,
} from "../../../../src/eyes/retro/drift";
import { DRIFT_OUTPUT_SCHEMA } from "../../../../src/eyes/retro/schema";
import { ReviewerEye } from "../../../../src/eyes/reviewer/reviewer";
import type { ProvenanceRecord } from "../../../../src/provenance";
import { TURNS, type Turn } from "./corpus";

export const CASES_DIR = new URL("../cases/", import.meta.url).pathname;

const NO_CAP: BrainCap = { acquire: async () => async () => {} };

/** Captures the prompt+schema the production eye builds, answers trivially. */
function recordingBrain(sink: { request?: BrainRequest }, reply: string): Brain {
  return {
    async evaluate(request) {
      sink.request = request;
      return { ok: true, text: reply };
    },
  };
}

export function record(t: Turn): ProvenanceRecord {
  return {
    sessionId: t.session,
    author: t.author,
    via: t.author === "johan" ? "typed" : "agent",
    registered: t.author !== "johan",
    startedBy: t.author === "johan" ? "johan" : "hermes",
    johanTouched: t.author === "johan",
    ts: t.ts,
    text: t.text,
    event: {
      type: "message",
      sessionId: t.session,
      role: t.role,
      text: t.text,
      ts: t.ts,
      uuid: t.uuid,
      candidate: t.role === "user",
      file: `/Users/johansardar/.claude/projects/-Users-johansardar-argus/${t.session}.jsonl`,
    },
  } as ProvenanceRecord;
}

async function scratchRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "t54-case-"));
  await mkdir(join(dir, ".argus"), { recursive: true });
  return dir;
}

/** Drive the real ReviewerEye once and return the prompt/schema it sent. */
export async function reviewerPrompt(
  keys: (keyof typeof TURNS)[],
): Promise<BrainRequest> {
  const repo = await scratchRepo();
  const sink: { request?: BrainRequest } = {};
  const open = (now: number): Promise<ReviewerEye> =>
    ReviewerEye.open({
      repo,
      brain: recordingBrain(sink, JSON.stringify({ findings: [] })),
      cap: NO_CAP,
      cadence: { quietWindowSeconds: 1, maxWaitSeconds: 1 },
      now: () => now,
    });
  const eye = await open(0);
  await eye.ingest(keys.map((k) => record(TURNS[k]!)));
  // Re-open past the quiet window so the persisted batch fires immediately.
  await (await open(10_000)).tick();
  await rm(repo, { force: true, recursive: true });
  if (sink.request === undefined) throw new Error("reviewer never called the brain");
  return sink.request;
}

export async function digestPrompt(
  keys: (keyof typeof TURNS)[],
): Promise<BrainRequest> {
  const repo = await scratchRepo();
  const sink: { request?: BrainRequest } = {};
  const open = (now: number): Promise<DigestEye> =>
    DigestEye.open({
      repo,
      brain: recordingBrain(sink, JSON.stringify({ sessions: [] })),
      cap: NO_CAP,
      cadence: { quietWindowSeconds: 1, maxWaitSeconds: 1 },
      sessions: async () => [],
      now: () => now,
    });
  const eye = await open(0);
  await eye.ingest(keys.map((k) => record(TURNS[k]!)));
  await (await open(10_000)).tick();
  await rm(repo, { force: true, recursive: true });
  if (sink.request === undefined) throw new Error("digest never called the brain");
  return sink.request;
}

export interface DriftCommitSpec {
  sha: string;
  subject: string;
  body: string;
  files: string[];
  diff: string;
}

export interface DriftCaseSpec {
  candidateId: string;
  ticket: string;
  ticketTitle: string;
  ticketBody: string;
  commits: DriftCommitSpec[];
}

export function driftPrompt(specs: DriftCaseSpec[]): BrainRequest {
  const questions: DriftQuestion[] = specs.map((spec) => {
    const candidate: DriftCandidate = {
      id: spec.candidateId,
      ticket: spec.ticket,
      repoRoot: "/Users/johansardar/argus",
      sessionIds: ["603b50b3-f6c2-4de4-b17d-aebb1ae33b81"],
      work: [
        {
          dir: "/Users/johansardar/argus-worktrees/w",
          commits: spec.commits.map((c) => ({
            sha: c.sha,
            // Required by GitCommit but never read by buildDriftPrompt,
            // which uses only sha/subject/files/diff.
            authorName: "author",
            authorEmail: "author@example.invalid",
            ts: "2026-08-25T20:00:00Z",
            subject: c.subject,
            body: c.body,
            files: c.files,
            diff: c.diff,
          })),
          workingTree: null,
        },
      ],
    };
    return {
      candidate,
      scope: {
        number: spec.ticket,
        title: spec.ticketTitle,
        body: spec.ticketBody,
        state: "closed" as const,
      },
    };
  });
  return {
    prompt: buildDriftPrompt(questions),
    schema: DRIFT_OUTPUT_SCHEMA as unknown as object,
    cwd: "/Users/johansardar/argus-worktrees/brain-tiers",
  };
}

export interface EvalCase {
  id: string;
  eye: "reviewer" | "skills" | "digest" | "retro-drift";
  what: string;
  prompt: string;
  schema: object;
  cwd: string;
  groundTruth: unknown;
}

export async function writeCase(c: EvalCase): Promise<void> {
  await mkdir(CASES_DIR, { recursive: true });
  await writeFile(join(CASES_DIR, `${c.id}.json`), `${JSON.stringify(c, null, 2)}\n`);
}
