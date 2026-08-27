/**
 * THE HANDLE FORM, made structural — ticket #98.
 *
 * #90 measured the door this exists to shut (`docs/acceptance/cmux-door.txt`),
 * against the real cmux 0.62.2:
 *
 *   cmux close-surface --surface 00000000-0000-0000-0000-000000000000 …
 *       -> exit 1, "not_found: Surface not found", NOTHING closed
 *   cmux list-pane-surfaces --workspace workspace:9999
 *       -> exit 0, answered for a workspace nobody named — the FOCUSED one
 *
 * An unresolvable UUID fails CLOSED. An unresolvable short ref fails OPEN: it
 * is not an error, it is a REDIRECT onto whatever surface is focused, and it
 * exits 0. Pointed at `close-surface` that closes a terminal a human is using
 * and reports success.
 *
 * WHY A GUARD IN THE CALLER IS NOT ENOUGH, which is the whole of #98.
 * `src/deploy/tab.ts` resolves every handle against `tree --all` before it
 * runs a verb that changes anything. That check is real and it stays. But it
 * is a check the CALLER performs, and resolve-then-act is not atomic:
 *
 *   - between the resolve and the call another session can close the surface
 *     that was just resolved, and
 *   - focus moves ON ITS OWN. #90 watched `identify.focused` walk
 *     `surface:2 -> surface:6 -> surface:4` with no action by the driver,
 *     because other sessions were working. "I verified what was focused" has
 *     already expired by the time the next call runs.
 *
 * The window cannot be removed from outside cmux. Only the CONSEQUENCE of
 * losing it can be, and only the handle form removes it: lose the race holding
 * a UUID and the verb errors and closes nothing; lose it holding a ref and the
 * verb closes Johan's tab and exits 0.
 *
 * So the handle form must not be a convention. Until this module it was one —
 * `tab.ts` passed the caller's string through to `close-surface`, and its
 * membership check accepted a REF as readily as a UUID, so a ref-shaped
 * registry row was closed with a ref. A future edit that reintroduced one
 * would have been a comment violation, not a compile or run failure.
 *
 * THE CHOKE POINT. `runCmux` (`./notify.ts`) is the ONLY place in the tree
 * that spawns the `cmux` binary — asserted by a test in `handles.test.ts`, so
 * that a second spawn site is a red gate rather than a discovery after an
 * incident. Every state-changing verb therefore passes through here, and one
 * that carries a non-UUID handle is refused WITHOUT SPAWNING. The refusal is
 * shaped exactly like cmux's own fail-closed answer — exit 1, a reason on
 * stderr — because every caller in the tree already degrades on that, so no
 * call site has to learn a new failure mode to be safe.
 *
 * WHAT IS DELIBERATELY NOT IN THE LIST: `send` and `send-key`. Their redirect
 * is #7's hazard and it is real, but it is bounded — text lands in the wrong
 * session — and it is already guarded by `createCmuxResolve`, which refuses to
 * type into a handle cmux does not resolve. More to the point, Hermes rows in
 * `sends.jsonl` legitimately carry ref-shaped mission handles today (#99), and
 * hard-refusing them here would take mission delivery down to close a hole
 * that does not destroy anything. The destructive and layout-changing verbs
 * get no such latitude: nothing in Argus has ever needed to point one at a ref.
 */

/** Canonical 8-4-4-4-12. cmux prints these upper-case; accept either case. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Is this handle a raw UUID — the form measured to fail CLOSED?
 *
 * Note what this rejects besides `surface:60`: `surface:<UUID>`. #99 measured
 * that shape and cmux rejects it at parse (`Invalid surface handle`), so it is
 * a record bug rather than a hazard — but it is not the form that fails
 * closed either, and a handle that cannot be run is not worth passing to a
 * verb that destroys state. A bare index (`1`) is rejected for a sharper
 * reason: #90 measured `--workspace 1` resolving to a DIFFERENT workspace than
 * `--workspace workspace:1`. It is a third addressing form, undocumented in
 * our tree, and it is positional.
 */
export const isCmuxUuid = (handle: string): boolean => UUID.test(handle);

/**
 * Verbs that may only be pointed at a UUID.
 *
 * Everything here changes state that belongs to Johan if the handle redirects:
 * the three `close-*` verbs destroy a surface, workspace or window; the rest
 * create tabs in, rename, reorder, move or steal focus to whatever is in front
 * of him. Argus itself drives only `new-surface`, `close-surface` and
 * `rename-tab` today. The others are listed anyway, because the cost of
 * listing a verb we never call is zero and the cost of omitting one we later
 * start calling is a tab of Johan's.
 */
export const CMUX_UUID_ONLY_VERBS: ReadonlySet<string> = new Set([
  "close-surface",
  "close-window",
  "close-workspace",
  "drag-surface-to-split",
  "focus-pane",
  "focus-panel",
  "focus-window",
  "move-surface",
  "move-workspace-to-window",
  "new-pane",
  "new-split",
  "new-surface",
  "rename-tab",
  "rename-window",
  "rename-workspace",
  "reorder-surface",
  "reorder-workspace",
  "select-workspace",
  "tab-action",
  "workspace-action",
]);

/** The flags on those verbs whose value is a cmux handle. */
export const CMUX_HANDLE_FLAGS: ReadonlySet<string> = new Set([
  "--panel",
  "--pane",
  "--surface",
  "--tab",
  "--window",
  "--workspace",
]);

/** Global options that sit BEFORE the verb and consume the next argument. */
const GLOBAL_OPTIONS_WITH_VALUES: ReadonlySet<string> = new Set([
  "--id-format",
  "--password",
  "--socket",
]);

/**
 * The verb in an argv, skipping cmux's global options.
 *
 * Finding it properly rather than scanning for a known verb name matters:
 * `rename-tab --surface <uuid> "close-surface"` is a legal call whose TITLE is
 * a verb name, and a scan would refuse it for the wrong reason.
 */
function verbOf(args: readonly string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index]!;
    if (!token.startsWith("-")) return token;
    if (GLOBAL_OPTIONS_WITH_VALUES.has(token)) index += 1;
  }
  return null;
}

/**
 * The reason this argv must not reach the binary, or `null` to let it through.
 *
 * Pure, so the policy can be asserted directly without spawning anything.
 */
export function refuseCmuxArgs(args: readonly string[]): string | null {
  const verb = verbOf(args);
  if (verb === null || !CMUX_UUID_ONLY_VERBS.has(verb)) return null;

  const start = args.indexOf(verb) + 1;
  for (let index = start; index < args.length; index += 1) {
    const token = args[index]!;
    // `--` ends the flags; everything after it is literal text (a tab title).
    if (token === "--") break;
    if (!CMUX_HANDLE_FLAGS.has(token)) continue;
    const value = args[index + 1];
    index += 1;
    if (value === undefined) continue; // cmux's own usage error to report.
    if (isCmuxUuid(value)) continue;
    return (
      `argus refuses to run \`cmux ${verb}\` with ${token} ${JSON.stringify(value)}: ` +
      "a state-changing cmux verb takes a UUID only. #90 measured that an " +
      "unresolvable short ref is not an error on 0.62.2 — it exits 0 and acts on " +
      "the FOCUSED surface, which is how #98 lost one of Johan's tabs. An " +
      "unresolvable UUID exits 1 and does nothing. Resolve the handle to its " +
      "UUID with `cmux --id-format both tree --all --json` and pass that."
    );
  }
  return null;
}
