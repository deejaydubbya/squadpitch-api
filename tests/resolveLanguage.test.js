// Phase 0 — resolveLanguage fallback chain.
//
// Pins the resolution order so a future refactor that swaps Client
// + ContentPreferences priority (or skips a layer) trips a test
// instead of silently changing every generated post in production.

import { describe, it, expect } from "vitest";
import { resolveLanguage } from "../domains/studio/generation/resolveLanguage.js";

describe("resolveLanguage", () => {
  it("returns the requested language when it wins", () => {
    expect(
      resolveLanguage({
        requestedLanguage: "es",
        campaign: { language: "en" },
        contentPreferences: { defaultLanguage: "en" },
        client: { defaultLanguage: "en" },
      }),
    ).toBe("es");
  });

  it("falls through to campaign.language when request is missing", () => {
    expect(
      resolveLanguage({
        campaign: { language: "es" },
        contentPreferences: { defaultLanguage: "en" },
        client: { defaultLanguage: "en" },
      }),
    ).toBe("es");
  });

  it("falls through to contentPreferences.defaultLanguage when request + campaign are missing", () => {
    expect(
      resolveLanguage({
        contentPreferences: { defaultLanguage: "es" },
        client: { defaultLanguage: "en" },
      }),
    ).toBe("es");
  });

  it("falls through to client.defaultLanguage when nothing above is set", () => {
    expect(
      resolveLanguage({
        client: { defaultLanguage: "es" },
      }),
    ).toBe("es");
  });

  it("returns the caller-supplied fallback when every layer is null", () => {
    expect(
      resolveLanguage({ fallback: "es" }),
    ).toBe("es");
  });

  it("returns 'en' when called with nothing at all", () => {
    expect(resolveLanguage()).toBe("en");
    expect(resolveLanguage({})).toBe("en");
  });

  it("drops unsupported requested language to the next layer", () => {
    expect(
      resolveLanguage({
        requestedLanguage: "fr", // not yet selectable
        campaign: { language: "es" },
      }),
    ).toBe("es");
  });

  it("drops garbage requested language to the next layer", () => {
    expect(
      resolveLanguage({
        requestedLanguage: "not-a-language",
        client: { defaultLanguage: "es" },
      }),
    ).toBe("es");
  });

  it("drops null / undefined at each layer", () => {
    expect(
      resolveLanguage({
        requestedLanguage: null,
        campaign: { language: undefined },
        contentPreferences: { defaultLanguage: null },
        client: { defaultLanguage: "es" },
      }),
    ).toBe("es");
  });

  it("is case-insensitive and trims whitespace", () => {
    expect(resolveLanguage({ requestedLanguage: " ES " })).toBe("es");
    expect(resolveLanguage({ requestedLanguage: "En" })).toBe("en");
  });

  it("falls back to 'en' even when fallback is unsupported", () => {
    expect(
      resolveLanguage({
        fallback: "fr", // doesn't satisfy isSupportedLanguage
      }),
    ).toBe("en");
  });

  it("treats null campaign / contentPreferences / client as if absent", () => {
    expect(
      resolveLanguage({
        campaign: null,
        contentPreferences: null,
        client: null,
      }),
    ).toBe("en");
  });

  it("treats empty objects (no language field) as if absent", () => {
    expect(
      resolveLanguage({
        campaign: {},
        contentPreferences: {},
        client: {},
      }),
    ).toBe("en");
  });
});
