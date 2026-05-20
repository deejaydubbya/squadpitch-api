// URL-01 — campaign URL intake service.
//
// Covers:
//   - Safe-URL validator rejects every unsafe scheme + host.
//   - analyzeUrl returns single_listing when ingestUrlListing
//     extracts good-quality data.
//   - analyzeUrl returns listing_index when the scrape exposes
//     multiple same-domain listing-like links.
//   - analyzeUrl rejects unsafe URLs BEFORE any scrape happens.
//   - confirmUrl returns dataItemId + createUrl for a new listing.
//   - confirmUrl on a duplicate returns existingId (bug 2 fix).
//   - confirmUrl rejects unsafe sourceUrl.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  get prisma() {
    return globalThis.__intakeFixtures?.prisma;
  },
}));

// We mock listingIngestion + scrapeUrl so analyzeUrl can be
// exercised deterministically — no real network, no real prisma
// dependency on the upstream side.
const ingestUrlListingMock = vi.fn();
const confirmUrlListingMock = vi.fn();
const scrapeUrlMock = vi.fn();

vi.mock("../domains/studio/listingIngestion.service.js", () => ({
  ingestUrlListing: (...args) => ingestUrlListingMock(...args),
  confirmUrlListing: (...args) => confirmUrlListingMock(...args),
}));

vi.mock("../domains/studio/scrapeUrl.js", () => ({
  scrapeUrl: (...args) => scrapeUrlMock(...args),
}));

const service = await import("../domains/studio/urlCampaignIntake.service.js");

const CLIENT_ID = "client-1";

beforeEach(() => {
  ingestUrlListingMock.mockReset();
  confirmUrlListingMock.mockReset();
  scrapeUrlMock.mockReset();
  // industry-01 — urlCampaignIntake.analyzeUrl now requires the
  // workspace to be real_estate (otherwise it returns the neutral
  // unsupported_industry response). Default the prisma mock to a
  // real-estate workspace so the existing analyze tests still
  // exercise the property-extraction path; individual tests can
  // override globalThis.__intakeFixtures to flip industryKey.
  globalThis.__intakeFixtures = {
    prisma: {
      client: {
        findUnique: vi.fn(async () => ({ industryKey: "real_estate" })),
      },
    },
  };
});

// ── Safe URL validator ─────────────────────────────────────────

describe("assertSafeExternalUrl", () => {
  it("returns a parsed URL for ordinary https addresses", () => {
    const parsed = service.assertSafeExternalUrl("https://example.com/listing/123");
    expect(parsed.hostname).toBe("example.com");
  });

  it("rejects javascript:, data:, file:, vbscript: schemes", () => {
    for (const bad of [
      "javascript:alert(1)",
      "data:text/html,<script>",
      "file:///etc/passwd",
      "vbscript:msgbox",
    ]) {
      expect(() => service.assertSafeExternalUrl(bad)).toThrow(/not allowed/i);
    }
  });

  it("rejects non-http(s) protocols", () => {
    expect(() => service.assertSafeExternalUrl("ftp://example.com/foo")).toThrow(/http/);
  });

  it("rejects localhost + loopback + unspecified hosts", () => {
    for (const bad of [
      "http://localhost/",
      "http://127.0.0.1/",
      "http://0.0.0.0/",
      "http://127.10.20.30/",
    ]) {
      expect(() => service.assertSafeExternalUrl(bad)).toThrow(/not allowed/i);
    }
  });

  it("rejects private IPv4 ranges (10/8, 172.16/12, 192.168/16, 169.254/16, 100.64/10)", () => {
    for (const bad of [
      "http://10.0.0.1/",
      "http://10.255.255.255/",
      "http://172.16.0.1/",
      "http://172.31.255.255/",
      "http://192.168.1.1/",
      "http://169.254.169.254/", // AWS metadata
      "http://100.64.1.1/",
    ]) {
      expect(() => service.assertSafeExternalUrl(bad)).toThrow(/not allowed/i);
    }
  });

  it("permits public IPv4 addresses outside private ranges", () => {
    expect(() => service.assertSafeExternalUrl("http://8.8.8.8/")).not.toThrow();
    expect(() => service.assertSafeExternalUrl("http://203.0.113.5/")).not.toThrow();
  });

  it("rejects malformed input cleanly with UNSAFE_URL", () => {
    try {
      service.assertSafeExternalUrl("not a url");
      throw new Error("expected throw");
    } catch (err) {
      expect(err.code).toBe("UNSAFE_URL");
      expect(err.status).toBe(400);
    }
  });

  it("rejects empty / non-string input", () => {
    expect(() => service.assertSafeExternalUrl("")).toThrow();
    expect(() => service.assertSafeExternalUrl(null)).toThrow();
    expect(() => service.assertSafeExternalUrl(undefined)).toThrow();
  });
});

