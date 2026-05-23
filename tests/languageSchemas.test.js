// Phase 0 — language fields are wired into the request schemas.
//
// Pins:
//   - LanguageCodeEnum accepts en / es and rejects everything else.
//   - UpdateClientSchema, CreateClientSchema, and
//     ContentPreferencesUpdateSchema each accept a `defaultLanguage`
//     field — so the existing PATCH/POST/PUT routes can persist it
//     with no extra route-handler changes.
//   - Invalid language → schema-level rejection (400 from the route
//     layer's `validationError` helper).

import { describe, it, expect } from "vitest";
import {
  LanguageCodeEnum,
  CreateClientSchema,
  UpdateClientSchema,
  ContentPreferencesUpdateSchema,
} from "../domains/studio/studio.schemas.js";

describe("LanguageCodeEnum", () => {
  it("accepts en + es", () => {
    expect(LanguageCodeEnum.safeParse("en").success).toBe(true);
    expect(LanguageCodeEnum.safeParse("es").success).toBe(true);
  });

  it("rejects future / unknown codes", () => {
    expect(LanguageCodeEnum.safeParse("fr").success).toBe(false);
    expect(LanguageCodeEnum.safeParse("zh").success).toBe(false);
    expect(LanguageCodeEnum.safeParse("klingon").success).toBe(false);
    expect(LanguageCodeEnum.safeParse("").success).toBe(false);
  });

  it("is case-sensitive — only lowercase passes", () => {
    // Routes use this enum directly. Normalization happens in
    // `lib/languages.js#normalizeLanguage`, NOT in the schema.
    // The FE / API contract is "send lowercase".
    expect(LanguageCodeEnum.safeParse("EN").success).toBe(false);
  });
});

describe("CreateClientSchema.defaultLanguage", () => {
  const base = { name: "Test", slug: "test-ws" };

  it("accepts a workspace created with es", () => {
    const r = CreateClientSchema.safeParse({ ...base, defaultLanguage: "es" });
    expect(r.success).toBe(true);
  });

  it("accepts a workspace created without specifying language (DB default kicks in)", () => {
    const r = CreateClientSchema.safeParse({ ...base });
    expect(r.success).toBe(true);
  });

  it("rejects an unsupported language at create time", () => {
    const r = CreateClientSchema.safeParse({ ...base, defaultLanguage: "fr" });
    expect(r.success).toBe(false);
  });
});

describe("UpdateClientSchema.defaultLanguage", () => {
  it("accepts a workspace-language update to es", () => {
    const r = UpdateClientSchema.safeParse({ defaultLanguage: "es" });
    expect(r.success).toBe(true);
  });

  it("accepts a workspace-language update to en", () => {
    const r = UpdateClientSchema.safeParse({ defaultLanguage: "en" });
    expect(r.success).toBe(true);
  });

  it("rejects an unsupported language at update time", () => {
    const r = UpdateClientSchema.safeParse({ defaultLanguage: "zh" });
    expect(r.success).toBe(false);
  });

  it("rejects nonsense input", () => {
    const r = UpdateClientSchema.safeParse({ defaultLanguage: 42 });
    expect(r.success).toBe(false);
  });
});

describe("ContentPreferencesUpdateSchema.defaultLanguage", () => {
  it("accepts a per-workspace defaultLanguage override", () => {
    const r = ContentPreferencesUpdateSchema.safeParse({ defaultLanguage: "es" });
    expect(r.success).toBe(true);
  });

  it("accepts null (meaning 'inherit from Client.defaultLanguage')", () => {
    const r = ContentPreferencesUpdateSchema.safeParse({ defaultLanguage: null });
    expect(r.success).toBe(true);
  });

  it("accepts omitting the field entirely (partial update)", () => {
    const r = ContentPreferencesUpdateSchema.safeParse({});
    expect(r.success).toBe(true);
  });

  it("rejects an unsupported language", () => {
    const r = ContentPreferencesUpdateSchema.safeParse({ defaultLanguage: "fr" });
    expect(r.success).toBe(false);
  });
});
