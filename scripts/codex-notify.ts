#!/usr/bin/env bun

import { runCodexNotify } from "../src/events/index.ts";

let payload = process.argv[2];
let delegate: string[] | null = null;
if (payload === "--delegate") {
  const encoded = process.argv[3];
  payload = process.argv[4];
  try {
    const parsed = JSON.parse(Buffer.from(encoded ?? "", "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || !parsed.every((part) => typeof part === "string")) {
      throw new Error("delegate is not a string array");
    }
    delegate = parsed;
  } catch (error) {
    console.error(
      `argus codex notify: invalid delegate: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    process.exitCode = 1;
  }
}

await runCodexNotify(payload);
if (delegate && delegate.length > 0 && payload !== undefined) {
  const child = Bun.spawn([...delegate, payload], {
    cwd: process.cwd(),
    env: Bun.env,
    stderr: "inherit",
    stdout: "inherit",
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) process.exitCode = exitCode;
}
