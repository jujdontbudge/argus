import { describe, expect, test } from "bun:test";

import {
  parseDeclaredVerification,
  readVerificationDeclaration,
  recordVerificationDeclaration,
  type DeclaredVerification,
} from "./verification.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BODY = [
  "## Outcome",
  "",
  "Ship the thing.",
  "",
  "## Verification",
  "",
  "```sh",
  "test -f result.txt && bun test src/feature.test.ts",
  "```",
].join("\n");

describe("parseDeclaredVerification", () => {
  test("parses the immutable verification command and hashes the exact body", () => {
    const result = parseDeclaredVerification(BODY);

    expect(result).toEqual<DeclaredVerification>({
      bodyHash: expect.any(String),
      command: "test -f result.txt && bun test src/feature.test.ts",
    });
    expect(result.bodyHash).toHaveLength(64);
    expect(parseDeclaredVerification(`${BODY}\n`)).not.toEqual(result);
  });

  test("accepts the named immutable heading variant", () => {
    const result = parseDeclaredVerification(
      BODY.replace("## Verification", "## Verification command (immutable — do not change)"),
    );

    expect("command" in result ? result.command : "").toBe(
      "test -f result.txt && bun test src/feature.test.ts",
    );
  });

  test.each([
    ["missing", "## Outcome\n\nNothing here."],
    ["ambiguous", `${BODY}\n\n${BODY}`],
    ["missing fence", "## Verification\n\nrun the tests"],
    ["multiple fences", "## Verification\n\n```sh\none\n```\n\n```sh\ntwo\n```"],
    ["wrong fence language", "## Verification\n\n```javascript\nprocess.exit(0)\n```"],
    ["empty command", "## Verification\n\n```sh\n\n```"],
  ])("refuses %s declarations", (_label, body) => {
    const result = parseDeclaredVerification(body);

    expect("status" in result && result.status).toBe("invalid");
    if ("status" in result) expect(result.reason).toBeTruthy();
  });

  test.each([
    "bun test; touch compromised.txt",
    "bun test | cat",
    "bun test $(touch compromised.txt)",
    "bun test > output.txt",
    "sh -c 'bun test'",
    "bun test\n touch compromised.txt",
  ])("refuses shell-injection-prone command %s", (command) => {
    const result = parseDeclaredVerification(
      `## Verification\n\n\`\`\`sh\n${command}\n\`\`\``,
    );

    expect("status" in result && result.status).toBe("invalid");
    if ("status" in result) expect(result.reason).toContain("shell");
  });
});

describe("verification declaration records", () => {
  test("persist the exact command and refuse to overwrite it after dispatch", async () => {
    const repo = await mkdtemp(join(tmpdir(), "argus-verification-"));
    try {
      const first = await recordVerificationDeclaration(repo, {
        body: BODY,
        ticket: "141",
      });
      const second = await recordVerificationDeclaration(repo, {
        body: BODY.replace("result.txt", "changed.txt"),
        ticket: "141",
      });

      expect(first).toEqual({
        bodyHash: expect.any(String),
        command: "test -f result.txt && bun test src/feature.test.ts",
        ticket: "141",
      });
      expect(second).toEqual(first);
      expect(await readVerificationDeclaration(repo, "141")).toEqual(first);
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });

  test("persist an actionable refusal for a missing declaration", async () => {
    const repo = await mkdtemp(join(tmpdir(), "argus-verification-"));
    try {
      const record = await recordVerificationDeclaration(repo, {
        body: "## Outcome\n\nNo command.",
        ticket: "142",
      });

      expect(record).toMatchObject({
        bodyHash: expect.any(String),
        reason: expect.stringContaining("no unambiguous"),
        ticket: "142",
      });
    } finally {
      await rm(repo, { force: true, recursive: true });
    }
  });
});
