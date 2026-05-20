// industry-02 — content generation prompts must NOT mention
// property / listing / MLS / beds / baths / sqft / open house /
// school districts / mortgage rates for no-industry or non-RE
// workspaces. Real-estate guidance is correctly gated behind
// `industryKey === "real_estate"` — these tests lock that in.

import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../domains/studio/generation/promptBuilder.js";

function buildCtx(overrides = {}) {
  return {
    client: { name: "Test Workspace" },
    brand: null,
    voice: null,
    industryContext: null,
    industryKey: null,
    realEstateContext: null,
    techStackContext: null,
    ...overrides,
  };
}

describe("promptBuilder.buildSystemPrompt — industry safety", () => {
  it("null industryKey prompt does NOT include real-estate-specific content rules", () => {
    const prompt = buildSystemPrompt(buildCtx({ industryKey: null }));
    // Hard real-estate vocabulary that would be wrong for any
    // non-RE business.
    expect(prompt).not.toMatch(/REAL ESTATE SPECIALIZATION/i);
    expect(prompt).not.toMatch(/\blistings?\b/i);
    expect(prompt).not.toMatch(/\bMLS\b/);
    expect(prompt).not.toMatch(/\bbeds\/baths\b/i);
    expect(prompt).not.toMatch(/\bsquare footage\b/i);
    expect(prompt).not.toMatch(/open house/i);
    expect(prompt).not.toMatch(/school ratings/i);
    expect(prompt).not.toMatch(/mortgage rates/i);
    expect(prompt).not.toMatch(/HOA fees/i);
  });

  it("real_estate industryKey + realEstateContext DOES include the RE specialization", () => {
    const prompt = buildSystemPrompt(
      buildCtx({
        industryKey: "real_estate",
        realEstateContext: {
          businessProfile: { businessName: "Smith Realty" },
          assets: { listingCount: 3, reviewCount: 5 },
        },
      }),
    );
    expect(prompt).toMatch(/REAL ESTATE SPECIALIZATION/);
    expect(prompt).toMatch(/Active listings: 3/);
    expect(prompt).toMatch(/beds\/baths/);
    expect(prompt).toMatch(/Open house/);
  });

  it("real_estate industryKey WITHOUT realEstateContext skips the specialization block (no fabricated content)", () => {
    const prompt = buildSystemPrompt(
      buildCtx({ industryKey: "real_estate", realEstateContext: null }),
    );
    // Specialization block is gated on BOTH industryKey AND
    // realEstateContext being present, so a misconfigured RE
    // workspace doesn't get nonsense like "Active listings: 0".
    expect(prompt).not.toMatch(/REAL ESTATE SPECIALIZATION/);
  });

  it("car_sales industryKey (no RE context) does NOT include the RE specialization", () => {
    const prompt = buildSystemPrompt(
      buildCtx({ industryKey: "car_sales", realEstateContext: null }),
    );
    expect(prompt).not.toMatch(/REAL ESTATE SPECIALIZATION/);
    expect(prompt).not.toMatch(/listings/i);
  });
});
