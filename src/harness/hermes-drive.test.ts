import { afterEach, expect, test } from "bun:test";

import { loadScaledMs } from "../eyes/test-budget.ts";
import { driveScratchProfile } from "./hermes-drive.ts";

const realTmpdir = Bun.env.TMPDIR;

afterEach(() => {
  if (realTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = realTmpdir;
});

/**
 * The drive runs at MODULE LOAD in `hermes.live.test.ts`, because "the gate
 * opened and a profile still could not be provisioned" is a skip and a test
 * name has to be able to say so. Module load is also the one place a throw is
 * unrecoverable: it takes the whole file down as an unhandled error, and the
 * three carefully distinguished skips never get printed at all.
 *
 * So the drive's contract is that it does not throw. Whatever goes wrong comes
 * back as a provisioning failure that names itself. A machine with nowhere to
 * put a scratch directory is the cheapest way to reach that path for real.
 */
test(
  "a drive that cannot build its sandbox reports a skip, not a throw",
  async () => {
    process.env.TMPDIR = "/nonexistent/tmp/for/ticket-47";

    const drive = await driveScratchProfile({
      checkout: process.cwd(),
      driveBudgetMs: 5_000,
    });

    expect(drive.provisioningFailure).toContain("/nonexistent/tmp/for/ticket-47");
    expect(drive.schemaVersion).toBeNull();
    await drive.teardown();
  },
  loadScaledMs(60_000, 240_000),
);
