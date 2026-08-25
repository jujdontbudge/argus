import { afterAll, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadScaledMs } from "../eyes/test-budget.ts";
import { driveScratchProfile, DRIVE_PROMPT } from "../harness/hermes-drive.ts";
import {
  describeHermesLiveGate,
  probeHermesLive,
  refineScratchVerdict,
  resolveHermesLiveGate,
  LIVE_HERMES_GATE,
  REAL_HERMES_ROOT,
} from "../harness/hermes-live-gate.ts";
import { liveHalfTitle } from "../harness/live-gate.ts";
import { createHermesSource } from "./hermes";
import { Tailer } from "./tailer";
import type { MessageEvent, TailEvent } from "./events";

/**
 * Ticket #47 — the live Hermes verification, which used to be unfalsifiable.
 *
 * What stood here looked for `~/.hermes/profiles/argus-*​/state.db` and
 * `test.skipIf`-ed itself away when there was none. There never has been:
 * a profile is created by `argus up`, and Argus has only ever run against
 * sandboxes on this machine. So the check could not fail — it could only
 * vanish, and a verification that cannot fail is not a verification.
 *
 * It now has two halves and neither can vanish quietly:
 *
 *   - SCRATCH, behind `ARGUS_LIVE_HERMES=1`, provisions its own profile and
 *     drives the installed Hermes. It waits on nothing that has to be deployed
 *     first, so it is re-runnable — which is the half of #45's G3 this closes.
 *   - REAL is ungated and read-only. If `~/.hermes/profiles` ever exists it is
 *     read and never written, exactly as before.
 *
 * The §7 caveat is asserted in the form a credential-free drive can actually
 * establish, and the version it held against is recorded. See the scratch test
 * below for what that means and what it deliberately does not reach.
 */
const checkout = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Measured on this machine: sandbox 1.7s, `argus up`'s binding 7ms, the
 * `hermes chat` drive 28.3s — 30s all in, of which the drive is everything.
 * The same run took 135s at 15-minute load average 142, which is what the
 * scaling in `loadScaledMs` is for. 240s idle is ~8x the measured drive.
 *
 * It bounds the drive twice over, and the first one is what matters: the drive
 * runs at module load, where `bun test`'s per-test timeout does not reach, so
 * `runBounded`'s own killer is the hang detector. A killed drive reports as
 * "provisioned nothing", which is a loud skip naming the timeout.
 */
const DRIVE_BUDGET_MS = loadScaledMs(240_000, 900_000);

/** The real profiles directory, listed. Absent reads as an empty list. */
function realProfileEntries(): string[] {
  const profiles = join(REAL_HERMES_ROOT, "profiles");
  if (!existsSync(profiles)) return [];
  return readdirSync(profiles).sort();
}

const probe = probeHermesLive();
const resolved = resolveHermesLiveGate(probe);

/**
 * The drive runs at module load, because "the gate opened and a profile still
 * could not be provisioned" is a THIRD skip and a test name has to be able to
 * say so. Nothing here is reachable on the default path.
 */
const beforeDrive = realProfileEntries();
const drive =
  resolved.scratch.status === "run"
    ? await driveScratchProfile({ checkout, driveBudgetMs: DRIVE_BUDGET_MS })
    : null;
afterAll(async () => {
  await drive?.teardown();
});

const gate = {
  ...resolved,
  scratch: refineScratchVerdict(resolved.scratch, {
    provisioningFailure: drive?.provisioningFailure ?? null,
  }),
};

// Always, on every path. `bun test` prints no name for a skipped test, so this
// line is the whole of a skip's visibility — and the reason this verification
// can no longer rot unnoticed the way it did for twenty-four tickets.
console.log(
  describeHermesLiveGate(gate, {
    cli: drive?.cli ?? null,
    schemaVersion: drive?.schemaVersion ?? null,
  }),
);

