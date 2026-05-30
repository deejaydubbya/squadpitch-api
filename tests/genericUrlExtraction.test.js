// industry-04 — generic URL extractor.
//
// Tests that the neutral analyzer produces the documented shape
// and contains NO real-estate fields (no `property`, no `listing`,
// no `beds`/`baths`/`sqft`/`MLS`).

import { describe, it, expect, vi, beforeEach } from "vitest";

const scrapeUrlMock = vi.fn();
vi.mock("../domains/studio/scrapeUrl.js", () => ({
  scrapeUrl: (...args) => scrapeUrlMock(...args),
  filterPropertyImages: vi.fn((arr) => arr),
}));

const { analyzeGenericUrl } = await import(
  "../domains/industry/modules/generic/urlExtraction.js"
);

beforeEach(() => {
  scrapeUrlMock.mockReset();
});

describe("analyzeGenericUrl — shape contract", () => {
  it("returns the documented neutral shape on a healthy scrape", async () => {
    scrapeUrlMock.mockResolvedValueOnce({
      text: "Welcome to Acme. We do widgets.",
      title: "Acme Widgets",
      metaDescription: "Premium widgets since 1987.",
      ogImage: "https://example.com/og.png",
      images: ["https://example.com/img1.jpg", "https://example.com/img2.jpg"],
      links: ["https://example.com/about", "https://example.com/contact"],
    });
    const r = await analyzeGenericUrl("https://example.com/");
    expect(r).toMatchObject({
      kind: "generic_url",
      url: "https://example.com/",
      title: "Acme Widgets",
      description: "Premium widgets since 1987.",
      siteName: expect.any(String),
      ogImage: "https://example.com/og.png",
      detectedBusinessName: expect.any(String),
    });
    expect(Array.isArray(r.images)).toBe(true);
    expect(Array.isArray(r.links)).toBe(true);
    expect(Array.isArray(r.warnings)).toBe(true);
    expect(typeof r.confidence).toBe("number");
    expect(r.confidence).toBeGreaterThan(0);
    expect(r.confidence).toBeLessThanOrEqual(0.9);
  });

  it("returns NO property / listing fields (key contract)", async () => {
    scrapeUrlMock.mockResolvedValueOnce({
      text: "Some business page",
      title: "Test",
      metaDescription: "x",
      ogImage: null,
      images: [],
      links: [],
    });
    const r = await analyzeGenericUrl("https://example.com/");
    // The neutral shape must not include any of these:
    for (const k of [
      "property",
      "listing",
      "address",
      "beds",
      "baths",
      "sqft",
      "price",
      "propertyType",
      "mls",
      "openHouse",
    ]) {
      expect(r).not.toHaveProperty(k);
    }
  });

  it("derives siteName from a 'Title | Site' pattern when present", async () => {
    scrapeUrlMock.mockResolvedValueOnce({
      text: "x",
      title: "Pricing | Stripe",
      metaDescription: null,
      ogImage: null,
      images: [],
      links: [],
    });
    const r = await analyzeGenericUrl("https://stripe.com/pricing");
    expect(r.siteName).toBe("Stripe");
  });

  it("falls back to hostname for siteName when title has no separator", async () => {
    scrapeUrlMock.mockResolvedValueOnce({
      text: "x",
      title: "Welcome",
      metaDescription: null,
      ogImage: null,
      images: [],
      links: [],
    });
    const r = await analyzeGenericUrl("https://www.acme.com/");
    expect(r.siteName).toBe("acme.com");
  });

  it("truncates body summary at a sentence boundary near 600 chars", async () => {
    const longBody =
      "This is sentence one. ".repeat(60) + "Trailing sentence that runs past the limit.";
    scrapeUrlMock.mockResolvedValueOnce({
      text: longBody,
      title: "Long page",
      metaDescription: null,
      ogImage: null,
      images: [],
      links: [],
    });
    const r = await analyzeGenericUrl("https://example.com/long");
    expect(r.bodySummary).toBeTruthy();
    expect(r.bodySummary.length).toBeLessThanOrEqual(600);
  });

  it("returns a low-confidence stub when scrape throws (no crash)", async () => {
    scrapeUrlMock.mockRejectedValueOnce(new Error("blocked"));
    const r = await analyzeGenericUrl("https://example.com/blocked");
    expect(r.kind).toBe("generic_url");
    expect(r.confidence).toBe(0);
    expect(r.title).toBeNull();
    expect(r.warnings.length).toBeGreaterThan(0);
    expect(r.warnings[0]).toMatch(/scrape/i);
  });

  it("warns when scrape returned no title and no body text", async () => {
    scrapeUrlMock.mockResolvedValueOnce({
      text: "",
      title: "",
      metaDescription: "",
      ogImage: null,
      images: [],
      links: [],
    });
    const r = await analyzeGenericUrl("https://example.com/empty");
    expect(r.confidence).toBe(0);
    expect(r.warnings.some((w) => /blocking/i.test(w) || /title/i.test(w))).toBe(true);
  });
});
