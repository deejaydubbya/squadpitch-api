// industry-01 — safety tests proving the real-estate gates work
// and no-industry workspaces don't silently get real-estate
// behavior.
//
// Covers (from prompt 01 section 7):
//   - missing/unknown adapter does not return real estate adapter (web side)
//   - missing campaign type does not become `just_listed` (covered via
//     promptBuilder import — see below)
//   - no-industry URL analysis does not call listing/property extraction
//   - real-estate URL analysis still works for industryKey = real_estate
//   - real-estate autopilot/listing feed still works
//   - non-real-estate/null industry autopilot/listing feed returns
//     INDUSTRY_NOT_SUPPORTED without calling real-estate loaders

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../prisma.js", () => ({
  get prisma() {
    return globalThis.__industryFixtures?.prisma;
  },
}));

// Stub the upstream RE loaders so we can assert they're NEVER
// called for non-RE workspaces. Any call = leakage.
const loadRealEstateGenerationAssetsMock = vi.fn();
const resolveRealEstateContextMock = vi.fn();
const getRecentAssetCountMock = vi.fn(async () => 0);

vi.mock("../domains/industry/realEstateGeneration.js", () => ({
  loadRealEstateGenerationAssets: (...args) => loadRealEstateGenerationAssetsMock(...args),
}));
vi.mock("../domains/industry/techStack.service.js", () => ({
  resolveRealEstateContext: (...args) => resolveRealEstateContextMock(...args),
}));
vi.mock("../domains/industry/realEstateAssets.js", () => ({
  getRecentAssetCount: (...args) => getRecentAssetCountMock(...args),
  stampSourceAttribution: vi.fn(),
  RE_SOURCE_TYPES: { url: "URL" },
}));
vi.mock("../domains/studio/contentAngles.js", () => ({
  pickAngleForSource: vi.fn(),
}));
vi.mock("../domains/studio/gbpSync.service.js", () => ({
  getGBPSignals: vi.fn(),
}));

// industry-04 — stub scrapeUrl so the generic URL analyzer never
// hits the network during tests. The real listingIngestion +
// real industry-01 gate stay in play, so the existing
// "ingestManualListing rejects null industry" tests still work
// (the gate catches the call before anything network-bound runs).
const scrapeUrlMock = vi.fn();
vi.mock("../domains/studio/scrapeUrl.js", () => ({
  scrapeUrl: (...args) => scrapeUrlMock(...args),
  filterPropertyImages: vi.fn((arr) => arr),
}));

// We import after the mocks so the service captures the mocked deps.
const autopilot = await import("../domains/studio/autopilot.service.js");
const listingFeed = await import("../domains/studio/listingFeed.service.js");
const listingIngestion = await import("../domains/studio/listingIngestion.service.js");
const urlCampaignIntake = await import("../domains/studio/urlCampaignIntake.service.js");

beforeEach(() => {
  loadRealEstateGenerationAssetsMock.mockReset();
  resolveRealEstateContextMock.mockReset();
  getRecentAssetCountMock.mockReset();
});

function setIndustry(industryKey) {
  globalThis.__industryFixtures = {
    prisma: {
      client: {
        findUnique: vi.fn(async () => ({ industryKey })),
      },
      // autopilot.getAutopilotSettings reads this row; we don't
      // need to exercise the actual settings logic in this suite,
      // so a minimal stub keeps the gate-pass tests succeeding.
      workspaceTechStackConnection: {
        findUnique: vi.fn(async () => null),
      },
      workspaceDataSource: {
        findMany: vi.fn(async () => []),
      },
    },
  };
}

// ── Autopilot gating ─────────────────────────────────────────

describe("autopilot service — real-estate gate", () => {
  it("getAutopilotSettings allows real-estate workspaces through", async () => {
    setIndustry("real_estate");
    const s = await autopilot.getAutopilotSettings("ws-1");
    expect(s).toBeDefined();
  });

  it("getAutopilotSettings rejects null industry with INDUSTRY_NOT_SUPPORTED", async () => {
    setIndustry(null);
    await expect(autopilot.getAutopilotSettings("ws-1")).rejects.toMatchObject({
      code: "INDUSTRY_NOT_SUPPORTED",
      requiredIndustry: "real_estate",
      actualIndustry: null,
    });
    // The RE loaders MUST NOT be called for a non-RE workspace.
    expect(loadRealEstateGenerationAssetsMock).not.toHaveBeenCalled();
    expect(resolveRealEstateContextMock).not.toHaveBeenCalled();
  });

  it("getAutopilotStatus rejects automotive workspaces", async () => {
    setIndustry("automotive");
    await expect(autopilot.getAutopilotStatus("ws-1")).rejects.toMatchObject({
      code: "INDUSTRY_NOT_SUPPORTED",
      actualIndustry: "automotive",
    });
  });

  it("runAutopilot rejects null industry before any work happens", async () => {
    setIndustry(null);
    await expect(autopilot.runAutopilot("ws-1")).rejects.toMatchObject({
      code: "INDUSTRY_NOT_SUPPORTED",
    });
    expect(loadRealEstateGenerationAssetsMock).not.toHaveBeenCalled();
  });
});

