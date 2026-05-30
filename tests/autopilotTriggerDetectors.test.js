// Spinstr05 — detector integration for PRICE_DROP / JUST_SOLD /
// STALE_LISTING / SEASONAL.
//
// We mock the prisma layer + the asset loader so the detector
// runs against a synthetic reAssets fixture and we can assert
// which upsertRecommendation calls fired.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

let prismaMock;
const upsertCalls = [];

vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

// Stub the parts of autopilotCampaignRecommendation.service.js
// the detector hits.
vi.mock("../domains/studio/autopilotCampaignRecommendation.service.js", () => ({
  upsertRecommendation: vi.fn(async (input) => {
    upsertCalls.push(input);
    return { status: "created", id: `r-${upsertCalls.length}` };
  }),
  expireStaleRecommendations: vi.fn(async () => 0),
  generateDraftsForRecommendation: vi.fn(),
}));

vi.mock("../domains/studio/autopilotRun.service.js", () => ({
  recordRun: vi.fn(async (_meta, fn) => fn("run-1")),
  startRun: vi.fn(),
  finishRun: vi.fn(),
}));

vi.mock("../domains/industry/techStack.service.js", () => ({
  resolveRealEstateContext: vi.fn(async () => ({})),
}));

vi.mock("../domains/industry/realEstateGeneration.js", () => ({
  loadRealEstateGenerationAssets: vi.fn(),
}));

vi.mock("../domains/industry/realEstateAssets.js", () => ({
  getRecentAssetCount: vi.fn(async () => 0),
}));

vi.mock("../domains/studio/gbpSync.service.js", () => ({
  getGBPSignals: vi.fn(async () => ({})),
}));

vi.mock("../domains/studio/contentAngles.js", () => ({
  pickAngleForSource: vi.fn(() => ({ key: "k", label: "L" })),
}));

vi.mock("../domains/studio/generation/aiGenerationService.js", () => ({
  generateDraft: vi.fn(),
}));

vi.mock("../domains/studio/draft.service.js", () => ({
  formatDraft: vi.fn(),
}));

const { runAutopilot } = await import("../domains/studio/autopilot.service.js");
const { loadRealEstateGenerationAssets } = await import(
  "../domains/industry/realEstateGeneration.js"
);

function buildListing({
  id,
  title = "Test St",
  address = "Test St",
  status = "active",
  price = 425000,
  events = [],
  statusHistory = [],
  images = [],
}) {
  return {
    source: {
      id,
      title,
      createdAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000),
      dataJson: {
        address,
        status,
        price,
        imageUrl: images[0] ?? null,
        images,
        _events: events,
        _statusHistory: statusHistory,
      },
    },
  };
}

function setupWorkspace({ listings = [], reviews = [], existingActiveRecs = [] } = {}) {
  prismaMock = {
    workspaceTechStackConnection: {
      findUnique: vi.fn(async () => ({
        metadataJson: { mode: "draft_on_click", enabled: true },
      })),
    },
    client: {
      findUnique: vi.fn(async () => ({ industryKey: "real_estate" })),
    },
    channelSettings: {
      findMany: vi.fn(async () => [
        { channel: "FACEBOOK" },
        { channel: "INSTAGRAM" },
      ]),
    },
    draft: {
      findFirst: vi.fn(async () => null),
      count: vi.fn(async () => 0),
    },
    autopilotCampaignRecommendation: {
      findMany: vi.fn(async () => existingActiveRecs),
    },
  };
  loadRealEstateGenerationAssets.mockResolvedValue({
    listings,
    reviews,
    listingCount: listings.length,
    reviewCount: reviews.length,
    bestListing: listings[0]?.source?.dataJson ?? null,
    bestListingSource: listings[0]?.source ?? null,
    bestMilestone: null,
    bestMilestoneSource: null,
  });
}

