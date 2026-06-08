import { describe, expect, it } from "vitest";
import { MAX_NAME_LENGTH, normalizeName, validateName } from "./names.js";

describe("normalizeName", () => {
  it("trims surrounding whitespace", () => {
    expect(normalizeName("  Brazil  ")).toBe("brazil");
  });

  it("lowercases the name", () => {
    expect(normalizeName("BRAZIL")).toBe("brazil");
  });

  it("trims and lowercases together", () => {
    expect(normalizeName("\t Argentina \n")).toBe("argentina");
  });

  it("normalizes case/whitespace variants to the same value", () => {
    expect(normalizeName("  Alice ")).toBe(normalizeName("alice"));
    expect(normalizeName("ALICE")).toBe(normalizeName("alice"));
  });

  it("returns empty string for whitespace-only input", () => {
    expect(normalizeName("   ")).toBe("");
    expect(normalizeName("")).toBe("");
  });
});

describe("validateName", () => {
  it("accepts a normal name and returns the trimmed display form", () => {
    const result = validateName("  Brazil  ");
    expect(result).toEqual({ ok: true, value: "Brazil" });
  });

  it("preserves original case in the trimmed display form", () => {
    const result = validateName("McDonald");
    expect(result).toEqual({ ok: true, value: "McDonald" });
  });

  it("accepts a single-character name (lower boundary)", () => {
    expect(validateName("A")).toEqual({ ok: true, value: "A" });
  });

  it("accepts a name of exactly 100 characters after trimming (upper boundary)", () => {
    const name = "x".repeat(MAX_NAME_LENGTH);
    expect(validateName(`  ${name}  `)).toEqual({ ok: true, value: name });
  });

  it("rejects an empty string with NAME_REQUIRED", () => {
    expect(validateName("")).toEqual({
      ok: false,
      error: { code: "NAME_REQUIRED" },
    });
  });

  it("rejects a whitespace-only string with NAME_REQUIRED", () => {
    expect(validateName("   \t\n ")).toEqual({
      ok: false,
      error: { code: "NAME_REQUIRED" },
    });
  });

  it("rejects a name longer than 100 chars after trimming with NAME_TOO_LONG", () => {
    const name = "x".repeat(MAX_NAME_LENGTH + 1);
    expect(validateName(name)).toEqual({
      ok: false,
      error: { code: "NAME_TOO_LONG" },
    });
  });

  it("treats length as measured after trimming (whitespace does not count)", () => {
    const name = "x".repeat(MAX_NAME_LENGTH);
    const padded = `     ${name}     `;
    expect(validateName(padded)).toEqual({ ok: true, value: name });
  });
});
