/**
 * The record-shape canary (ticket #100, workstream G of #81).
 *
 * WHY THIS EXISTS. Every attribution bug this project has had came from an
 * agent CLI changing the shape of what it writes, and every one of them was
 * SILENT — the parser did not throw, something classified as the wrong thing,
 * and the first symptom was a wrong answer far away:
 *
 * - #36: codex-cli 0.149.1 began injecting `<recommended_plugins>` as a
 *   user-role rollout item. A user message in a registered session matching
 *   no logged send is a Johan takeover (§5), so a plugin catalogue was headed
 *   for USER.md and flipped `johan_touched` on every Codex session.
 * - #50: real Claude records carry a field nobody in this build had looked
 *   at — `origin: { kind }` — and carry `promptSource: "sdk"`, which the
 *   candidate allowlist {typed, queued} refused. Argus's own dispatcher works
 *   headlessly, so it lost the provenance of every worker it spawned.
 * - #78 (first): a Hermes bang-send lands VERBATIM headlessly. `!git log`
 *   becomes `<bash-input>git log</bash-input>` only in a TUI, and there is no
 *   TUI in `claude -p --resume`, so the send matched nothing and machine text
 *   read as Johan.
 * - #78 (second): codex-cli began packing TWO envelopes into ONE user-role
 *   item. The single-envelope filter opened on the first tag, looked for it
 *   at the end, found the other, returned null — so the whole injection read
 *   as a prompt nobody logged.
 *
 * WHAT THIS DETECTS, and the distinction the ticket turns on: **unknown**
 * shape, not known-bad shape. A canary that encodes those four cannot catch
 * the fifth. So the unit here is not "a bad field" but "a shape fact this
 * corpus has never exhibited" — a key we have never seen, a value we have
 * never seen on a field our parsers branch on, an envelope tag we have never
 * seen opening a user-role item, or an item that OPENS like an injection and
 * that the tree's own decomposer declines to decompose.
 *
 * WHERE THE CONTRACT COMES FROM. Not from a table authored here. #89's
 * `installed.ts` resolves the ACTIVE plugin install rather than globbing a
 * cache, and #97's dispatch reads a skill's invocation form off the SKILL.md
 * the session will actually load. One level down, that is: read the shape off
 * the records the CLIs actually write. `./baseline.json` is CAPTURED from
 * real transcripts by `scripts/shape/capture-baseline.ts` (read-only) and
 * stamped with the CLI versions it was captured under; it is a snapshot of
 * the thing, not a restatement of it.
 *
 * The one thing pinned by hand is `DECISION_BEARING` below — the field paths
 * OUR parsers branch on. That is safe to pin because it is a statement about
 * this repository's code, not about the CLI: it changes only when we change a
 * parser, never when a vendor ships. `contract.test.ts` holds it to that by
 * checking every listed path is actually read by the parser it names.
 */

import { syntheticEnvelopeTag } from "../../matching/candidates.ts";

export type ShapeSource = "claude-code" | "codex" | "hermes";

/**
 * The axes a record can drift along. `field` and `cli-version` are NOTICES —
 * the CLI is writing something we do not model, or is no longer the CLI the
 * baseline describes. The rest are DECISION-BEARING: they can change an
 * attribution verdict without changing anything a human would notice.
 */
export type ShapeDimension =
  | "field"
  | "value"
  | "envelope"
  | "undecomposable"
  | "cli-version"
  | "column";

export type ShapeSeverity = "decision-bearing" | "notice";

export interface ShapeFact {
  dimension: ShapeDimension;
  /** Where the fact sits: "" for the record root, else a dotted/qualified path. */
  path: string;
  /** The key name, the value, the envelope tag, the version, or the column. */
  token: string;
}

const NOTICE_DIMENSIONS: ReadonlySet<ShapeDimension> = new Set<ShapeDimension>([
  "field",
  "cli-version",
  "column",
]);

export function severityOf(dimension: ShapeDimension): ShapeSeverity {
  return NOTICE_DIMENSIONS.has(dimension) ? "notice" : "decision-bearing";
}

/** A fact's canonical string form — the unit the baseline stores and dedups on. */
export function factKey(fact: ShapeFact): string {
  return `${fact.dimension}|${fact.path}|${fact.token}`;
}

