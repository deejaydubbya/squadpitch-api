// Sites-02 — deterministic property field application.
//
// Pins:
//   - hero blocks get the property primary image
//   - key_details blocks get items derived from price / beds / baths
//     / sqft / type / year / status (only present-fields rendered)
//   - gallery blocks get the property's photo URLs
//   - image blocks get the primary image when one is missing
//   - title + slug derived from the property's address when LLM
//     returned a placeholder
//   - non-property block types pass through unchanged
//   - idempotent — applying twice gives the same payload

import { describe, it, expect } from "vitest";
import { applyPropertyDeterministicFields } from "../domains/sites/sites.generation.service.js";

function property(extra = {}) {
  return {
    id: "prop-1",
    title: "508 King George Court",
    dataJson: {
      street: "508 King George Court",
      city: "Springboro",
      state: "OH",
      zip: "45066",
      price: 425000,
      bedrooms: 4,
      bathrooms: 3,
      sqft: 2840,
      propertyType: "single_family",
      yearBuilt: 2008,
      status: "active",
      imageUrl: "https://cdn/hero.jpg",
      images: ["https://cdn/hero.jpg", "https://cdn/2.jpg", "https://cdn/3.jpg"],
      ...extra,
    },
  };
}

function basePayload(blocks) {
  return {
    title: "Untitled (listing)",
    slug: "untitled-listing",
    description: "LLM-written description.",
    seoTitle: null,
    seoDescription: null,
    blocksJson: blocks,
  };
}

describe("applyPropertyDeterministicFields", () => {
  it("overwrites hero imageUrl with the property primary image", () => {
    const out = applyPropertyDeterministicFields(
      basePayload([{ type: "hero", headline: "Welcome", subheadline: "Beautiful home" }]),
      property(),
    );
    expect(out.blocksJson[0]).toEqual({
      type: "hero",
      headline: "Welcome",
      subheadline: "Beautiful home",
      imageUrl: "https://cdn/hero.jpg",
    });
  });

  it("preserves LLM-written headline + subheadline (narrative copy stays)", () => {
    const out = applyPropertyDeterministicFields(
      basePayload([
        { type: "hero", headline: "A magical home", subheadline: "Yours to discover" },
      ]),
      property(),
    );
    expect(out.blocksJson[0].headline).toBe("A magical home");
    expect(out.blocksJson[0].subheadline).toBe("Yours to discover");
  });

  it("builds key_details items from property facts", () => {
    const out = applyPropertyDeterministicFields(
      basePayload([{ type: "key_details", heading: "Details", items: [] }]),
      property(),
    );
    expect(out.blocksJson[0].items).toEqual([
      { label: "Price", value: "$425,000" },
      { label: "Beds", value: "4" },
      { label: "Baths", value: "3" },
      { label: "Sq Ft", value: "2,840" },
      { label: "Type", value: "single_family" },
      { label: "Year Built", value: "2008" },
      { label: "Status", value: "active" },
    ]);
  });

  it("only emits key_details rows for fields that exist", () => {
    const out = applyPropertyDeterministicFields(
      basePayload([{ type: "key_details", items: [] }]),
      {
        ...property(),
        dataJson: { street: "1 Main St", price: 250000, bedrooms: 2 },
      },
    );
    expect(out.blocksJson[0].items).toEqual([
      { label: "Price", value: "$250,000" },
      { label: "Beds", value: "2" },
    ]);
  });

  it("fills gallery imageUrls from property photos", () => {
    const out = applyPropertyDeterministicFields(
      basePayload([{ type: "gallery", imageUrls: ["https://placeholder/x.jpg"], layout: "grid" }]),
      property(),
    );
    expect(out.blocksJson[0].imageUrls).toEqual([
      "https://cdn/hero.jpg",
      "https://cdn/2.jpg",
      "https://cdn/3.jpg",
    ]);
  });

  it("fills image block imageUrl only when missing", () => {
    const out = applyPropertyDeterministicFields(
      basePayload([
        { type: "image", alt: "", caption: "" },
        { type: "image", imageUrl: "https://custom/keep.jpg", alt: "", caption: "" },
      ]),
      property(),
    );
    expect(out.blocksJson[0].imageUrl).toBe("https://cdn/hero.jpg");
    expect(out.blocksJson[1].imageUrl).toBe("https://custom/keep.jpg");
  });

  it("respects _photos[isPrimary] precedence", () => {
    const prop = property({
      _photos: [
        { url: "https://cdn/hero.jpg", source: "upload" },
        { url: "https://cdn/winner.jpg", source: "upload", isPrimary: true },
      ],
    });
    const out = applyPropertyDeterministicFields(
      basePayload([{ type: "hero", headline: "X" }]),
      prop,
    );
    expect(out.blocksJson[0].imageUrl).toBe("https://cdn/winner.jpg");
  });

  it("overwrites placeholder title + slug with the property address", () => {
    const out = applyPropertyDeterministicFields(basePayload([]), property());
    expect(out.title).toBe("508 King George Court, Springboro, OH, 45066");
    expect(out.slug).toBe("508-king-george-court-springboro-oh-45066");
  });

  it("keeps LLM-set title when it's non-placeholder", () => {
    const out = applyPropertyDeterministicFields(
      { ...basePayload([]), title: "Open House Saturday" },
      property(),
    );
    expect(out.title).toBe("Open House Saturday");
  });

  it("leaves non-targeted blocks untouched", () => {
    const out = applyPropertyDeterministicFields(
      basePayload([
        { type: "paragraph", body: "LLM body" },
        { type: "cta", label: "Tour", href: "#tour" },
        { type: "faq", items: [{ question: "Q", answer: "A" }] },
      ]),
      property(),
    );
    expect(out.blocksJson[0]).toEqual({ type: "paragraph", body: "LLM body" });
    expect(out.blocksJson[1]).toEqual({ type: "cta", label: "Tour", href: "#tour" });
    expect(out.blocksJson[2].items).toEqual([{ question: "Q", answer: "A" }]);
  });

  it("is idempotent — applying twice yields the same payload", () => {
    const start = basePayload([
      { type: "hero", headline: "H" },
      { type: "key_details", items: [] },
      { type: "gallery", imageUrls: [], layout: "grid" },
    ]);
    const once = applyPropertyDeterministicFields(start, property());
    const twice = applyPropertyDeterministicFields(once, property());
    expect(twice).toEqual(once);
  });

  it("returns input unchanged when source is missing", () => {
    const start = basePayload([{ type: "hero", headline: "H" }]);
    expect(applyPropertyDeterministicFields(start, null)).toBe(start);
  });

  it("safely handles a property with no photos / partial data", () => {
    const out = applyPropertyDeterministicFields(
      basePayload([
        { type: "hero", headline: "X" },
        { type: "key_details", items: [] },
        { type: "gallery", imageUrls: ["existing.jpg"], layout: "grid" },
      ]),
      { id: "prop-2", title: "Sparse", dataJson: { street: "1 Main St", bedrooms: 2 } },
    );
    // Hero: no primaryImage → imageUrl untouched.
    expect(out.blocksJson[0].imageUrl).toBeUndefined();
    // Key details: only beds row.
    expect(out.blocksJson[1].items).toEqual([{ label: "Beds", value: "2" }]);
    // Gallery: no photos → existing list preserved.
    expect(out.blocksJson[2].imageUrls).toEqual(["existing.jpg"]);
  });
});
