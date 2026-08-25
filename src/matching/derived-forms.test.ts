import { describe, expect, test } from "bun:test";
import { deriveKind, derivedForms } from "./derived-forms";

describe("deriveKind", () => {
  test("plain text is a prompt", () => {
    expect(deriveKind("continue with the plan")).toBe("prompt");
  });

  test("leading slash-command is slash", () => {
    expect(deriveKind("/caveman hello there")).toBe("slash");
    expect(deriveKind("/help")).toBe("slash");
  });

  test("leading bang is bang", () => {
    expect(deriveKind("!echo hermes-bang-probe")).toBe("bang");
  });
});

describe("derivedForms", () => {
  test("prompt: exactly the normalized text", () => {
    expect(derivedForms("  hello world  ", "prompt")).toEqual(["hello world"]);
  });

  // Observed landing for `/caveman hello there` (findings §2.3).
  test("slash: normalized text plus the command XML form", () => {
    expect(derivedForms("/caveman hello there", "slash")).toEqual([
      "/caveman hello there",
      "<command-message>caveman</command-message>\n<command-name>/caveman</command-name>\n<command-args>hello there</command-args>",
    ]);
  });

  test("slash without args gets empty command-args", () => {
    expect(derivedForms("/help", "slash")).toEqual([
      "/help",
      "<command-message>help</command-message>\n<command-name>/help</command-name>\n<command-args></command-args>",
    ]);
  });

  // Observed landing for `!echo hermes-bang-probe`: the `!` is dropped and the
  // command lands as `<bash-input>…</bash-input>` (findings §2.3, §7).
  test("bang: only the bash-input form", () => {
    expect(derivedForms("!echo hermes-bang-probe", "bang")).toEqual([
      "<bash-input>echo hermes-bang-probe</bash-input>",
    ]);
  });

  test("kind defaults to deriveKind(text)", () => {
    expect(derivedForms("plain message")).toEqual(["plain message"]);
    expect(derivedForms("!ls")).toEqual(["<bash-input>ls</bash-input>"]);
  });
});
