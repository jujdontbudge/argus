import { describe, expect, test } from "bun:test";
import type { TrackerIssue } from "./gh";
import { resolveParent } from "./parent";

function candidate(number: string, title = `ticket ${number}`): TrackerIssue {
  return { number, title, body: "", labels: [] };
}

describe("nearest plausible parent (SPEC §5.5)", () => {
  test("the ticket of a session working in that checkout wins — §7.4 out-of-scope work", () => {
    const resolved = resolveParent({
      sessionTickets: ["7"],
      referencedTickets: ["15"],
      brainChoice: "16",
      candidates: [candidate("15"), candidate("16")],
    });
    expect(resolved).toEqual({ parent: "7", rule: "session-ticket" });
  });

  test("a ticket the rogue work itself names comes next", () => {
    const resolved = resolveParent({
      sessionTickets: [],
      referencedTickets: ["15"],
      brainChoice: "16",
      candidates: [candidate("16")],
    });
    expect(resolved).toEqual({ parent: "15", rule: "referenced-ticket" });
  });

  test("with no rule-based parent the brain breaks the tie", () => {
    const resolved = resolveParent({
      sessionTickets: [],
      referencedTickets: [],
      brainChoice: "16",
      candidates: [candidate("15"), candidate("16")],
    });
    expect(resolved).toEqual({ parent: "16", rule: "brain-choice" });
  });

  test("the brain CANNOT invent a parent — a number outside the candidates is dropped", () => {
    const resolved = resolveParent({
      sessionTickets: [],
      referencedTickets: [],
      brainChoice: "999",
      candidates: [candidate("15")],
    });
    expect(resolved).toEqual({ parent: null, rule: "root-level" });
  });

  test("no signal at all files a root-level retro", () => {
    const resolved = resolveParent({
      sessionTickets: [],
      referencedTickets: [],
      brainChoice: null,
      candidates: [candidate("15")],
    });
    expect(resolved).toEqual({ parent: null, rule: "root-level" });
  });

  test("registry and commit evidence beat the candidate list — a claimed ticket may be closed", () => {
    const resolved = resolveParent({
      sessionTickets: ["7"],
      referencedTickets: [],
      brainChoice: null,
      candidates: [],
    });
    expect(resolved).toEqual({ parent: "7", rule: "session-ticket" });
  });

  test("the retro never parents itself onto another retro ticket", () => {
    const retro: TrackerIssue = {
      number: "88",
      title: "Retro: something",
      body: "",
      labels: ["retro"],
    };
    const resolved = resolveParent({
      sessionTickets: [],
      referencedTickets: [],
      brainChoice: "88",
      candidates: [retro],
    });
    expect(resolved).toEqual({ parent: null, rule: "root-level" });
  });
});