// ── analyzeUrl ─────────────────────────────────────────────────

function goodSingleListing(url = "https://example.com/listing/123") {
  return {
    preview: {
      title: "508 King George Court",
      price: 365000,
      address: { street: "508 King George Court", city: "Cary" },
      validation: { valid: true, issues: [] },
    },
    normalized: {
      title: "508 King George Court",
      price: 365000,
      address: { street: "508 King George Court", city: "Cary" },
      beds: 4,
      baths: 3,
      sqft: 2100,
    },
    quality: { grade: "good", score: 75 },
  };
}

describe("analyzeUrl — single listing path", () => {
  it("returns single_listing with a preview when ingestUrlListing reports good quality", async () => {
    ingestUrlListingMock.mockResolvedValue(goodSingleListing());
    const out = await service.analyzeUrl(CLIENT_ID, {
      url: "https://example.com/listing/123",
    });
    expect(out.detectedType).toBe("single_listing");
    expect(out.confidence).toBeGreaterThanOrEqual(0.6);
    expect(out.listings).toHaveLength(1);
    expect(out.listings[0].sourceUrl).toBe("https://example.com/listing/123");
    expect(out.listings[0].previewId).toMatch(/^[a-f0-9]{20}$/);
    expect(out.listings[0].normalized.title).toBe("508 King George Court");
    expect(out.suggestedNextStep).toBe("review_listing");
    // The scrape path is the fallback; should not run when the
    // single attempt already won.
    expect(scrapeUrlMock).not.toHaveBeenCalled();
  });
});

describe("analyzeUrl — listing index path", () => {
  it("returns listing_index with multiple unique previews when many listing-like links exist", async () => {
    // First call (single attempt) returns weak data so we
    // proceed to the scrape + crawl path.
    ingestUrlListingMock.mockResolvedValueOnce({
      preview: null,
      normalized: { price: null, address: null },
      quality: { grade: "poor", score: 5 },
    });
    // Then the index scrape exposes 3 listing-like links.
    scrapeUrlMock.mockResolvedValue({
      text: "Welcome to our listings",
      title: "Our Listings",
      images: [],
      links: [
        "https://example.com/listing/12345-elm-st",
        "https://example.com/listing/67890-oak-rd",
        "https://example.com/listing/abcdef-pine-ave",
        "https://example.com/about", // not a listing path → filtered
        "https://other.com/listing/xyz", // cross-domain → filtered
      ],
    });
    // Each per-listing ingest gets a distinct address so dedupe
    // doesn't collapse them.
    ingestUrlListingMock
      .mockResolvedValueOnce({
        normalized: { title: "12345 Elm St", price: 350000, address: { street: "12345 Elm St" } },
        quality: { grade: "good", score: 60 },
        preview: { validation: { valid: true } },
      })
      .mockResolvedValueOnce({
        normalized: { title: "67890 Oak Rd", price: 425000, address: { street: "67890 Oak Rd" } },
        quality: { grade: "good", score: 65 },
        preview: { validation: { valid: true } },
      })
      .mockResolvedValueOnce({
        normalized: { title: "Pine Ave", price: 510000, address: { street: "Pine Ave" } },
        quality: { grade: "good", score: 70 },
        preview: { validation: { valid: true } },
      });

    const out = await service.analyzeUrl(CLIENT_ID, {
      url: "https://example.com/listings",
    });
    expect(out.detectedType).toBe("listing_index");
    expect(out.listings.length).toBeGreaterThanOrEqual(2);
    expect(out.suggestedNextStep).toBe("choose_listing");
    // Cross-domain link filtered out — `other.com` should not appear.
    expect(out.listings.every((l) => l.sourceUrl.startsWith("https://example.com"))).toBe(true);
  });

  it("dedupes listings that share (title, address, price) signatures", async () => {
    ingestUrlListingMock.mockResolvedValueOnce({
      preview: null,
      normalized: {},
      quality: { grade: "poor", score: 5 },
    });
    scrapeUrlMock.mockResolvedValue({
      text: "x",
      title: "i",
      images: [],
      links: [
        "https://example.com/listing/elm-1",
        "https://example.com/listing/elm-1-duplicate",
        "https://example.com/listing/elm-1-mirror",
      ],
    });
    // All three "different" links yield the same normalized data
    // (same title + price + street) — should dedupe to one row.
    const same = {
      normalized: { title: "12345 Elm St", price: 350000, address: { street: "12345 Elm St" } },
      quality: { grade: "good", score: 60 },
      preview: { validation: { valid: true } },
    };
    ingestUrlListingMock.mockResolvedValueOnce(same).mockResolvedValueOnce(same).mockResolvedValueOnce(same);

    const out = await service.analyzeUrl(CLIENT_ID, {
      url: "https://example.com/listings",
    });
    // Only one unique listing survives the signature dedupe; the
    // index path requires ≥2 to claim listing_index. The page
    // therefore falls through to single_listing (confidence ≥0.3)
    // OR business_page. Either way, we should NOT report multiple
    // duplicate rows.
    expect(out.listings.length).toBeLessThanOrEqual(1);
  });
});