beforeEach(() => {
  upsertCalls.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("PRICE_DROP detector", () => {
  it("emits a PRICE_DROP rec when a recent price_drop event exists", async () => {
    setupWorkspace({
      listings: [
        buildListing({
          id: "li-1",
          title: "508 King George Court",
          address: "508 King George Court",
          price: 400000,
          images: ["https://cdn/photo.jpg"],
          events: [
            {
              type: "price_drop",
              detectedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
              data: { oldPrice: 425000, newPrice: 400000, dropPercent: 6 },
            },
          ],
        }),
      ],
    });
    await runAutopilot("c1");
    const priceDrop = upsertCalls.find((c) => c.triggerType === "PRICE_DROP");
    expect(priceDrop).toBeDefined();
    expect(priceDrop.headline).toContain("Price Drop");
    expect(priceDrop.whatWeNoticed).toContain("$425,000");
    expect(priceDrop.whatWeNoticed).toContain("$400,000");
    expect(priceDrop.payloadJson.oldPrice).toBe(425000);
    expect(priceDrop.payloadJson.dropPercent).toBe(6);
  });

  it("does not emit PRICE_DROP when no price_drop event exists", async () => {
    setupWorkspace({
      listings: [
        buildListing({
          id: "li-1",
          events: [],
        }),
      ],
    });
    await runAutopilot("c1");
    expect(upsertCalls.find((c) => c.triggerType === "PRICE_DROP")).toBeUndefined();
  });

  it("ignores stale price_drop events outside the lookback window", async () => {
    setupWorkspace({
      listings: [
        buildListing({
          id: "li-1",
          events: [
            {
              type: "price_drop",
              detectedAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString(),
              data: { oldPrice: 425000, newPrice: 400000 },
            },
          ],
        }),
      ],
    });
    await runAutopilot("c1");
    expect(upsertCalls.find((c) => c.triggerType === "PRICE_DROP")).toBeUndefined();
  });
});

describe("JUST_SOLD detector", () => {
  it("emits JUST_SOLD when status=sold and the flip was recent", async () => {
    setupWorkspace({
      listings: [
        buildListing({
          id: "li-1",
          title: "508 King George Court",
          status: "sold",
          statusHistory: [
            { status: "active", recordedAt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString() },
            { status: "sold", recordedAt: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() },
          ],
        }),
      ],
    });
    await runAutopilot("c1");
    const justSold = upsertCalls.find((c) => c.triggerType === "JUST_SOLD");
    expect(justSold).toBeDefined();
    expect(justSold.headline).toContain("Just Sold");
  });

  it("ignores historical sold listings (flip outside 30-day window)", async () => {
    setupWorkspace({
      listings: [
        buildListing({
          id: "li-1",
          status: "sold",
          statusHistory: [
            { status: "sold", recordedAt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString() },
          ],
        }),
      ],
    });
    await runAutopilot("c1");
    expect(upsertCalls.find((c) => c.triggerType === "JUST_SOLD")).toBeUndefined();
  });

  it("does not emit JUST_SOLD when status is active", async () => {
    setupWorkspace({
      listings: [
        buildListing({
          id: "li-1",
          status: "active",
          statusHistory: [
            { status: "sold", recordedAt: new Date().toISOString() },
          ],
        }),
      ],
    });
    await runAutopilot("c1");
    expect(upsertCalls.find((c) => c.triggerType === "JUST_SOLD")).toBeUndefined();
  });
});

describe("STALE_LISTING detector", () => {
  it("emits STALE_LISTING when the listing has a recent stale_listing event", async () => {
    setupWorkspace({
      listings: [
        buildListing({
          id: "li-1",
          status: "active",
          events: [
            {
              type: "stale_listing",
              detectedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
              data: { daysActive: 45 },
            },
          ],
        }),
      ],
    });
    await runAutopilot("c1");
    const stale = upsertCalls.find((c) => c.triggerType === "STALE_LISTING");
    expect(stale).toBeDefined();
    expect(stale.whatWeNoticed).toContain("45 days");
  });

  it("suppresses STALE_LISTING when a NEW_LISTING / PRICE_DROP / OPEN_HOUSE rec already exists for the same property", async () => {
    setupWorkspace({
      listings: [
        buildListing({
          id: "li-1",
          address: "508 King George Court",
          status: "active",
          events: [
            {
              type: "stale_listing",
              detectedAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
              data: { daysActive: 50 },
            },
          ],
        }),
      ],
      // Pre-existing active NEW_LISTING rec for the same dedup key.
      existingActiveRecs: [{ triggerObjectId: "addr:508 king george court" }],
    });
    await runAutopilot("c1");
    expect(upsertCalls.find((c) => c.triggerType === "STALE_LISTING")).toBeUndefined();
  });

  it("does not emit STALE_LISTING for sold listings", async () => {
    setupWorkspace({
      listings: [
        buildListing({
          id: "li-1",
          status: "sold",
          events: [
            {
              type: "stale_listing",
              detectedAt: new Date().toISOString(),
              data: { daysActive: 60 },
            },
          ],
        }),
      ],
    });
    await runAutopilot("c1");
    expect(upsertCalls.find((c) => c.triggerType === "STALE_LISTING")).toBeUndefined();
  });
});

describe("SEASONAL detector", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-15T12:00:00Z"));
  });

  it("emits at most one SEASONAL per run with a stable triggerObjectId", async () => {
    setupWorkspace({});
    await runAutopilot("c1");
    const seasonal = upsertCalls.filter((c) => c.triggerType === "SEASONAL");
    expect(seasonal).toHaveLength(1);
    expect(seasonal[0].triggerObjectId).toBe("season:spring_buyer_campaign:2026");
    expect(seasonal[0].headline).toBe("Spring Buyer Campaign");
  });

  it("does not emit SEASONAL when stronger triggers already filled the run", async () => {
    setupWorkspace({
      listings: [
        // Three high-confidence new listings — soft cap reached.
        ...[1, 2, 3].map((i) =>
          buildListing({
            id: `li-${i}`,
            title: `${i}00 Different St`,
            address: `${i}00 Different St`,
            images: ["https://cdn/p.jpg"],
          }),
        ),
      ],
    });
    await runAutopilot("c1");
    expect(upsertCalls.find((c) => c.triggerType === "SEASONAL")).toBeUndefined();
  });
});
