import { describe, expect, test } from "bun:test";
import { hashText, sha256Hex } from "./hash";

describe("sha256Hex", () => {
  // Expected values are NIST FIPS 180-4 test vectors, not recomputed here.
  test("matches the NIST vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  test("matches the NIST vector for the empty string", () => {
    expect(sha256Hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });

  test("hashes UTF-8 bytes, not UTF-16 units", () => {
    // sha256 of the 4 bytes c3 a9 c3 a9 ("éé" in UTF-8), computed with
    // `printf '\xc3\xa9\xc3\xa9' | shasum -a 256` as an independent source.
    expect(sha256Hex("éé")).toBe(
      "f13c007a1d8e6e1300b5957a143810cdd3555825466cf5d2617b1ac2fd8bd76b",
    );
  });
});

describe("hashText", () => {
  test("normalizes before hashing: NFD and NFC inputs hash equal", () => {
    expect(hashText("café")).toBe(hashText("café"));
  });

  test("whitespace variants that land identically hash equal", () => {
    expect(hashText("line one\r\nline two   ")).toBe(hashText("line one\nline two"));
  });
});
