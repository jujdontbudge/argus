/**
 * The interactive Claude route (ticket #62).
 *
 * `src/deploy/routes.ts` left this seam open by name: "An interactive-in-cmux
 * variant is the §7.2 grill flow's business (#56 / the grill ticket), and it
 * composes by passing `extraArgs` plus a resolved workspace." It does not
 * quite compose that way — `CLAUDE_ROUTE` ends in `-p <prompt>`, which is the
 * headless one-turn shape, and `extraArgs` land BEFORE it — so the grill
 * passes a route override instead of a flag.
 *
 * Everything that matters is deliberately unchanged from `CLAUDE_ROUTE`:
 *
 * - `sessionIdMode: "preassigned"`, so SPEC §5 rule 1 holds in its STRICT
 *   form. Argus names the session, fsyncs the row, and only then is anything
 *   started. A grill is the one session Johan is guaranteed to type into, so
 *   it is the last place to accept the weaker announced ordering.
 * - `--session-id` and `--model` exactly as the headless route passes them.
 *
 * The single difference is the prompt's position: a bare positional argument
 * opens an INTERACTIVE session with that first message, where `-p` would print
 * one answer and exit. §7.2 step 3 — "Johan answers in the terminal directly"
 * — is that difference.
 */
import type { AgentRoute } from "../deploy";
import { DEFAULT_GRILL_MODEL } from "./config.ts";

export const CLAUDE_GRILL_ROUTE: AgentRoute = {
  agent: "claude",
  command: ({ dispatchPrompt, extraArgs = [], model, sessionId }) => [
    "claude",
    "--session-id",
    sessionId ?? "",
    "--model",
    model ?? DEFAULT_GRILL_MODEL,
    ...extraArgs,
    dispatchPrompt,
  ],
  executable: "claude",
  sessionIdMode: "preassigned",
};
