#!/usr/bin/env bun

import { runCodexNotify } from "../src/events/index.ts";

await runCodexNotify(process.argv[2]);