/**
 * The field paths our own parsers branch on, per source. Pinned here because
 * it describes THIS repository, not the vendors: see the module docblock.
 * `contract.test.ts` fails if a path listed here is not actually read by the
 * named parser, so the pin cannot rot into decoration.
 */
export const DECISION_BEARING: Readonly<Record<ShapeSource, readonly string[]>> = {
  "claude-code": ["type", "promptSource", "origin.kind", "message.role", "operation"],
  codex: ["type", "payload.type", "payload.role", "payload.content[].type"],
  hermes: ["role"],
};

type Rec = Record<string, unknown>;

function asRecord(value: unknown): Rec | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : null;
}

function fields(into: ShapeFact[], path: string, rec: Rec | null): void {
  if (rec === null) return;
  for (const key of Object.keys(rec)) into.push({ dimension: "field", path, token: key });
}

function value(into: ShapeFact[], path: string, raw: unknown): void {
  if (typeof raw === "string") into.push({ dimension: "value", path, token: raw });
}

/**
 * The first line of `text` read as a bare opening tag — the CHEAP, INDEPENDENT
 * probe. It deliberately does not agree with `syntheticEnvelopeTag`, which
 * decomposes the whole text: the two disagreeing is itself the #78 signal (an
 * item that opens like an injection but no longer decomposes as one).
 */
function opensLikeEnvelope(text: string): string | null {
  const trimmed = text.trimStart();
  const breakAt = trimmed.indexOf("\n");
  if (breakAt === -1) return null;
  const open = /^<([a-z][a-z0-9_-]*)>$/.exec(trimmed.slice(0, breakAt).trimEnd());
  return open ? open[1]! : null;
}

/**
 * How the tree currently decides an item IS an injection. Injectable so the
 * `undecomposable` claim can be TESTED rather than asserted: the shape #78
 * found (two envelopes packed into one item) decomposes fine under today's
 * chain rule, so the only honest way to show this dimension would have caught
 * it is to run it against the single-envelope decomposer that was live then.
 */
export type Decomposer = (text: string) => string | null;

function envelopeFacts(into: ShapeFact[], text: string, decompose: Decomposer): void {
  const tag = opensLikeEnvelope(text);
  if (tag === null) return;
  into.push({ dimension: "envelope", path: "user-text", token: tag });
  if (decompose(text) === null) {
    into.push({ dimension: "undecomposable", path: "user-text", token: tag });
  }
}

/** Every shape fact a parsed Claude Code transcript record exhibits. */
export function observeClaudeRecord(
  record: unknown,
  decompose: Decomposer = syntheticEnvelopeTag,
): ShapeFact[] {
  const rec = asRecord(record);
  if (rec === null) return [];
  const facts: ShapeFact[] = [];
  fields(facts, "", rec);
  const message = asRecord(rec.message);
  fields(facts, "message", message);
  const origin = asRecord(rec.origin);
  fields(facts, "origin", origin);
  value(facts, "type", rec.type);
  value(facts, "promptSource", rec.promptSource);
  value(facts, "origin.kind", origin?.kind);
  value(facts, "message.role", message?.role);
  value(facts, "operation", rec.operation);
  if (typeof rec.version === "string") {
    facts.push({ dimension: "cli-version", path: "", token: rec.version });
  }
  if (rec.type === "user" && message !== null && typeof message.content === "string") {
    envelopeFacts(facts, message.content, decompose);
  }
  return facts;
}

/** Every shape fact a parsed Codex rollout record exhibits. */
export function observeCodexRecord(
  record: unknown,
  decompose: Decomposer = syntheticEnvelopeTag,
): ShapeFact[] {
  const rec = asRecord(record);
  if (rec === null) return [];
  const facts: ShapeFact[] = [];
  fields(facts, "", rec);
  value(facts, "type", rec.type);
  const payload = asRecord(rec.payload);
  // Payload keys are qualified by the record type: a rollout's `session_meta`
  // and `response_item` payloads share no fields, and merging them would make
  // every key look familiar everywhere.
  const kind = typeof rec.type === "string" ? rec.type : "?";
  fields(facts, `payload:${kind}`, payload);
  value(facts, "payload.type", payload?.type);
  value(facts, "payload.role", payload?.role);
  if (typeof payload?.cli_version === "string") {
    facts.push({ dimension: "cli-version", path: "", token: payload.cli_version });
  }
  const content = payload?.content;
  if (Array.isArray(content)) {
    const texts: string[] = [];
    for (const item of content) {
      const part = asRecord(item);
      if (part === null) continue;
      value(facts, "payload.content[].type", part.type);
      fields(facts, `payload.content[]:${String(part.type)}`, part);
      if (part.type === "input_text" && typeof part.text === "string") texts.push(part.text);
    }
    if (payload?.role === "user" && texts.length > 0) {
      envelopeFacts(facts, texts.join("\n"), decompose);
    }
  }
  return facts;
}

