// industry-03 — module registry contract tests.
//
// Confirms:
//   - getIndustryModule resolves strictly; null/unknown → null.
//   - getIndustryModuleOrGeneric returns generic for null/unknown
//     (never silently real-estate).
//   - real_estate module's RE-only campaign instructions resolve.
//   - generic module rejects RE-only campaign instructions.
//   - real_estate fabrication rules extend the neutral baseline.
//   - generic fabrication rules contain no RE terminology.
//   - isIndustryFeatureSupported correctly reports autopilot
//     availability per industry.

import { describe, it, expect } from "vitest";
import {
  getIndustryModule,
  getIndustryModuleOrGeneric,
  getGenericIndustryModule,
  isIndustryFeatureSupported,
  listRegisteredIndustryKeys,
} from "../domains/industry/modules/index.js";

describe("module loader resolution", () => {
  it("getIndustryModule('real_estate') returns the real estate module", () => {
    const m = getIndustryModule("real_estate");
    expect(m).toBeTruthy();
    expect(m.key).toBe("real_estate");
    expect(m.label).toBe("Real Estate");
  });

  it("getIndustryModule(null) returns null (strict — no silent fallback)", () => {
    expect(getIndustryModule(null)).toBeNull();
    expect(getIndustryModule(undefined)).toBeNull();
    expect(getIndustryModule("")).toBeNull();
    expect(getIndustryModule("not_an_industry")).toBeNull();
  });

  it("getIndustryModuleOrGeneric(null) returns the generic module — NOT real estate", () => {
    const m = getIndustryModuleOrGeneric(null);
    expect(m.key).toBe("generic");
    expect(m.key).not.toBe("real_estate");
  });

  it("getIndustryModuleOrGeneric('not_an_industry') returns generic, not real estate", () => {
    expect(getIndustryModuleOrGeneric("not_an_industry").key).toBe("generic");
  });

  it("getIndustryModuleOrGeneric('real_estate') returns the real estate module", () => {
    expect(getIndustryModuleOrGeneric("real_estate").key).toBe("real_estate");
  });

  it("getGenericIndustryModule is the same module the loader falls back to", () => {
    expect(getGenericIndustryModule().key).toBe("generic");
  });

  it("listRegisteredIndustryKeys lists concrete industries (not 'generic')", () => {
    const keys = listRegisteredIndustryKeys();
    expect(keys).toContain("real_estate");
    expect(keys).not.toContain("generic");
  });
});

describe("real_estate module — promptAddons", () => {
  const m = getIndustryModule("real_estate");

  it("resolves real-estate campaign type instructions", () => {
    expect(m.promptAddons.getCampaignTypeInstructions("just_listed")).toMatch(
      /JUST LISTED/,
    );
    expect(m.promptAddons.getCampaignTypeInstructions("open_house")).toMatch(
      /OPEN HOUSE/,
    );
    expect(m.promptAddons.getCampaignTypeInstructions("price_drop")).toMatch(
      /PRICE DROP/,
    );
  });

  it("falls through to generic for cross-industry campaign types", () => {
    expect(m.promptAddons.getCampaignTypeInstructions("awareness")).toMatch(
      /AWARENESS/,
    );
    expect(
      m.promptAddons.getCampaignTypeInstructions("educational"),
    ).toMatch(/EDUCATIONAL/);
  });

  it("returns null for unknown campaign types", () => {
    expect(m.promptAddons.getCampaignTypeInstructions("not_a_type")).toBeNull();
    expect(m.promptAddons.getCampaignTypeInstructions(null)).toBeNull();
  });

  it("fabrication rules extend the neutral baseline with RE-specific items", () => {
    const rules = m.promptAddons.getFactsLlmMayNotFabricate();
    // RE-specific items present
    expect(rules.join("\n")).toMatch(/school ratings/i);
    expect(rules.join("\n")).toMatch(/mortgage rates/i);
    expect(rules.join("\n")).toMatch(/days on market/i);
    // Neutral baseline still in there
    expect(rules.join("\n")).toMatch(/prices, fees, or financial terms/i);
  });
});

