// Phase 0 — supported-language registry + helpers.
//
// Locks in:
//   - en + es are supported today; nothing else is.
//   - normalize accepts mixed case, trims whitespace, falls back to
//     "en" on garbage / null / undefined.
//   - The future-language list is documented (so changing it shows
//     up in code review) but is NOT selectable yet.
//   - Schema-level fields elsewhere (Client.defaultLanguage etc.)
//     accept any string — this allow-list is the only gate.

import { describe, it, expect } from "vitest";
import {
  DEFAULT_LANGUAGE,
  SUPPORTED_LANGUAGES,
  FUTURE_LANGUAGE_CODES,
  isSupportedLanguage,
  normalizeLanguage,
  getLanguageLabel,
} from "../lib/languages.js";

describe("SUPPORTED_LANGUAGES", () => {
  it("includes English and Spanish today", () => {
    const codes = SUPPORTED_LANGUAGES.map((l) => l.code);
    expect(codes).toEqual(["en", "es"]);
  });

  it("entries carry label + nativeLabel", () => {
    for (const entry of SUPPORTED_LANGUAGES) {
      expect(typeof entry.code).toBe("string");
      expect(typeof entry.label).toBe("string");
      expect(typeof entry.nativeLabel).toBe("string");
    }
  });

  it("is frozen — accidental mutation throws in strict mode", () => {
    expect(() => SUPPORTED_LANGUAGES.push({ code: "x" })).toThrow();
  });

  it("Spanish entry uses the native label", () => {
    const es = SUPPORTED_LANGUAGES.find((l) => l.code === "es");
    expect(es?.nativeLabel).toBe("Español");
  });
});

describe("FUTURE_LANGUAGE_CODES", () => {
  it("documents fr / pt / zh / ar as the next batch", () => {
    expect([...FUTURE_LANGUAGE_CODES]).toEqual(["fr", "pt", "zh", "ar"]);
  });

  it("none of the future codes are selectable yet", () => {
    for (const code of FUTURE_LANGUAGE_CODES) {
      expect(isSupportedLanguage(code)).toBe(false);
    }
  });
});

describe("DEFAULT_LANGUAGE", () => {
  it('is "en"', () => {
    expect(DEFAULT_LANGUAGE).toBe("en");
  });
});

describe("isSupportedLanguage", () => {
  it("returns true for en and es", () => {
    expect(isSupportedLanguage("en")).toBe(true);
    expect(isSupportedLanguage("es")).toBe(true);
  });

  it("returns true regardless of case", () => {
    expect(isSupportedLanguage("EN")).toBe(true);
    expect(isSupportedLanguage("Es")).toBe(true);
  });

  it("returns false for future / unknown codes", () => {
    expect(isSupportedLanguage("fr")).toBe(false);
    expect(isSupportedLanguage("zh")).toBe(false);
    expect(isSupportedLanguage("klingon")).toBe(false);
  });

  it("returns false for non-string input", () => {
    expect(isSupportedLanguage(null)).toBe(false);
    expect(isSupportedLanguage(undefined)).toBe(false);
    expect(isSupportedLanguage(42)).toBe(false);
    expect(isSupportedLanguage({})).toBe(false);
  });
});

describe("normalizeLanguage", () => {
  it("returns the same code when supported", () => {
    expect(normalizeLanguage("en")).toBe("en");
    expect(normalizeLanguage("es")).toBe("es");
  });

  it("lowercases", () => {
    expect(normalizeLanguage("EN")).toBe("en");
    expect(normalizeLanguage("Es")).toBe("es");
  });

  it("trims whitespace", () => {
    expect(normalizeLanguage(" en ")).toBe("en");
    expect(normalizeLanguage("\tes\n")).toBe("es");
  });

  it("falls back to en for unsupported codes", () => {
    expect(normalizeLanguage("fr")).toBe("en");
    expect(normalizeLanguage("zh")).toBe("en");
  });

  it("falls back to en for null / undefined / non-string", () => {
    expect(normalizeLanguage(null)).toBe("en");
    expect(normalizeLanguage(undefined)).toBe("en");
    expect(normalizeLanguage(123)).toBe("en");
    expect(normalizeLanguage({})).toBe("en");
  });

  it("falls back to en for empty / whitespace-only", () => {
    expect(normalizeLanguage("")).toBe("en");
    expect(normalizeLanguage("   ")).toBe("en");
  });
});

describe("getLanguageLabel", () => {
  it('returns "English" for "en"', () => {
    expect(getLanguageLabel("en")).toBe("English");
  });

  it('returns "Spanish" for "es"', () => {
    expect(getLanguageLabel("es")).toBe("Spanish");
  });

  it("is case-insensitive", () => {
    expect(getLanguageLabel("EN")).toBe("English");
  });

  it("returns the code itself for unknown languages (so log lines don't crash)", () => {
    expect(getLanguageLabel("fr")).toBe("fr");
  });

  it("returns the default language string for non-string input", () => {
    expect(getLanguageLabel(null)).toBe("en");
    expect(getLanguageLabel(undefined)).toBe("en");
  });
});
