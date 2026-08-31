import { describe, expect, test } from "bun:test";
import {
  DIGEST_OUTPUT_SCHEMA,
  parseDigestVerdict,
  resolveKnownPitfallRepeat,
} from "./schema";

const entry = {
  sessionId: "sess-1",
  narrative: "Read the tailer, wrote the rotation fix, tests green.",
  summary: "rotation fix landed, tests green",
  status: "running",
};

describe("digest brain output contract", () => {
  test("the #134 tripwire accepts only one pre-dispatch entry", () => {
    expect(resolveKnownPitfallRepeat("metro-port", ["metro-port"], true)).toBe("metro-port");
    expect(resolveKnownPitfallRepeat("new-fact", ["metro-port"], true)).toBeNull();
    expect(resolveKnownPitfallRepeat("metro-port", ["metro-port"], false)).toBeNull();
    expect(resolveKnownPitfallRepeat(null, ["metro-port"], true)).toBeNull();
  });
  test("a conforming verdict parses into typed session digests", () => {
    const verdict = parseDigestVerdict(
      JSON.stringify({
        sessions: [entry, { ...entry, sessionId: "sess-2", status: "done" }],
      }),
    );
    expect(verdict).not.toBeNull();
    expect(verdict!.sessions).toHaveLength(2);
    expect(verdict!.sessions[0]).toEqual({
      sessionId: "sess-1",
      narrative: "Read the tailer, wrote the rotation fix, tests green.",
      summary: "rotation fix landed, tests green",
      status: "running",
    });
    expect(verdict!.sessions[1]!.status).toBe("done");
  });

  test("an empty sessions array is a valid quiet verdict", () => {
    expect(parseDigestVerdict('{"sessions": []}')).toEqual({ sessions: [] });
  });

  test("non-JSON is a schema miss (null)", () => {
    expect(parseDigestVerdict("the session is going great")).toBeNull();
  });

  test("a missing sessions array is a schema miss", () => {
    expect(parseDigestVerdict('{"findings": []}')).toBeNull();
  });

  test("a session entry with a non-contract status is a schema miss", () => {
    expect(
      parseDigestVerdict(
        JSON.stringify({ sessions: [{ ...entry, status: "sleeping" }] }),
      ),
    ).toBeNull();
  });

  test('the brain may never claim "dead" — that is a liveness fact, not a judgment', () => {
    expect(
      parseDigestVerdict(JSON.stringify({ sessions: [{ ...entry, status: "dead" }] })),
    ).toBeNull();
  });

  test("a session entry missing a required field is a schema miss", () => {
    const { narrative: _narrative, ...missingNarrative } = entry;
    expect(
      parseDigestVerdict(JSON.stringify({ sessions: [missingNarrative] })),
    ).toBeNull();
  });

  test("the JSON schema constrains status to what the brain may claim", () => {
    const status =
      DIGEST_OUTPUT_SCHEMA.properties.sessions.items.properties.status;
    expect([...status.enum]).toEqual(["running", "blocked", "done"]);
  });
});
