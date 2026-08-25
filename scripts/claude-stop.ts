#!/usr/bin/env bun

import { runClaudeStop } from "../src/events/index.ts";

await runClaudeStop(await Bun.stdin.text());