describe("analyzeUrl — safety", () => {
  it("rejects unsafe URLs BEFORE any scrape happens", async () => {
    await expect(
      service.analyzeUrl(CLIENT_ID, { url: "http://127.0.0.1/admin" }),
    ).rejects.toMatchObject({ code: "UNSAFE_URL" });
    expect(ingestUrlListingMock).not.toHaveBeenCalled();
    expect(scrapeUrlMock).not.toHaveBeenCalled();
  });

  it("rejects javascript: URLs", async () => {
    await expect(
      service.analyzeUrl(CLIENT_ID, { url: "javascript:alert(1)" }),
    ).rejects.toMatchObject({ code: "UNSAFE_URL" });
  });
});

describe("analyzeUrl — fallback to unknown when scrape fails entirely", () => {
  it("returns unknown/use_as_idea when both the ingest and the scrape blow up", async () => {
    ingestUrlListingMock.mockRejectedValue(new Error("scrape blocked"));
    scrapeUrlMock.mockRejectedValue(new Error("scrape blocked"));
    const out = await service.analyzeUrl(CLIENT_ID, {
      url: "https://stubborn-site.example/",
    });
    expect(out.detectedType).toBe("unknown");
    expect(out.suggestedNextStep).toBe("use_as_idea");
  });
});

// ── confirmUrl ─────────────────────────────────────────────────

describe("confirmUrl", () => {
  it("returns dataItemId + createUrl + propertyData for a newly saved listing", async () => {
    confirmUrlListingMock.mockResolvedValue({
      listing: {
        id: "data-new-1",
        title: "508 King George Court",
        summary: "Cary, NC",
        tags: ["listing", "url"],
        dataJson: { price: 365000 },
      },
      created: true,
    });

    const out = await service.confirmUrl(CLIENT_ID, {
      url: "https://example.com/listing/123",
      selectedListing: {
        title: "508 King George Court",
        price: 365000,
        sourceUrl: "https://example.com/listing/123",
      },
    });

    expect(out.created).toBe(true);
    expect(out.dataItemId).toBe("data-new-1");
    expect(out.existingId).toBeNull();
    expect(out.propertyData).toMatchObject({ id: "data-new-1", title: "508 King George Court" });
    expect(out.createUrl).toBe(
      "/workspaces/client-1/create?intent=campaign&sourceType=property&sourceId=data-new-1",
    );
  });

  it("returns existingId on a duplicate (URL-01 Bug 2 fix verified end-to-end)", async () => {
    confirmUrlListingMock.mockResolvedValue({
      listing: { id: "data-existing-7", title: "Existing", tags: [], dataJson: {} },
      created: false,
      existingId: "data-existing-7",
    });

    const out = await service.confirmUrl(CLIENT_ID, {
      url: "https://example.com/listing/123",
      selectedListing: { title: "Whatever" },
    });

    expect(out.created).toBe(false);
    expect(out.existingId).toBe("data-existing-7");
    expect(out.dataItemId).toBe("data-existing-7");
  });

  it("rejects unsafe sourceUrl before touching the ingestion pipeline", async () => {
    await expect(
      service.confirmUrl(CLIENT_ID, {
        url: "http://10.0.0.1/secret",
        selectedListing: { title: "x" },
      }),
    ).rejects.toMatchObject({ code: "UNSAFE_URL" });
    expect(confirmUrlListingMock).not.toHaveBeenCalled();
  });

  it("rejects when selectedListing is missing", async () => {
    await expect(service.confirmUrl(CLIENT_ID, {})).rejects.toMatchObject({
      status: 400,
    });
  });
});
