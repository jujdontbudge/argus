import { describe, expect, test } from "bun:test";

import {
  hermesDriveEnv,
  offlineProviderConfig,
  OFFLINE_BASE_URL,
  OFFLINE_PROVIDER,
  LIVE_HERMES_GATE,
  resolveHermesLiveGate,
  type HermesLiveProbe,
} from "./hermes-live-gate.ts";

const READY: HermesLiveProbe = {
  env: { [LIVE_HERMES_GATE]: "1" },
  hermesInstalled: true,
  realProfile: undefined,
};

describe("the live-Hermes gate", () => {
  test("SKIPS the scratch drive when nobody set the gate", () => {
    const gate = resolveHermesLiveGate({ ...READY, env: {} });

    expect(LIVE_HERMES_GATE).toBe("ARGUS_LIVE_HERMES");
    expect(gate.enabled).toBe(false);
    expect(gate.scratch.status).toBe("gate-unset");
    expect(gate.scratch.reason).toContain("ARGUS_LIVE_HERMES");
  });

  test("holds the scratch drive NOT RUN when the hermes CLI is absent", () => {
    const gate = resolveHermesLiveGate({ ...READY, hermesInstalled: false });

    expect(gate.enabled).toBe(true);
    expect(gate.scratch.status).toBe("not-run");
    expect(gate.scratch.reason).toBe("the hermes CLI is not on PATH");
  });

  test("runs the scratch drive once the gate is set and hermes is installed", () => {
    expect(resolveHermesLiveGate(READY).scratch).toEqual({
      half: "scratch",
      reason: "gate set and the hermes CLI is on PATH",
      status: "run",
    });
  });

  test("tells the two skips apart — an unset gate is not a missing CLI", () => {
    // The distinction #43 drew and the one this ticket exists for: collapsing
    // "nobody asked" into "asked, and the machine cannot" is how a half rots.
    const unset = resolveHermesLiveGate({ ...READY, env: {} }).scratch;
    const absent = resolveHermesLiveGate({
      ...READY,
      hermesInstalled: false,
    }).scratch;

    expect(unset.status).not.toBe(absent.status);
    expect(unset.reason).not.toBe(absent.reason);
  });
});

describe("the opportunistic real-profile half", () => {
  test("is NOT RUN rather than SKIPPED when no profile exists — it costs nothing, so it is always asked for", () => {
    // The whole reason there is a second half. `gate-unset` means nobody asked
    // and nobody pays; a read-only open of a file that already exists has no
    // price, so this half can never be in that state. Its only skip is the
    // honest one, and it names why the machine has nothing to read.
    for (const env of [{}, { [LIVE_HERMES_GATE]: "1" }]) {
      const { real } = resolveHermesLiveGate({ ...READY, env });

      expect(real.status).toBe("not-run");
      expect(real.reason).toContain("a real profile appears the first time");
    }
  });

  test("runs against a real profile whether or not the gate is set", () => {
    for (const env of [{}, { [LIVE_HERMES_GATE]: "1" }]) {
      const { real } = resolveHermesLiveGate({
        ...READY,
        env,
        realProfile: "/home/j/.hermes/profiles/argus-widget-kit/state.db",
      });

      expect(real.status).toBe("run");
      expect(real.reason).toContain("read-only");
    }
  });

  test("does not need hermes installed — reading a state.db is not running Hermes", () => {
    expect(
      resolveHermesLiveGate({
        env: {},
        hermesInstalled: false,
        realProfile: "/home/j/.hermes/profiles/argus-widget-kit/state.db",
      }).real.status,
    ).toBe("run");
  });
});

describe("the scratch drive's child environment", () => {
  /**
   * A distinct, searchable value per ambient credential. The assertions below
   * look for the VALUES rather than the names, so a variable that survives
   * under a different name is still caught.
   */
  const AMBIENT = {
    ANTHROPIC_API_KEY: "leaked-anthropic",
    AWS_SECRET_ACCESS_KEY: "leaked-aws",
    CLAUDE_CODE_OAUTH_TOKEN: "leaked-claude",
    GEMINI_API_KEY: "leaked-gemini",
    HERMES_HOME: "/real/home/.hermes",
    HOME: "/real/home",
    OPENAI_API_KEY: "leaked-openai",
    OPENAI_BASE_URL: "leaked-base-url",
    OPENROUTER_API_KEY: "leaked-openrouter",
    PATH: "/usr/bin:/bin",
    XAI_API_KEY: "leaked-xai",
  } as const;

  const DRIVE = { hermesHome: "/scratch/profiles/argus-x", home: "/scratch/home" };

  test("carries no inference credential, whatever the ambient shell holds", () => {
    const env = hermesDriveEnv(AMBIENT, DRIVE);

    // The invariant that matters is about VALUES reaching the child, not about
    // which names this function happens to know: a drive that cannot see a
    // credential cannot spend one, whoever runs it.
    expect(
      Object.entries(env).filter(([, value]) => value.startsWith("leaked-")),
    ).toEqual([]);
  });

  test("points the drive at the scratch profile and a scratch HOME", () => {
    const env = hermesDriveEnv(AMBIENT, DRIVE);

    // HERMES_HOME is where everything the drive creates lands. HOME is how
    // Hermes resolves the *global* root it also consults — left ambient, the
    // drive would read the real ~/.hermes.
    expect(env.HERMES_HOME).toBe("/scratch/profiles/argus-x");
    expect(env.HOME).toBe("/scratch/home");
  });

  test("keeps the ordinary environment, or the CLI would not be findable", () => {
    expect(hermesDriveEnv(AMBIENT, DRIVE).PATH).toBe("/usr/bin:/bin");
  });

  test("drops an unset ambient variable rather than passing it as empty", () => {
    expect(
      hermesDriveEnv({ ...AMBIENT, TERM: undefined }, DRIVE),
    ).not.toHaveProperty("TERM");
  });
});

describe("the offline provider the scratch drive configures", () => {
  test("is a loopback address, so no packet can leave this machine", () => {
    const url = new URL(OFFLINE_BASE_URL);

    expect(url.hostname).toBe("127.0.0.1");
    expect(url.protocol).toBe("http:");
  });

  test("is REFUSED right now, on this machine", async () => {
    // Not a shape assertion: the drive's whole safety argument is that it
    // reaches a provider that does not answer, and this is the only assertion
    // in the file that checks that against the machine rather than a string.
    // The day something listens on that port, this fails instead of the drive
    // quietly talking to it.
    const url = new URL(OFFLINE_BASE_URL);
    const refused = await Bun.connect({
      hostname: url.hostname,
      port: Number(url.port),
      socket: { data: () => {}, open: (socket) => socket.end() },
    }).then(
      () => false,
      () => true,
    );

    expect(refused).toBe(true);
  });

  test("names a placeholder key rather than carrying a credential", () => {
    const config = offlineProviderConfig();

    expect(config).toContain(`${OFFLINE_PROVIDER}:`);
    expect(config).toContain(OFFLINE_BASE_URL);
    expect(config).toContain("argus-test-placeholder-not-a-credential");
  });
});
