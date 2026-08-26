/**
 * `sendToWorker` — SPEC §5 rule 2 for real worker traffic (#55).
 *
 * "Every Hermes-authored send is logged to the provenance registry first. This
 * is non-negotiable: unlogged sends would masquerade as Johan and poison
 * USER.md" (SPEC §3). Until now the only production code that honoured it was
 * `notifyMissionControl`, which types one kind of line into one kind of
 * session. This is the general one: the follow-ups a dispatcher types into a
 * WORKER — "gates are red, fix and re-run", "review is clean, wrap up".
 *
 * THE ORDER, and the two refusals that keep it honest:
 *
 *   resolve the target → log the send (fsync) → type it
 *
 * - Logging comes before typing because an unlogged landing classifies as
 *   Johan (scenario 4's poisoning failure).
 * - RESOLVING comes before logging because of the opposite hazard. A send that
 *   is logged but never lands is a phantom Hermes attribution sitting in the
 *   matcher's window: if Johan later types those same words himself, they stop
 *   being his. So a target Argus cannot deliver to is refused with nothing
 *   written — and on cmux 0.62.2 "cannot deliver" is not hypothetical, since
 *   #7 measured an unresolvable handle exiting 0 into the FOCUSED workspace.
 * - Once a send IS logged, a delivery failure never un-logs it. That direction
 *   of rule 2 is absolute, and the matcher already has the loud answer for a
 *   send that never lands (`send-expired`).
 *
 * A session with no cmux workspace is refused rather than queued: headless
 * workers have no input channel at all on this machine, and a queue nobody
 * drains is a lie about delivery. #56 can add one on top without changing the
 * ordering above.
 */
import { deriveKind, hashText, normalize } from "../matching";
import {
  appendSendRow,
  loadRegistry,
  registryPaths,
  type SessionRecord,
} from "../provenance";
import {
  resolveWithCmux,
  sendWithCmux,
  type CmuxResolve,
  type CmuxSend,
} from "../events";

export interface WorkerSendRequest {
  now?: () => Date;
  repo: string;
  sessionId: string;
  /** Correlation id for audits; defaults to the registry's `<file>:<line>`. */
  id?: string;
  text: string;
}

export interface WorkerSendOptions {
  resolve?: CmuxResolve;
  send?: CmuxSend;
}

export type WorkerSendResult =
  /** Logged, then delivered. */
  | { status: "sent" }
  /** Logged, then delivery failed — the row stays, loudly (§5 rule 2). */
  | { status: "degraded"; reason: string }
  /** Nothing logged and nothing typed. */
  | { status: "refused"; reason: string };

export async function sendToWorker(
  request: WorkerSendRequest,
  options: WorkerSendOptions = {},
): Promise<WorkerSendResult> {
  const paths = registryPaths(request.repo);
  const registry = await loadRegistry(paths);
  const session = latest(registry.sessions, request.sessionId);
  if (session === null) {
    return refused(
      `session ${request.sessionId} is not a registered deployment; a send into an unregistered session would classify as Johan (§5 rule 3a)`,
    );
  }
  const target = session.workspace;
  if (target === undefined) {
    return refused(
      `deployment ${request.sessionId} has no cmux workspace, so there is no channel to type into; nothing was logged`,
    );
  }

  const resolved = await (options.resolve ?? resolveWithCmux)({
    workspace: target,
    ...(session.surface !== undefined && { surface: session.surface }),
  });
  if (!resolved.ok) {
    return refused(resolved.error ?? `cmux did not resolve ${target}`);
  }

  const text = normalize(request.text);
  await appendSendRow(paths.sendsFile, {
    agent: "hermes",
    hash: hashText(text),
    kind: deriveKind(text),
    sessionId: request.sessionId,
    text,
    ts: (request.now?.() ?? new Date()).toISOString(),
    workspace: target,
    ...(request.id !== undefined && { id: request.id }),
    ...(session.surface !== undefined && { surface: session.surface }),
  });

  const delivery = await (options.send ?? sendWithCmux)({
    text,
    workspace: target,
    ...(session.surface !== undefined && { surface: session.surface }),
  });
  if (!delivery.ok) {
    return {
      reason: delivery.error ?? "cmux send failed after the send was logged",
      status: "degraded",
    };
  }
  return { status: "sent" };
}

/** The newest row for this session, so a re-registration's target wins. */
function latest(sessions: SessionRecord[], sessionId: string): SessionRecord | null {
  for (let index = sessions.length - 1; index >= 0; index -= 1) {
    const session = sessions[index]!;
    if (session.sessionId === sessionId) return session;
  }
  return null;
}

const refused = (reason: string): WorkerSendResult => ({ reason, status: "refused" });
