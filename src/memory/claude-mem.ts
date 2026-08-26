import { constants, Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdir, readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { applyFindings } from "../eyes/reviewer/outputs";

const TABLES = ["observations", "session_summaries", "user_prompts"] as const;
type SourceTable = (typeof TABLES)[number];

export type ClaudeMemProvenance = "agent-derived" | "unverified-user-role";
export type ClaudeMemClassification = "candidate" | "review-required" | "skip";

export interface ClaudeMemPlanEntry {
  id: string;
  source: {
    table: SourceTable;
    rowId: string;
    project: string | null;
    createdAt: string | null;
  };
  provenance: ClaudeMemProvenance;
  classification: ClaudeMemClassification;
  decision: "review" | "skip" | "import";
  destinationStore: "MEMORY.md";
  destinationRepo: string | null;
  slug: string;
  title: string;
  content: string;
  reason: string;
}

export interface ClaudeMemPlan {
  schemaVersion: 1;
  kind: "argus.claude-mem-retirement-plan";
  id: string;
  createdAt: string;
  source: {
    database: string;
    sha256: string;
    size: number;
    tables: Record<SourceTable, number>;
  };
  entries: ClaudeMemPlanEntry[];
  approval: null | { digest: string; approvedAt: string };
}

type SqliteRow = Record<string, unknown>;

function readOnlyUri(file: string): string {
  return `${pathToFileURL(file).href}?mode=ro&immutable=0`;
}

function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function rowId(row: SqliteRow): string {
  const id = row.id;
  return typeof id === "number" || typeof id === "string" ? String(id) : "unknown";
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
}

function firstLine(value: string): string {
  const line = value.replace(/\s+/g, " ").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
}

function sourceFields(row: SqliteRow): {
  project: string | null;
  createdAt: string | null;
} {
  return {
    project: text(row.project) ?? text(row.cwd),
    createdAt: text(row.created_at),
  };
}

function observationEntry(row: SqliteRow): ClaudeMemPlanEntry {
  const id = rowId(row);
  const fields = sourceFields(row);
  const kind = text(row.type) ?? "observation";
  const body =
    text(row.text) ??
    [text(row.title), text(row.subtitle), text(row.narrative), text(row.facts)]
      .filter((part): part is string => part !== null)
      .join("\n\n");
  const content = body.length > 0 ? body : "(empty observation)";
  const candidate = ["decision", "bugfix", "discovery"].includes(kind);
  return {
    id: `observations:${id}`,
    source: { table: "observations", rowId: id, ...fields },
    provenance: "agent-derived",
    classification: candidate ? "candidate" : "skip",
    decision: candidate ? "review" : "skip",
    destinationStore: "MEMORY.md",
    destinationRepo:
      fields.project !== null && isAbsolute(fields.project)
        ? resolve(fields.project)
        : null,
    slug: slug(`claude-mem-${kind}-${id}`),
    title: text(row.title) ?? `${kind}: ${firstLine(content)}`,
    content,
    reason: candidate
      ? `${kind} observations can contain hard-to-rediscover project facts; review before import`
      : `${kind} observations are normally recoverable from code or git history`,
  };
}

function summaryEntry(row: SqliteRow): ClaudeMemPlanEntry {
  const id = rowId(row);
  const fields = sourceFields(row);
  const durable = [
    ["Learned", text(row.learned)],
    ["Notes", text(row.notes)],
  ] as const;
  const context = [
    ["Request", text(row.request)],
    ["Investigated", text(row.investigated)],
    ["Completed", text(row.completed)],
    ["Next steps", text(row.next_steps)],
  ] as const;
  const sections = [...durable, ...context].flatMap(([label, value]) =>
    value === null ? [] : [`## ${label}\n\n${value}`],
  );
  const content = sections.length > 0 ? sections.join("\n\n") : "(empty summary)";
  const candidate = durable.some(([, value]) => value !== null);
  return {
    id: `session_summaries:${id}`,
    source: { table: "session_summaries", rowId: id, ...fields },
    provenance: "agent-derived",
    classification: candidate ? "candidate" : "skip",
    decision: candidate ? "review" : "skip",
    destinationStore: "MEMORY.md",
    destinationRepo:
      fields.project !== null && isAbsolute(fields.project)
        ? resolve(fields.project)
        : null,
    slug: slug(`claude-mem-summary-${id}`),
    title: `Session learning: ${firstLine(text(row.request) ?? content)}`,
    content,
    reason: candidate
      ? "the learned/notes fields may contain durable project facts; review before import"
      : "execution summaries without learned facts are normally stale session state",
  };
}

function promptEntry(row: SqliteRow): ClaudeMemPlanEntry {
  const id = rowId(row);
  const fields = sourceFields(row);
  const content = text(row.prompt_text) ?? "(empty prompt)";
  return {
    id: `user_prompts:${id}`,
    source: { table: "user_prompts", rowId: id, ...fields },
    provenance: "unverified-user-role",
    classification: "review-required",
    decision: "review",
    destinationStore: "MEMORY.md",
    destinationRepo:
      fields.project !== null && isAbsolute(fields.project)
        ? resolve(fields.project)
        : null,
    slug: slug(`claude-mem-prompt-${id}`),
    title: `Unverified user-role prompt: ${firstLine(content)}`,
    content,
    reason:
      "claude-mem user-role rows may include agent or system injections; provenance must be reviewed and they can only become project memory",
  };
}

function entriesFor(table: SourceTable, rows: SqliteRow[]): ClaudeMemPlanEntry[] {
  switch (table) {
    case "observations":
      return rows.map(observationEntry);
    case "session_summaries":
      return rows.map(summaryEntry);
    case "user_prompts":
      return rows.map(promptEntry);
  }
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function planDigest(plan: ClaudeMemPlan): string {
  return digest({ ...plan, approval: null });
}

async function readPlan(path: string): Promise<ClaudeMemPlan> {
  let raw: unknown;
  try {
    raw = await Bun.file(path).json();
  } catch (error) {
    throw new Error(
      `claude-mem plan: could not read ${path}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (typeof raw !== "object" || raw === null) {
    throw new Error("claude-mem plan: expected a JSON object");
  }
  const plan = raw as Partial<ClaudeMemPlan>;
  if (
    plan.kind !== "argus.claude-mem-retirement-plan" ||
    plan.schemaVersion !== 1 ||
    typeof plan.id !== "string" ||
    !Array.isArray(plan.entries)
  ) {
    throw new Error("claude-mem plan: unsupported or malformed plan artifact");
  }
  return plan as ClaudeMemPlan;
}

function assertOutputOutsideSource(source: string, output: string): void {
  const sourceDirectory = dirname(source);
  const fromSource = relative(sourceDirectory, output);
  if (fromSource === "" || (!fromSource.startsWith("..") && !isAbsolute(fromSource))) {
    throw new Error("claude-mem plan: --output must be outside the source store directory");
  }
}

export async function createClaudeMemPlan(options: {
  source: string;
  output: string;
  now?: () => Date;
}): Promise<ClaudeMemPlan> {
  const source = resolve(options.source);
  const output = resolve(options.output);
  assertOutputOutsideSource(source, output);
  const sourceBytes = await readFile(source);
  const sourceStat = await stat(source);
  const sourceSha = createHash("sha256").update(sourceBytes).digest("hex");
  const database = new Database(
    readOnlyUri(source),
    constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI,
  );
  try {
    const present = new Set(
      database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('observations', 'session_summaries', 'user_prompts')",
        )
        .all()
        .map(({ name }) => name),
    );
    const missing = TABLES.filter((table) => !present.has(table));
    if (missing.length > 0) {
      throw new Error(`claude-mem plan: source is missing table(s): ${missing.join(", ")}`);
    }
    const rows = Object.fromEntries(
      TABLES.map((table) => [
        table,
        database.query<SqliteRow, []>(`SELECT * FROM ${table} ORDER BY id`).all(),
      ]),
    ) as Record<SourceTable, SqliteRow[]>;
    const entries = TABLES.flatMap((table) => entriesFor(table, rows[table]));
    const plan: ClaudeMemPlan = {
      schemaVersion: 1,
      kind: "argus.claude-mem-retirement-plan",
      id: `claude-mem-${digest({ sourceSha, entries }).slice(0, 16)}`,
      createdAt: (options.now?.() ?? new Date()).toISOString(),
      source: {
        database: source,
        sha256: sourceSha,
        size: sourceStat.size,
        tables: {
          observations: rows.observations.length,
          session_summaries: rows.session_summaries.length,
          user_prompts: rows.user_prompts.length,
        },
      },
      entries,
      approval: null,
    };
    await mkdir(dirname(output), { recursive: true });
    await Bun.write(output, `${JSON.stringify(plan, null, 2)}\n`);
    return plan;
  } finally {
    database.close();
  }
}

export function summarizePlan(plan: ClaudeMemPlan): string {
  const counts = { candidate: 0, "review-required": 0, skip: 0 };
  for (const entry of plan.entries) counts[entry.classification] += 1;
  return (
    `${plan.entries.length} rows (${counts.candidate} candidates, ` +
    `${counts["review-required"]} review-required, ${counts.skip} skipped)`
  );
}

export async function approveClaudeMemPlan(options: {
  planPath: string;
  confirmation: string;
  now?: () => Date;
}): Promise<{ plan: ClaudeMemPlan; digest: string }> {
  const path = resolve(options.planPath);
  const plan = await readPlan(path);
  if (options.confirmation !== plan.id) {
    throw new Error(`claude-mem approve: confirmation must exactly match ${plan.id}`);
  }
  const approvedDigest = planDigest(plan);
  plan.approval = {
    digest: approvedDigest,
    approvedAt: (options.now?.() ?? new Date()).toISOString(),
  };
  await Bun.write(path, `${JSON.stringify(plan, null, 2)}\n`);
  return { plan, digest: approvedDigest };
}

function assertImportEntry(entry: ClaudeMemPlanEntry): void {
  if (entry.destinationStore !== "MEMORY.md") {
    throw new Error(
      `claude-mem import: ${entry.id} targets ${String(entry.destinationStore)}; only MEMORY.md is allowed`,
    );
  }
  if (
    entry.destinationRepo === null ||
    !isAbsolute(entry.destinationRepo)
  ) {
    throw new Error(
      `claude-mem import: ${entry.id} needs an absolute destinationRepo before approval`,
    );
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.slug)) {
    throw new Error(`claude-mem import: ${entry.id} has an unsafe slug`);
  }
  if (
    entry.provenance !== "agent-derived" &&
    entry.provenance !== "unverified-user-role"
  ) {
    throw new Error(`claude-mem import: ${entry.id} has unknown provenance`);
  }
  if (typeof entry.title !== "string" || typeof entry.content !== "string") {
    throw new Error(`claude-mem import: ${entry.id} has invalid content`);
  }
}

export interface ClaudeMemImportReceipt {
  schemaVersion: 1;
  kind: "argus.claude-mem-import-receipt";
  status: "complete";
  planId: string;
  planDigest: string;
  importedAt: string;
  imported: number;
  repos: string[];
}

export async function importClaudeMemPlan(options: {
  planPath: string;
  now?: () => Date;
}): Promise<{ receipt: ClaudeMemImportReceipt; receiptPath: string }> {
  const path = resolve(options.planPath);
  const plan = await readPlan(path);
  if (plan.approval === null) {
    throw new Error("claude-mem import: plan is not approved");
  }
  const currentDigest = planDigest(plan);
  if (plan.approval.digest !== currentDigest) {
    throw new Error(
      "claude-mem import: approved plan changed after approval; review and approve it again",
    );
  }

  const selected = plan.entries.filter(({ decision }) => decision === "import");
  const repos = new Set<string>();
  for (const entry of selected) {
    assertImportEntry(entry);
    const repo = resolve(entry.destinationRepo!);
    repos.add(repo);
    const provenance =
      `> Import provenance: ${entry.provenance}; ` +
      `source ${entry.source.table} row ${entry.source.rowId} in ${plan.source.database}.`;
    await applyFindings(
      {
        memoryDir: resolve(repo, ".argus/memory"),
        skillsDir: resolve(repo, ".argus/skills"),
        authorOf: () => undefined,
      },
      [
        {
          kind: "project-fact",
          slug: entry.slug,
          title: entry.title,
          content: `${provenance}\n\n${entry.content}`,
          sources: [],
        },
      ],
    );
  }

  const receipt: ClaudeMemImportReceipt = {
    schemaVersion: 1,
    kind: "argus.claude-mem-import-receipt",
    status: "complete",
    planId: plan.id,
    planDigest: currentDigest,
    importedAt: (options.now?.() ?? new Date()).toISOString(),
    imported: selected.length,
    repos: [...repos].sort(),
  };
  const receiptPath = `${path}.import.json`;
  await Bun.write(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
  return { receipt, receiptPath };
}

export async function retireClaudeMem(options: {
  planPath: string;
  confirmation: string;
}): Promise<{ sourceDatabase: string }> {
  const path = resolve(options.planPath);
  const plan = await readPlan(path);
  const requiredConfirmation = `uninstall-claude-mem:${plan.id}`;
  if (options.confirmation !== requiredConfirmation) {
    throw new Error(
      `claude-mem retire: confirmation must exactly match ${requiredConfirmation}`,
    );
  }
  if (plan.approval === null || plan.approval.digest !== planDigest(plan)) {
    throw new Error("claude-mem retire: plan is not currently approved");
  }

  const receiptPath = `${path}.import.json`;
  let receipt: unknown;
  try {
    receipt = await Bun.file(receiptPath).json();
  } catch {
    throw new Error(
      `claude-mem retire: complete import receipt required at ${receiptPath}`,
    );
  }
  if (
    typeof receipt !== "object" ||
    receipt === null ||
    (receipt as Partial<ClaudeMemImportReceipt>).kind !==
      "argus.claude-mem-import-receipt" ||
    (receipt as Partial<ClaudeMemImportReceipt>).status !== "complete" ||
    (receipt as Partial<ClaudeMemImportReceipt>).planId !== plan.id ||
    (receipt as Partial<ClaudeMemImportReceipt>).planDigest !== plan.approval.digest
  ) {
    throw new Error(
      `claude-mem retire: complete import receipt required at ${receiptPath}`,
    );
  }

  // This is the only destructive action in the migration. The explicit
  // --keep-data is intentional: retirement uninstalls the parallel writer,
  // while the reviewed SQLite source remains a recoverable archive.
  const child = Bun.spawn(
    [
      "claude",
      "plugin",
      "uninstall",
      "--keep-data",
      "--yes",
      "claude-mem@thedotmack",
    ],
    { stdin: "ignore", stderr: "pipe", stdout: "pipe" },
  );
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(
      `claude-mem retire: plugin uninstall failed (${exitCode}): ${(stderr || stdout).trim()}`,
    );
  }
  return { sourceDatabase: plan.source.database };
}