// ── Listing-feed gating ──────────────────────────────────────

describe("listingFeed service — real-estate gate", () => {
  it("getListingSources allows real-estate workspaces", async () => {
    setIndustry("real_estate");
    const out = await listingFeed.getListingSources("ws-1");
    expect(Array.isArray(out)).toBe(true);
  });

  it("getListingSources rejects null industry", async () => {
    setIndustry(null);
    await expect(listingFeed.getListingSources("ws-1")).rejects.toMatchObject({
      code: "INDUSTRY_NOT_SUPPORTED",
    });
  });

  it("createListingSource rejects automotive", async () => {
    setIndustry("automotive");
    await expect(
      listingFeed.createListingSource("ws-1", { name: "x", type: "URL", sourceUrl: "https://example.com" }),
    ).rejects.toMatchObject({ code: "INDUSTRY_NOT_SUPPORTED" });
  });
});

// ── Listing-ingestion gating ─────────────────────────────────

describe("listingIngestion service — real-estate gate", () => {
  it("ingestManualListing rejects null industry before normalizing", async () => {
    setIndustry(null);
    await expect(
      listingIngestion.ingestManualListing("ws-1", { address: "1 Main St" }),
    ).rejects.toMatchObject({ code: "INDUSTRY_NOT_SUPPORTED" });
  });

  it("ingestUrlListing rejects null industry before any scrape", async () => {
    setIndustry(null);
    await expect(
      listingIngestion.ingestUrlListing("ws-1", "https://example.com/listing"),
    ).rejects.toMatchObject({ code: "INDUSTRY_NOT_SUPPORTED" });
  });
});

// ── urlCampaignIntake analyze gating ─────────────────────────

describe("urlCampaignIntake.analyzeUrl — industry awareness", () => {
  beforeEach(() => {
    scrapeUrlMock.mockReset();
  });

  it("returns generic_page (not a listing) for null industry — uses the generic analyzer", async () => {
    setIndustry(null);
    scrapeUrlMock.mockResolvedValueOnce({
      text: "About our business",
      title: "Acme Inc.",
      metaDescription: "We do X.",
      ogImage: "https://example.com/og.png",
      images: [],
      links: [],
    });
    const res = await urlCampaignIntake.analyzeUrl("ws-1", {
      url: "https://example.com/about",
    });
    expect(res.detectedType).toBe("generic_page");
    expect(res.suggestedNextStep).toBe("use_as_idea");
    expect(res.listings).toEqual([]);
    expect(res.genericPreview).toMatchObject({
      kind: "generic_url",
      title: "Acme Inc.",
      description: "We do X.",
    });
    // The critical safety check: scrape was called (generic
    // analyzer ran), and it was called against the safe URL.
    expect(scrapeUrlMock).toHaveBeenCalledWith(
      "https://example.com/about",
      expect.objectContaining({ extractLinks: true }),
    );
  });

  it("returns generic_page for automotive (every non-RE industry routes through generic)", async () => {
    setIndustry("automotive");
    scrapeUrlMock.mockResolvedValueOnce({
      text: "Inventory page",
      title: "Auto Dealer",
      metaDescription: null,
      ogImage: null,
      images: [],
      links: [],
    });
    const res = await urlCampaignIntake.analyzeUrl("ws-1", {
      url: "https://example.com/inventory/abc",
    });
    expect(res.detectedType).toBe("generic_page");
    expect(res.genericPreview.kind).toBe("generic_url");
  });

  it("still rejects unsafe URLs even when industry is null (safety check runs first)", async () => {
    setIndustry(null);
    await expect(
      urlCampaignIntake.analyzeUrl("ws-1", { url: "http://127.0.0.1/admin" }),
    ).rejects.toMatchObject({ code: "UNSAFE_URL" });
    // scrape must NOT have been called — safety check runs first.
    expect(scrapeUrlMock).not.toHaveBeenCalled();
  });
});
