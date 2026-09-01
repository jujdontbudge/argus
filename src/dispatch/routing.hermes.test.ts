import { describe, expect, test } from "bun:test";

import { HERMES_ROUTE, ROUTES } from "../deploy/index.ts";
import type { FrontierTicket } from "./frontier.ts";
import { defaultDispatchPrompt } from "./dispatch.ts";
import { DEFAULT_AGENT, routeAgent } from "./routing.ts";

const R2_BAIL_OUT =
  "R2 (mandatory bail-out): the moment Hermes or Codex detects an unfiled " +
  "consequential choice inside its ticket, it stops, records the question on " +
  "the ticket, the ticket is relabeled/pinned to Fable, and the event queues " +
  "to the digest per D9.";

const ticket: FrontierTicket = {
  body: "Run the filed non-coding operation.",
  labels: [],
  number: "166",
  title: "Add the Hermes implementer route",
};

describe("Hermes dispatch routing (#166)", () => {
  test("exposes Hermes as a deployable announced-session route", () => {
    expect(ROUTES.hermes).toBe(HERMES_ROUTE);
    expect(HERMES_ROUTE.agent).toBe("hermes");
    expect(HERMES_ROUTE.sessionIdMode).toBe("announced");
    expect(HERMES_ROUTE.announce?.("session_id: hermes-session-166")).toBe(
      "hermes-session-166",
    );
    expect(HERMES_ROUTE.announce?.("worker ready")).toBeNull();
  });

  test("accepts the exact Hermes pin", () => {
    expect(routeAgent(["agent:hermes"])).toEqual({
      agent: "hermes",
      reason: "pinned by 'agent:hermes'",
      status: "routed",
    });
  });

  test("keeps unknown and conflicting pins refused", () => {
    expect(routeAgent(["agent:unknown"]).status).toBe("refused");
    expect(routeAgent(["agent:hermes", "agent:codex"]).status).toBe("refused");
  });

  test("keeps Codex as the default agent", () => {
    expect(DEFAULT_AGENT).toBe("codex");
    expect(routeAgent([])).toMatchObject({ agent: "codex", status: "routed" });
  });

  test("puts the verbatim R2 bail-out clause in Hermes and Codex prompts", () => {
    for (const agent of ["hermes", "codex"] as const) {
      expect(
        defaultDispatchPrompt(
          { ...ticket, labels: [`agent:${agent}`] },
          "JohanSardar/recovi-content",
        ),
      ).toContain(R2_BAIL_OUT);
    }
  });
});
