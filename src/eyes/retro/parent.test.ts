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

  /**
   * #42 item 4. The live-brain flake that cost three tickets a re-run was the
   * model answering "15" where a test wanted "#15" — and the SAME assumption
   * is load-bearing here. `parentTicket` is free-form model output; when it
   * comes back punctuated, an exact compare drops a parent Argus HAS and files
   * the retro at root level, silently. The judgment is which ticket, never how
   * the model wrote the number.
   */
  test("the brain's pick is matched by ticket NUMBER, not by punctuation", () => {
    for (const brainChoice of ["#16", " 16 ", "#16 "]) {
      expect(
        resolveParent({
          sessionTickets: [],
          referencedTickets: [],
          brainChoice,
          candidates: [candidate("15"), candidate("16")],
        }),
      ).toEqual({ parent: "16", rule: "brain-choice" });
    }
  });

  test("normalizing the pick does not let the brain invent one", () => {
    // Still the §5.5 rule: a model may not name a number that does not exist.
    for (const brainChoice of ["#999", "issue 15", "15 or 16", "fifteen", "#"]) {
      expect(
        resolveParent({
          sessionTickets: [],
          referencedTickets: [],
          brainChoice,
          candidates: [candidate("15")],
        }),
      ).toEqual({ parent: null, rule: "root-level" });
    }
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
