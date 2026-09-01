import { mkdir, open } from "node:fs/promises";
import { join } from "node:path";

import { sha256Hex } from "../matching/hash.ts";

/** The immutable command and the exact ticket body it was parsed from. */
export interface DeclaredVerification {
  command: string;
  bodyHash: string;
}

export interface InvalidDeclaredVerification {
  status: "invalid";
  bodyHash: string;
  reason: string;
}

/** Write-once dispatch record for a ticket's verification contract. */
export interface VerificationDeclaration {
  ticket: string;
  bodyHash: string;
  command?: string;
  reason?: string;
}

export type DeclaredVerificationParse =
  | DeclaredVerification
  | InvalidDeclaredVerification;

function declarationDirectory(repo: string): string {
  return join(repo, ".argus", "dispatch", "verification");
}

function declarationPath(repo: string, ticket: string): string {
  const safe = ticket.replace(/^#/, "").replace(/[^A-Za-z0-9._-]+/g, "-");
  return join(declarationDirectory(repo), `ticket-${safe || "unnamed"}.json`);
}

function parseDeclaration(raw: unknown): VerificationDeclaration | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (
    typeof row.ticket !== "string" ||
    row.ticket === "" ||
    typeof row.bodyHash !== "string" ||
    row.bodyHash === ""
  ) {
    return null;
  }
  const command = typeof row.command === "string" && row.command !== "" ? row.command : undefined;
  const reason = typeof row.reason === "string" && row.reason !== "" ? row.reason : undefined;
  if ((command === undefined) === (reason === undefined)) return null;
  return command !== undefined
    ? { bodyHash: row.bodyHash, command, ticket: row.ticket }
    : { bodyHash: row.bodyHash, reason: reason!, ticket: row.ticket };
}

const VERIFICATION_HEADING = /^## Verification(?: command \(immutable\b[^)]*\))?\s*$/i;
const ANY_H2 = /^##\s+/;
const FENCE_START = /^```([^\r\n]*)$/;
const FENCE_END = /^```\s*$/;
const SAFE_TOKEN = /^[A-Za-z0-9_./:@+=,-]+$/;

function invalid(body: string, reason: string): InvalidDeclaredVerification {
  return { bodyHash: sha256Hex(body), reason, status: "invalid" };
}

/**
 * Read the one immutable verification section from a ticket body.
 *
 * The command is intentionally a small shell subset: argv-like words joined
 * by `&&`. This keeps the persisted string executable while refusing shell
 * expansion, redirection, pipelines, and nested shell evaluation.
 */
export function parseDeclaredVerification(body: string): DeclaredVerificationParse {
  const lines = body.split(/\r?\n/);
  const headings = lines.flatMap((line, index) =>
    VERIFICATION_HEADING.test(line) ? [index] : [],
  );
  if (headings.length === 0) {
    return invalid(body, "the ticket has no unambiguous ## Verification fenced command");
  }
  if (headings.length > 1) {
    return invalid(body, "the ticket has multiple ## Verification sections");
  }

  const start = headings[0]! + 1;
  const end = lines.findIndex((line, index) => index > start && ANY_H2.test(line));
  const section = lines.slice(start, end === -1 ? lines.length : end);
  const fences: Array<{ language: string; command: string }> = [];
  for (let index = 0; index < section.length; index += 1) {
    const match = section[index]!.match(FENCE_START);
    if (match === null) continue;
    const contents: string[] = [];
    let close = -1;
    for (let cursor = index + 1; cursor < section.length; cursor += 1) {
      if (FENCE_END.test(section[cursor]!)) {
        close = cursor;
        break;
      }
      contents.push(section[cursor]!);
    }
    if (close === -1) {
      return invalid(body, "the verification code fence is not closed");
    }
    fences.push({ command: contents.join("\n"), language: match[1]!.trim().toLowerCase() });
    index = close;
  }

  if (fences.length !== 1) {
    return invalid(
      body,
      fences.length === 0
        ? "the verification section must contain one fenced command"
        : "the verification section contains multiple fenced commands",
    );
  }
  const fence = fences[0]!;
  if (!["", "sh", "shell", "bash", "zsh"].includes(fence.language)) {
    return invalid(body, "the verification fence must use sh, shell, bash, or zsh");
  }

  const command = fence.command.trim();
  if (command === "") return invalid(body, "the verification command is empty");
  if (command.includes("\n") || command.includes("\r")) {
    return invalid(body, "the verification command may not contain shell newlines");
  }

  const segments = command.split("&&");
  if (segments.some((segment) => segment.trim() === "")) {
    return invalid(body, "the verification command contains an empty shell segment");
  }
  if (command.replaceAll("&&", "").includes("&")) {
    return invalid(body, "the verification command contains unsafe shell syntax");
  }
  if (/[`$|;><(){}[\]\\*!?~]/.test(command)) {
    return invalid(body, "the verification command contains shell-injection-prone syntax");
  }
  for (const segment of segments) {
    const words = segment.trim().split(/\s+/);
    if (words.length === 0 || words.some((word) => !SAFE_TOKEN.test(word))) {
      return invalid(body, "the verification command contains shell-injection-prone syntax");
    }
    if (["sh", "bash", "zsh", "env", "eval"].includes(words[0]!) && words[1] === "-c") {
      return invalid(body, "the verification command uses nested shell evaluation");
    }
  }

  return { bodyHash: sha256Hex(body), command };
}

export async function readVerificationDeclaration(
  repo: string,
  ticket: string,
): Promise<VerificationDeclaration | null> {
  try {
    return parseDeclaration(await Bun.file(declarationPath(repo, ticket)).json());
  } catch {
    return null;
  }
}

/**
 * Persist the first declaration seen at dispatch. A later call never replaces
 * it, even if the tracker body has changed.
 */
export async function recordVerificationDeclaration(
  repo: string,
  request: { ticket: string; body: string },
): Promise<VerificationDeclaration> {
  const existing = await readVerificationDeclaration(repo, request.ticket);
  if (existing !== null) return existing;

  const parsed = parseDeclaredVerification(request.body);
  const declaration: VerificationDeclaration = {
    bodyHash: parsed.bodyHash,
    ticket: request.ticket,
    ...( "status" in parsed
      ? { reason: parsed.reason }
      : { command: parsed.command }),
  };
  const path = declarationPath(repo, request.ticket);
  await mkdir(declarationDirectory(repo), { recursive: true });
  try {
    const file = await open(path, "wx");
    try {
      await file.write(`${JSON.stringify(declaration, null, 2)}\n`, undefined, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    return declaration;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      const won = await readVerificationDeclaration(repo, request.ticket);
      if (won !== null) return won;
    }
    throw error;
  }
}