/** Shape facts for one Hermes message row as the reader hands it over. */
export function observeHermesRow(
  row: unknown,
  decompose: Decomposer = syntheticEnvelopeTag,
): ShapeFact[] {
  const rec = asRecord(row);
  if (rec === null) return [];
  const facts: ShapeFact[] = [];
  fields(facts, "", rec);
  value(facts, "role", rec.role);
  if (typeof rec.content === "string") envelopeFacts(facts, rec.content, decompose);
  return facts;
}

/**
 * Hermes's contract is a DATABASE SCHEMA, not a JSON record, so it is read off
 * the database itself: the columns the two tables actually have, and the role
 * values the corpus actually contains. This is the closest analogue in the
 * tree to #89 reading the active install — a schema this code did not author
 * and cannot restate safely, because the reader's `SELECT` filters
 * `role IN ('user','assistant')` at the SQL level, so a THIRD role would never
 * reach the parser to be noticed there.
 */
export function hermesSchemaFacts(
  columns: Readonly<Record<string, readonly string[]>>,
  roles: readonly string[],
): ShapeFact[] {
  const facts: ShapeFact[] = [];
  for (const [table, names] of Object.entries(columns)) {
    for (const name of names) facts.push({ dimension: "column", path: table, token: name });
  }
  for (const role of roles) facts.push({ dimension: "value", path: "role", token: role });
  return facts;
}

export function observe(
  source: ShapeSource,
  record: unknown,
  decompose: Decomposer = syntheticEnvelopeTag,
): ShapeFact[] {
  if (source === "claude-code") return observeClaudeRecord(record, decompose);
  if (source === "codex") return observeCodexRecord(record, decompose);
  return observeHermesRow(record, decompose);
}

/** The captured contract: what each source's records have ever been seen doing. */
export interface ShapeBaseline {
  capturedAt: string;
  /** CLI versions the corpus was written by, per source — evidence, and a signal. */
  versions: Record<string, readonly string[]>;
  /** Corpus size per source, so a thin baseline cannot masquerade as a broad one. */
  corpus: Record<string, { files: number; records: number }>;
  /** `factKey()` strings, sorted, per source. */
  facts: Record<string, readonly string[]>;
}

export interface ShapeDrift extends ShapeFact {
  source: ShapeSource;
  severity: ShapeSeverity;
  /** Readable, operator-facing: what drifted and what it may cost. */
  reason: string;
}

const REASONS: Readonly<Record<ShapeDimension, string>> = {
  field: "a field this record shape has never carried",
  value: "a value never seen on a field the parser branches on",
  envelope: "a user-role item opens with an envelope tag never seen before",
  undecomposable:
    "a user-role item opens like a CLI injection but no longer decomposes as one",
  "cli-version": "records are being written by a CLI version the contract was not captured from",
  column: "a table column the captured schema did not have",
};

/**
 * The facts in `observed` that the baseline has never seen. This is the whole
 * canary: set difference, not a rule list — which is why it does not need to
 * know what the fifth bug will look like.
 */
export function driftFrom(
  baseline: ShapeBaseline,
  source: ShapeSource,
  observed: readonly ShapeFact[],
): ShapeDrift[] {
  const known = new Set(baseline.facts[source] ?? []);
  const drift: ShapeDrift[] = [];
  const emitted = new Set<string>();
  for (const fact of observed) {
    const key = factKey(fact);
    if (known.has(key) || emitted.has(key)) continue;
    emitted.add(key);
    drift.push({
      ...fact,
      source,
      severity: severityOf(fact.dimension),
      reason: REASONS[fact.dimension],
    });
  }
  return drift;
}
