import { describe, it, expect } from "vitest";
import { buildLanguageInstructions } from "../domains/studio/generation/languageInstructions.js";

describe("buildLanguageInstructions", () => {
  it("returns an empty string for English", () => {
    expect(buildLanguageInstructions("en")).toBe("");
  });

  it("returns an empty string when language is missing", () => {
    expect(buildLanguageInstructions(undefined)).toBe("");
    expect(buildLanguageInstructions(null)).toBe("");
    expect(buildLanguageInstructions("")).toBe("");
  });

  it("returns the Spanish directive for es", () => {
    const out = buildLanguageInstructions("es");
    expect(out).toContain("LANGUAGE INSTRUCTIONS");
    expect(out).toContain("Spanish (es)");
    expect(out).toContain("Preserve brand names");
    expect(out).toContain("Do not translate JSON keys");
  });

  it("normalizes casing and whitespace", () => {
    expect(buildLanguageInstructions("ES")).toContain("Spanish (es)");
    expect(buildLanguageInstructions("  es  ")).toContain("Spanish (es)");
    expect(buildLanguageInstructions("En")).toBe("");
  });

  it("falls back to English-default for unsupported / future codes", () => {
    // These are reserved in lib/languages.js FUTURE_LANGUAGE_CODES
    // but not in the SUPPORTED_LANGUAGES allow-list yet, so the
    // helper should default-safe to "" rather than emit a
    // half-baked / wrong directive.
    expect(buildLanguageInstructions("fr")).toBe("");
    expect(buildLanguageInstructions("pt")).toBe("");
    expect(buildLanguageInstructions("zh")).toBe("");
    expect(buildLanguageInstructions("ar")).toBe("");
  });

  it("falls back to English-default for completely unknown codes", () => {
    expect(buildLanguageInstructions("xx")).toBe("");
    expect(buildLanguageInstructions("klingon")).toBe("");
    expect(buildLanguageInstructions(42)).toBe("");
    expect(buildLanguageInstructions({ code: "es" })).toBe("");
  });
});
