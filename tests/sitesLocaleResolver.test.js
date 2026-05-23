// Phase 2 — public-resolver locale picker + alternates map.
//
// Pure-function tests; no Prisma. The DB-coupled resolvePublicPage
// path is covered by routeImports boot smoke (it imports the same
// helpers) plus manual QA against a seeded workspace.

import { describe, it, expect } from "vitest";
import {
  pickPageByLocale,
  buildAlternatesMap,
} from "../domains/sites/sites.service.js";

describe("pickPageByLocale", () => {
  const enRow = { id: "page_en", slug: "spring", language: "en" };
  const esRow = { id: "page_es", slug: "spring", language: "es" };

  it("returns null for an empty siblings list", () => {
    expect(pickPageByLocale([], "es")).toBeNull();
    expect(pickPageByLocale(null, "es")).toBeNull();
    expect(pickPageByLocale(undefined)).toBeNull();
  });

  it("returns the locale match when present", () => {
    expect(pickPageByLocale([enRow, esRow], "es")).toBe(esRow);
    expect(pickPageByLocale([enRow, esRow], "en")).toBe(enRow);
  });

  it("falls back to English when the requested locale is missing", () => {
    expect(pickPageByLocale([enRow], "es")).toBe(enRow);
  });

  it("falls back to first available when neither locale nor English match", () => {
    const frRow = { id: "page_fr", slug: "spring", language: "fr" };
    const ptRow = { id: "page_pt", slug: "spring", language: "pt" };
    // Sorted by id ⇒ page_fr comes before page_pt
    expect(pickPageByLocale([ptRow, frRow], "es")).toBe(frRow);
  });

  it("prefers English when no locale is requested", () => {
    expect(pickPageByLocale([esRow, enRow], null)).toBe(enRow);
    expect(pickPageByLocale([esRow, enRow], undefined)).toBe(enRow);
  });

  it("is deterministic when ties exist (sorts by id)", () => {
    // Two rows both marked "en" — shouldn't happen in practice but
    // the picker must not be order-dependent.
    const rowA = { id: "aaa", slug: "x", language: "en" };
    const rowB = { id: "bbb", slug: "x", language: "en" };
    expect(pickPageByLocale([rowB, rowA], "en")).toBe(rowA);
    expect(pickPageByLocale([rowA, rowB], "en")).toBe(rowA);
  });
});

describe("buildAlternatesMap", () => {
  it("returns an empty object for empty input", () => {
    expect(buildAlternatesMap([])).toEqual({});
    expect(buildAlternatesMap(null)).toEqual({});
  });

  it("emits English without a locale prefix", () => {
    expect(buildAlternatesMap([{ id: "1", slug: "spring", language: "en" }])).toEqual({
      en: "/spring",
    });
  });

  it("emits non-English with a locale prefix", () => {
    expect(buildAlternatesMap([{ id: "1", slug: "spring", language: "es" }])).toEqual({
      es: "/es/spring",
    });
  });

  it("emits both alternates when siblings exist", () => {
    const rows = [
      { id: "page_en", slug: "spring", language: "en" },
      { id: "page_es", slug: "spring", language: "es" },
    ];
    expect(buildAlternatesMap(rows)).toEqual({
      en: "/spring",
      es: "/es/spring",
    });
  });

  it("skips rows with no language", () => {
    const rows = [
      { id: "page_en", slug: "spring", language: "en" },
      { id: "page_x", slug: "spring", language: null },
    ];
    expect(buildAlternatesMap(rows)).toEqual({ en: "/spring" });
  });

  it("skips rows with no slug", () => {
    const rows = [
      { id: "page_en", slug: null, language: "en" },
      { id: "page_es", slug: "spring", language: "es" },
    ];
    expect(buildAlternatesMap(rows)).toEqual({ es: "/es/spring" });
  });
});
