// Verifies the Phase 1 wiring without hitting OpenAI:
//   - prompt builders inject the Spanish directive when ctx.language === "es"
//   - prompt builders DON'T inject anything for "en" (or missing)
//   - GenerateContentSchema accepts an optional language field
//
// We exercise the real promptBuilder.js exports (buildSystemPrompt,
// buildUserPrompt, buildCampaignUserPrompt, buildRemixUserPrompt)
// with a minimal stub ctx because the prompt code path is pure —
// no DB, no provider, no I/O.

import { describe, it, expect } from "vitest";
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildCampaignUserPrompt,
  buildRemixUserPrompt,
} from "../domains/studio/generation/promptBuilder.js";
import { GenerateContentSchema } from "../domains/studio/studio.schemas.js";

function stubCtx(language) {
  return {
    language,
    client: { name: "Test Brand", industryKey: "real_estate" },
    industryKey: "real_estate",
    brand: { description: "A real estate brand" },
    voice: { tone: "warm", voiceRulesJson: { do: [], dont: [] }, contentBuckets: [] },
    media: null,
    brandPersona: null,
    channelSettings: [],
    contentBuckets: [],
    realEstateContext: null,
    techStackContext: null,
    performanceProfile: null,
    recentPosts: [],
  };
}

describe("Phase 1 — language directive injection", () => {
  describe("buildSystemPrompt", () => {
    it("does not include the Spanish directive when language is en", () => {
      const out = buildSystemPrompt(stubCtx("en"));
      expect(out).not.toContain("LANGUAGE INSTRUCTIONS");
      expect(out).not.toContain("Spanish");
    });
    it("does not include the directive when language is missing", () => {
      const out = buildSystemPrompt(stubCtx(undefined));
      expect(out).not.toContain("LANGUAGE INSTRUCTIONS");
    });
    it("includes the Spanish directive when language is es", () => {
      const out = buildSystemPrompt(stubCtx("es"));
      expect(out).toContain("LANGUAGE INSTRUCTIONS");
      expect(out).toContain("Spanish (es)");
      expect(out).toContain("Preserve brand names");
    });
  });

  describe("buildUserPrompt", () => {
    const baseArgs = {
      kind: "POST",
      channel: "INSTAGRAM",
      bucketKey: null,
      guidance: "Promote a new listing",
      templateType: "just_listed",
      dataItem: null,
      blueprint: null,
      realEstateAssets: null,
      contentAngle: null,
    };
    it("no directive for en", () => {
      const out = buildUserPrompt(stubCtx("en"), baseArgs);
      expect(out).not.toContain("LANGUAGE INSTRUCTIONS");
    });
    it("directive present for es", () => {
      const out = buildUserPrompt(stubCtx("es"), baseArgs);
      expect(out).toContain("LANGUAGE INSTRUCTIONS");
    });
  });

  describe("buildCampaignUserPrompt", () => {
    const listingData = { address: "123 Main St", price: 500000 };
    it("no directive for en", () => {
      const out = buildCampaignUserPrompt(
        stubCtx("en"),
        listingData,
        "just_listed",
        null,
        null,
        {},
      );
      expect(out).not.toContain("LANGUAGE INSTRUCTIONS");
    });
    it("directive present for es", () => {
      const out = buildCampaignUserPrompt(
        stubCtx("es"),
        listingData,
        "just_listed",
        null,
        null,
        {},
      );
      expect(out).toContain("LANGUAGE INSTRUCTIONS");
      expect(out).toContain("Spanish (es)");
    });
  });

  describe("buildRemixUserPrompt", () => {
    it("no directive when language is en or omitted", () => {
      expect(buildRemixUserPrompt("Original post body", "INSTAGRAM")).not.toContain("LANGUAGE INSTRUCTIONS");
      expect(buildRemixUserPrompt("Original post body", "INSTAGRAM", "en")).not.toContain("LANGUAGE INSTRUCTIONS");
    });
    it("includes directive when language is es", () => {
      const out = buildRemixUserPrompt("Original post body", "INSTAGRAM", "es");
      expect(out).toContain("LANGUAGE INSTRUCTIONS");
    });
  });
});

describe("Phase 1 — schema acceptance", () => {
  const baseValid = {
    clientId: "client_123",
    kind: "POST",
    channel: "INSTAGRAM",
    guidance: "Promote a thing.",
  };

  it("accepts language: 'en'", () => {
    const parsed = GenerateContentSchema.safeParse({ ...baseValid, language: "en" });
    expect(parsed.success).toBe(true);
    expect(parsed.data.language).toBe("en");
  });

  it("accepts language: 'es'", () => {
    const parsed = GenerateContentSchema.safeParse({ ...baseValid, language: "es" });
    expect(parsed.success).toBe(true);
    expect(parsed.data.language).toBe("es");
  });

  it("treats missing language as undefined (backwards compatible)", () => {
    const parsed = GenerateContentSchema.safeParse(baseValid);
    expect(parsed.success).toBe(true);
    expect(parsed.data.language).toBeUndefined();
  });

  it("rejects unsupported language codes at the schema layer", () => {
    const parsed = GenerateContentSchema.safeParse({ ...baseValid, language: "fr" });
    expect(parsed.success).toBe(false);
  });
});