test("every skip says which skip it is, and the default gate is shut", () => {
  // The wiring pin for this file. If a half below is ever registered with a
  // bare `test(`, or titled with a constant, this is what notices — and it is
  // what makes the three skips a promise rather than a comment.
  const titles = [gate.scratch, gate.real].map((verdict) =>
    liveHalfTitle("x", verdict),
  );
  expect(titles.every((title) => title === "x" || title.includes(": "))).toBe(
    true,
  );

  if (Bun.env[LIVE_HERMES_GATE] === "1") {
    expect(gate.enabled).toBe(true);
    return;
  }
  expect(gate.enabled).toBe(false);
  expect(liveHalfTitle("x", gate.scratch)).toStartWith(
    `x — SKIPPED: ${LIVE_HERMES_GATE} is unset`,
  );
  // Not SKIPPED. Nobody has to ask for a read that costs nothing, so the only
  // thing the real half can report is that this machine has nothing to read.
  expect(liveHalfTitle("x", gate.real)).toStartWith("x — NOT RUN: ");
});

test.skipIf(gate.scratch.status !== "run")(
  liveHalfTitle(
    "scratch drive: a self-provisioned profile tails through the read-only source, and §7's caveat holds",
    gate.scratch,
  ),
  async () => {
    const live = drive!;

    // 1. The deployment shape. `argus up`'s own binding made this directory,
    //    and the installed Hermes accepted it as a profile and bootstrapped a
    //    state.db inside it — the discovery contract the source depends on.
    expect(live.stateDb).toBe(join(live.profile, "state.db"));
    expect(existsSync(live.stateDb)).toBe(true);

    // 2. The production source, unmodified, against real Hermes output. If an
    //    upstream release renames a column this SQL reads, it fails here.
    const events: TailEvent[] = await new Tailer(
      createHermesSource({ hermesRoot: live.hermesRoot }),
    ).catchUp();
    const messages = events.filter(
      (event): event is MessageEvent => event.type === "message",
    );
    expect(
      events.some(
        (event) =>
          event.type === "session-meta" &&
          event.agent === "hermes" &&
          event.file === live.stateDb,
      ),
    ).toBe(true);
    expect(
      messages.map(({ file, role, text }) => ({ file, role, text })),
    ).toContainEqual({
      file: live.stateDb,
      role: "user",
      text: DRIVE_PROMPT,
    });

    // 3. Research §7, in the only form a drive that must not spend a credential
    //    can establish it: the user turn persists and the assistant turn does
    //    NOT. §7 recorded a 401 stopping the scratch run before an assistant
    //    row; this stops at a provider on a dead port, one step earlier and for
    //    the same structural reason. So assistant-row persistence STILL rests
    //    on code-path plus live-DB evidence, and the caveat is unretired.
    //
    //    It is asserted in the negative deliberately, and it can fail: the day
    //    an upstream Hermes answers a turn without a configured provider, this
    //    goes red and says which version changed the answer.
    expect({
      assistantRows: messages.filter(({ role }) => role === "assistant"),
      hermes: live.cli,
      schema: live.schemaVersion,
    }).toEqual({
      assistantRows: [],
      hermes: live.cli,
      schema: live.schemaVersion,
    });

    // 4. The hard rule, enforced rather than promised: driving Hermes created
    //    no profile in the real home and changed nothing in it.
    expect(realProfileEntries()).toEqual(beforeDrive);
  },
  DRIVE_BUDGET_MS,
);

test.skipIf(gate.real.status !== "run")(
  liveHalfTitle(
    "real profile: a deployed Hermes persists an assistant row the read-only source can tail (§7 caveat, positive form)",
    gate.real,
  ),
  async () => {
    // The half the scratch drive cannot stand in for, kept exactly as it was:
    // read-only, never written, and it runs by itself the day Johan deploys
    // Argus on a repo. Until then its NOT RUN is the honest answer.
    const events = await new Tailer(
      createHermesSource({ hermesRoot: REAL_HERMES_ROOT }),
    ).catchUp();

    expect(
      events.some(
        (event) =>
          event.type === "message" &&
          event.role === "assistant" &&
          event.file === probe.realProfile,
      ),
    ).toBe(true);
    expect(realProfileEntries()).toEqual(beforeDrive);
  },
  30_000,
);
