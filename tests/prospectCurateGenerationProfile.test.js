import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildResponseFormat,
  buildUserPrompt,
  CONTENT_OUTPUT_SCHEMA,
  GROUNDED_PROPERTY_OUTPUT_SCHEMA,
} from "../domains/studio/generation/promptBuilder.js";
import {
  buildProspectAttemptGuidance,
  buildVerifiedPropertyFallback,
  evaluateProspectGenerationAttempt,
  validateGeneratedPropertyBody,
} from "../domains/prospects/prospect.service.js";

const item = {
  id: "property-1",
  type: "PROPERTY",
  title: "10 Main St, Town, OH 45000",
  summary: "",
  dataJson: {
    street: "10 Main St",
    city: "Town",
    state: "OH",
    zip: "45000",
    price: 300000,
    bedrooms: 3,
    bathrooms: 2,
    sqft: 1800,
    yearBuilt: 1990,
  },
};

const ctx = {
  industryKey: "real_estate",
  industryContext: { label: "Real Estate" },
  contentBuckets: [{ key: "just_listed", label: "Just listed", template: "Tell a neighborhood story" }],
  channelSettings: [],
  techStackContext: null,
  language: "en",
};

function args(overrides = {}) {
  return {
    kind: "POST",
    channel: "FACEBOOK",
    bucketKey: "just_listed",
    templateType: "just_listed",
    guidance: buildProspectAttemptGuidance({ item, channel: "FACEBOOK", attempt: 1 }),
    dataItem: item,
    blueprint: null,
    realEstateAssets: { bestListing: null, reviews: [] },
    contentAngle: null,
    ...overrides,
  };
}

describe("Admin Curate grounded property generation profile", () => {
  it("uses a dedicated structured contract without general campaign contradictions", () => {
    const prompt = buildUserPrompt(ctx, args({ generationProfile: "grounded_property" }));
    expect(buildResponseFormat("grounded_property").json_schema).toBe(GROUNDED_PROPERTY_OUTPUT_SCHEMA);
    expect(prompt).toContain("GROUNDED PROPERTY OUTPUT CONTRACT");
    expect(prompt).toContain("hooks must contain exactly one neutral opening line");
    expect(prompt).not.toContain("Generate 3 distinct variations");
    expect(prompt).not.toContain("generate 5–10 scored opening hooks");
    expect(prompt).not.toContain("give context about the neighborhood or market");
    expect(prompt).not.toContain("Tell a neighborhood story");
  });

  it("leaves the normal campaign generation contract unchanged", () => {
    const prompt = buildUserPrompt(ctx, args());
    expect(buildResponseFormat().json_schema).toBe(CONTENT_OUTPUT_SCHEMA);
    expect(prompt).toContain("Generate 3 distinct variations");
    expect(prompt).toContain("generate 5–10 scored opening hooks");
    expect(prompt).toContain("give context about the neighborhood or market");
  });

  it("accepts valid primary output and preserves differentiated platform assembly", () => {
    const drafts = {
      INSTAGRAM: { hooks: ["Take a look at this new listing"], body: "10 Main St in Town is listed at $300,000. The property has 3 bedrooms, 2 bathrooms, and 1,800 sq ft.", cta: "Message us to request details or schedule a showing.", hashtags: ["JustListed", "TownOH", "RealEstate"] },
      FACEBOOK: { hooks: ["A new property is now available"], body: "10 Main St in Town is listed at $300,000. It includes 3 bedrooms, 2 bathrooms, and 1,800 sq ft.", cta: "Contact us to request the complete listing details.", hashtags: [] },
      LINKEDIN: { hooks: ["New property listing"], body: "10 Main St in Town is listed at $300,000. The listing includes 3 bedrooms, 2 bathrooms, and 1,800 sq ft.", cta: "Contact the listing business for complete details.", hashtags: ["RealEstate", "PropertyListing"] },
    };
    const bodies = Object.entries(drafts).map(([channel, draft]) => {
      const outcome = evaluateProspectGenerationAttempt(draft, item, channel);
      expect(outcome.validation).toEqual({ valid: true });
      return outcome.body;
    });
    expect(new Set(bodies).size).toBe(3);
    expect(bodies.some((body) => body.includes("PROSPECT_PROPERTY_VERIFIED_FALLBACK"))).toBe(false);
  });

  it("rejects unsupported primary output while keeping the final fallback factual", () => {
    const invalid = { hooks: ["A stunning opportunity"], body: "This spacious home offers natural light and modern living.", cta: "Contact us for details.", hashtags: [] };
    const outcome = evaluateProspectGenerationAttempt(invalid, item, "FACEBOOK");
    expect(outcome.validation.valid).toBe(false);
    expect(["UNSAFE_HOOK", "UNSUPPORTED_PROPERTY_CLAIM", "INCOMPLETE_OUTPUT_CONTRACT"]).toContain(outcome.validation.reason);

    const fallback = buildVerifiedPropertyFallback(item, "FACEBOOK", "Agent Realty");
    expect(validateGeneratedPropertyBody(fallback, item)).toEqual({ valid: true });
  });

  it("wires Curate to the canonical generator profile and retains three-attempt exhaustion", () => {
    const source = readFileSync(join(process.cwd(), "domains/prospects/prospect.service.js"), "utf8");
    expect(source).toContain('generationProfile: "grounded_property"');
    expect(source).toMatch(/for \(let attempt = 1; attempt <= 3 && !accepted; attempt \+= 1\)/);
    expect(source).toContain('status: "FALLBACK_ACCEPTED"');
    expect(source).toContain('logEvent("prospect.generation.attempt_rejected"');
  });
});