describe("generic module — promptAddons", () => {
  const m = getGenericIndustryModule();

  it("does NOT resolve real-estate-only campaign types", () => {
    expect(m.promptAddons.getCampaignTypeInstructions("just_listed")).toBeNull();
    expect(m.promptAddons.getCampaignTypeInstructions("open_house")).toBeNull();
    expect(m.promptAddons.getCampaignTypeInstructions("price_drop")).toBeNull();
    expect(m.promptAddons.getCampaignTypeInstructions("just_sold")).toBeNull();
    expect(m.promptAddons.getCampaignTypeInstructions("listing_spotlight")).toBeNull();
  });

  it("DOES resolve cross-industry campaign types", () => {
    expect(m.promptAddons.getCampaignTypeInstructions("awareness")).toMatch(
      /AWARENESS/,
    );
    expect(m.promptAddons.getCampaignTypeInstructions("lead_generation")).toMatch(
      /LEAD GENERATION/,
    );
    expect(m.promptAddons.getCampaignTypeInstructions("promotion_offer")).toMatch(
      /PROMOTION/,
    );
  });

  it("fabrication rules contain no real-estate terminology", () => {
    const rules = m.promptAddons.getFactsLlmMayNotFabricate().join("\n");
    expect(rules).not.toMatch(/school/i);
    expect(rules).not.toMatch(/mortgage/i);
    expect(rules).not.toMatch(/MLS/);
    expect(rules).not.toMatch(/listing/i);
    expect(rules).not.toMatch(/walkability/i);
    expect(rules).not.toMatch(/days on market/i);
  });
});

describe("isIndustryFeatureSupported", () => {
  it("real_estate supports autopilot (has trigger types defined)", () => {
    expect(isIndustryFeatureSupported("real_estate", "autopilot")).toBe(true);
  });

  it("generic / null / unknown do NOT support autopilot", () => {
    expect(isIndustryFeatureSupported(null, "autopilot")).toBe(false);
    expect(isIndustryFeatureSupported(undefined, "autopilot")).toBe(false);
    expect(isIndustryFeatureSupported("not_an_industry", "autopilot")).toBe(false);
  });

  it("no industry currently supports urlExtraction at the module level (industry-04 may move that)", () => {
    expect(isIndustryFeatureSupported("real_estate", "urlExtraction")).toBe(false);
    expect(isIndustryFeatureSupported(null, "urlExtraction")).toBe(false);
  });

  it("unknown feature names return false", () => {
    expect(isIndustryFeatureSupported("real_estate", "made_up_feature")).toBe(false);
  });
});

describe("campaignTypes + siteTemplates surface", () => {
  it("real_estate ships RE-specific campaign types + site templates", () => {
    const m = getIndustryModule("real_estate");
    const values = m.campaignTypes.map((c) => c.value);
    expect(values).toContain("just_listed");
    expect(values).toContain("open_house");
    expect(values).toContain("price_drop");
    const templateKeys = m.siteTemplates.map((t) => t.key);
    expect(templateKeys).toContain("property_listing");
    expect(templateKeys).toContain("open_house");
  });

  it("generic ships neutral campaign types + site templates", () => {
    const m = getGenericIndustryModule();
    const values = m.campaignTypes.map((c) => c.value);
    expect(values).toContain("awareness");
    expect(values).toContain("lead_generation");
    // No RE-specific values:
    expect(values).not.toContain("just_listed");
    expect(values).not.toContain("open_house");
    const templateKeys = m.siteTemplates.map((t) => t.key);
    expect(templateKeys).toContain("landing_page");
    expect(templateKeys).toContain("services_overview");
    // No RE-specific templates:
    expect(templateKeys).not.toContain("property_listing");
  });
});
