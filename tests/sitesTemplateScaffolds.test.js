// Sites-05 — template scaffolds + grounding rules.
//
// Pins:
//   - SITE_TEMPLATES catalog (six entries, expected goals)
//   - applyTemplateScaffold inserts missing required block types
//   - applyTemplateScaffold preserves LLM-emitted extras + order
//   - applyTemplateScaffold is idempotent
//   - Unknown templates are a noop
//   - The schema accepts the six valid templates and rejects others
//
// The system prompt is not exported, but the FACTS_LLM_MAY_NOT_FABRICATE
// list is the contract — we pin it indirectly via the schema enum.

import { describe, it, expect } from "vitest";
import {
  SITE_TEMPLATES,
  applyTemplateScaffold,
} from "../domains/sites/sites.generation.service.js";
import { GeneratePageSchema, SiteTemplateEnum } from "../domains/sites/sites.schemas.js";

describe("SITE_TEMPLATES catalog", () => {
  it("exposes the six expected templates", () => {
    expect(Object.keys(SITE_TEMPLATES).sort()).toEqual(
      [
        "buyer_lead",
        "just_sold",
        "neighborhood_guide",
        "open_house",
        "property_listing",
        "seller_lead",
      ].sort(),
    );
  });

  it.each([
    ["property_listing", "LISTING"],
    ["open_house", "EVENT"],
    ["just_sold", "LEAD_CAPTURE"],
    ["seller_lead", "LEAD_CAPTURE"],
    ["buyer_lead", "LEAD_CAPTURE"],
    ["neighborhood_guide", "LEAD_CAPTURE"],
  ])("template %s defaults to pageGoal %s", (key, expected) => {
    expect(SITE_TEMPLATES[key].pageGoal).toBe(expected);
  });

  it("every template lists at least one block + a hero", () => {
    for (const tpl of Object.values(SITE_TEMPLATES)) {
      expect(tpl.blocks.length).toBeGreaterThan(0);
      expect(tpl.blocks[0]).toBe("hero");
    }
  });

  it("just_sold template explicitly forbids quoting sale price", () => {
    expect(SITE_TEMPLATES.just_sold.intent).toMatch(/do not quote the sale price/i);
  });

  it("neighborhood_guide explicitly forbids inventing facts", () => {
    expect(SITE_TEMPLATES.neighborhood_guide.intent).toMatch(/do not invent/i);
  });
});

describe("applyTemplateScaffold", () => {
  const payload = (blocks) => ({
    title: "Test page",
    slug: "test-page",
    description: null,
    seoTitle: null,
    seoDescription: null,
    blocksJson: blocks,
  });

  it("returns the payload unchanged for an unknown template", () => {
    const start = payload([{ type: "hero" }]);
    expect(applyTemplateScaffold(start, "bogus")).toBe(start);
  });

  it("returns the payload unchanged for missing template", () => {
    const start = payload([{ type: "hero" }]);
    expect(applyTemplateScaffold(start, undefined)).toBe(start);
  });

  it("appends missing required blocks for property_listing", () => {
    const start = payload([
      { type: "hero", headline: "X" },
      { type: "paragraph", body: "..." },
    ]);
    const out = applyTemplateScaffold(start, "property_listing");
    const types = out.blocksJson.map((b) => b.type);
    // Original blocks come first, scaffold appended for the rest.
    expect(types[0]).toBe("hero");
    expect(types[1]).toBe("paragraph");
    for (const expected of [
      "key_details",
      "gallery",
      "cta",
      "lead_form",
      "contact",
    ]) {
      expect(types).toContain(expected);
    }
  });

  it("preserves order of LLM-emitted blocks + appends scaffold only for missing types", () => {
    const start = payload([
      { type: "paragraph", body: "Body first" },
      { type: "hero", headline: "Hero second (unusual)" },
      { type: "gallery", imageUrls: ["x"] },
    ]);
    const out = applyTemplateScaffold(start, "property_listing");
    // Original three appear first in their original order.
    expect(out.blocksJson.slice(0, 3)).toEqual(start.blocksJson);
    // The appended blocks include the missing required types.
    const appendedTypes = out.blocksJson.slice(3).map((b) => b.type);
    expect(appendedTypes).toContain("key_details");
    expect(appendedTypes).toContain("cta");
    expect(appendedTypes).toContain("lead_form");
    expect(appendedTypes).toContain("contact");
  });

  it("is idempotent — applying twice yields the same payload", () => {
    const start = payload([{ type: "hero" }]);
    const once = applyTemplateScaffold(start, "just_sold");
    const twice = applyTemplateScaffold(once, "just_sold");
    expect(twice.blocksJson).toEqual(once.blocksJson);
  });

  it("appends a lead_form placeholder with formId='__PENDING__' so the route resolves it", () => {
    const out = applyTemplateScaffold(payload([{ type: "hero" }]), "seller_lead");
    const leadForm = out.blocksJson.find((b) => b.type === "lead_form");
    expect(leadForm).toBeDefined();
    expect(leadForm.formId).toBe("__PENDING__");
  });

  it("does not append blocks of type 'testimonial' (no fabricated quotes)", () => {
    for (const key of Object.keys(SITE_TEMPLATES)) {
      const out = applyTemplateScaffold(payload([{ type: "hero" }]), key);
      const hasTestimonial = out.blocksJson.some((b) => b.type === "testimonial");
      expect(hasTestimonial).toBe(false);
    }
  });
});

describe("GeneratePageSchema — template field", () => {
  it("accepts the six valid templates", () => {
    for (const key of Object.keys(SITE_TEMPLATES)) {
      const parsed = GeneratePageSchema.safeParse({
        sourceType: "PROPERTY",
        sourceId: "x",
        pageGoal: "LISTING",
        template: key,
      });
      expect(parsed.success).toBe(true);
    }
  });

  it("rejects unknown template values", () => {
    const parsed = GeneratePageSchema.safeParse({
      sourceType: "PROPERTY",
      sourceId: "x",
      pageGoal: "LISTING",
      template: "bogus",
    });
    expect(parsed.success).toBe(false);
  });

  it("template is optional", () => {
    const parsed = GeneratePageSchema.safeParse({
      sourceType: "IDEA",
      pageGoal: "LEAD_CAPTURE",
      customPrompt: "Hello",
    });
    expect(parsed.success).toBe(true);
  });

  it("SiteTemplateEnum matches the catalog keys", () => {
    expect(SiteTemplateEnum.options.sort()).toEqual(Object.keys(SITE_TEMPLATES).sort());
  });
});
