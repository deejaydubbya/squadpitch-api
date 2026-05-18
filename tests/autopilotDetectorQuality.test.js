// Autopilot detector quality pass (spinstr423).
//
// Pins:
//   - Duplicate listings (same address, different ids) collapse
//     to one NEW_LISTING recommendation.
//   - The richer record (with imageUrl) wins the headline.
//   - The detector caps NEW_LISTING emissions per run.
//   - Headlines use the address, not the generic "New listing".
//   - whyItMatters is specific to the trigger (not generic
//     "general promotion works").
//
// The detector is private to autopilot.service.js so we exercise
// it via runAutopilot with a stubbed reAssets path.

import { describe, it, expect, vi, beforeEach } from "vitest";

let prismaMock;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

vi.mock("../domains/studio/contentAngles.js", () => ({
  pickAngleForSource: vi.fn(),
}));
vi.mock("../domains/studio/gbpSync.service.js", () => ({
  getGBPSignals: vi.fn(),
}));
vi.mock("../domains/studio/generation/aiGenerationService.js", () => ({
  generateDraft: vi.fn(),
}));
vi.mock("../domains/industry/techStack.service.js", () => ({
  resolveRealEstateContext: vi.fn(async () => ({})),
}));

// Inject reAssets via the real-estate generation loader.
const reAssetsFixture = { ref: { listings: [], reviews: [] } };
vi.mock("../domains/industry/realEstateGeneration.js", () => ({
  loadRealEstateGenerationAssets: vi.fn(async () => reAssetsFixture.ref),
}));
vi.mock("../domains/industry/realEstateAssets.js", () => ({
  getRealEstateListings: vi.fn(async () => []),
  getRealEstateTestimonials: vi.fn(async () => []),
  getRealEstateMilestones: vi.fn(async () => []),
  getRecentAssetCount: vi.fn(async () => 0),
}));

const recs = new Map();
let recCounter = 0;
const runRows = new Map();
let runCounter = 0;

function makePrisma() {
  return {
    client: {
      findUnique: vi.fn(async ({ where }) =>
        where.id === "client-x" ? { id: "client-x", industryKey: "real_estate" } : null,
      ),
    },
    workspaceTechStackConnection: {
      findUnique: vi.fn(async () => ({
        metadataJson: {
          enabled: true,
          mode: "draft_only",
          allowListingPosts: true,
          allowTestimonialPosts: true,
          allowMilestonePosts: true,
          allowFallbackPosts: true,
          maxDraftsPerWeek: 10,
          maxDraftsPerDay: 3,
          maxDraftsPerScheduledRun: 2,
          minimumHoursBetweenDrafts: 12,
          quietHoursStart: null,
          quietHoursEnd: null,
        },
      })),
      upsert: vi.fn(async () => ({})),
    },
    channelSettings: {
      findMany: vi.fn(async () => [
        { channel: "INSTAGRAM" },
        { channel: "FACEBOOK" },
      ]),
    },
    draft: {
      // Return null so checkGuardrails doesn't think we just
      // ran the evaluator a second ago + spacing-block the run.
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async () => []),
      // checkGuardrails reads recent-draft counts.
      count: vi.fn(async () => 0),
    },
    autopilotCampaignRecommendation: {
      findFirst: vi.fn(async ({ where }) => {
        for (const r of recs.values()) {
          if (r.clientId !== where.clientId) continue;
          if (where.triggerType && r.triggerType !== where.triggerType) continue;
          if (
            "triggerObjectId" in where &&
            r.triggerObjectId !== where.triggerObjectId
          )
            continue;
          if (where.id && r.id !== where.id) continue;
          return r;
        }
        return null;
      }),
      create: vi.fn(async ({ data }) => {
        for (const r of recs.values()) {
          if (
            r.clientId === data.clientId &&
            r.triggerType === data.triggerType &&
            r.triggerObjectId === data.triggerObjectId
          ) {
            const e = new Error("dup");
            e.code = "P2002";
            throw e;
          }
        }
        const id = `rec-${++recCounter}`;
        const row = {
          id,
          createdAt: new Date(),
          updatedAt: new Date(),
          status: "NEEDS_REVIEW",
          generatedDraftIds: [],
          ...data,
        };
        recs.set(id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => {
        const r = recs.get(where.id);
        Object.assign(r, data, { updatedAt: new Date() });
        return r;
      }),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    autopilotRun: {
      create: vi.fn(async ({ data, select }) => {
        const id = `run-${++runCounter}`;
        const row = { id, startedAt: new Date(), ...data };
        runRows.set(id, row);
        return select?.id ? { id } : row;
      }),
      update: vi.fn(async ({ where, data }) => {
        const r = runRows.get(where.id);
        if (r) Object.assign(r, data);
        return r;
      }),
    },
  };
}

beforeEach(() => {
  recs.clear();
  runRows.clear();
  recCounter = 0;
  runCounter = 0;
  prismaMock = makePrisma();
});

function listing(id, dataJson, createdAt = new Date(), title = null) {
  return {
    source: { id, dataJson, createdAt, title },
    normalized: {},
  };
}

const { runAutopilot } = await import("../domains/studio/autopilot.service.js");

describe("detectAndPersistRecommendations — dedup", () => {
  it("collapses two listings at the same address into one NEW_LISTING rec", async () => {
    reAssetsFixture.ref = {
      listings: [
        listing("data-1", { address: "508 King George Court" }),
        listing("data-2", { address: "508  King  George  Court," }),
      ],
      reviews: [],
    };
    const out = await runAutopilot("client-x", { mode: "manual" });
    expect(out.action).toBe("recommended");
    const newListingRecs = [...recs.values()].filter(
      (r) => r.triggerType === "NEW_LISTING",
    );
    expect(newListingRecs.length).toBe(1);
    expect(newListingRecs[0].headline).toContain("508 King George Court");
  });

  it("prefers the richer record (with imageUrl) when collapsing duplicates", async () => {
    reAssetsFixture.ref = {
      listings: [
        listing("data-bare", { address: "873 E Us 22 & 3" }),
        listing("data-rich", {
          address: "873 E Us 22 & 3",
          imageUrl: "https://example.com/photo.jpg",
          price: 425000,
        }),
      ],
      reviews: [],
    };
    await runAutopilot("client-x", { mode: "manual" });
    const rec = [...recs.values()].find((r) => r.triggerType === "NEW_LISTING");
    expect(rec).toBeTruthy();
    expect(rec.payloadJson.propertyImageUrl).toBe("https://example.com/photo.jpg");
    expect(rec.payloadJson.sourceDataItemId).toBe("data-rich");
  });

  it("caps NEW_LISTING emissions at 3 per run", async () => {
    reAssetsFixture.ref = {
      listings: [
        listing("a", { address: "111 First St" }),
        listing("b", { address: "222 Second St" }),
        listing("c", { address: "333 Third St" }),
        listing("d", { address: "444 Fourth St" }),
        listing("e", { address: "555 Fifth St" }),
      ],
      reviews: [],
    };
    await runAutopilot("client-x", { mode: "manual" });
    const newListingRecs = [...recs.values()].filter(
      (r) => r.triggerType === "NEW_LISTING",
    );
    expect(newListingRecs.length).toBe(3);
  });
});

describe("detectAndPersistRecommendations — headlines + copy", () => {
  it("uses the property address in the headline (not generic 'New listing')", async () => {
    reAssetsFixture.ref = {
      listings: [listing("x", { address: "508 King George Court" })],
      reviews: [],
    };
    await runAutopilot("client-x", { mode: "manual" });
    const rec = [...recs.values()][0];
    expect(rec.headline).toBe("New Listing: 508 King George Court");
  });

  it("falls through to item.title when dataJson lacks address (real importer shape)", async () => {
    // The property importer puts the full address on the
    // top-level item.title column ("508 King George Court,
    // Springboro, OH, 45066") even when dataJson is sparse.
    // The detector has to read both spots to give a useful
    // headline.
    reAssetsFixture.ref = {
      listings: [
        listing("a", {}, new Date(), "508 King George Court, Springboro, OH, 45066"),
      ],
      reviews: [],
    };
    await runAutopilot("client-x", { mode: "manual" });
    const rec = [...recs.values()][0];
    expect(rec.headline).toContain("508 King George Court");
    expect(rec.headline).not.toContain("your new listing");
  });

  it("dedupes title-only and dataJson-address records of the same property", async () => {
    // Same property in the library twice: once with full
    // dataJson.address + image, once with only item.title. Both
    // must collapse onto a single rec so the inbox doesn't show
    // the property twice.
    reAssetsFixture.ref = {
      listings: [
        listing("with-image", {
          address: "508 King George Court",
          imageUrl: "https://example.com/x.jpg",
        }),
        listing("title-only", {}, new Date(), "508 King George Court, Springboro, OH, 45066"),
      ],
      reviews: [],
    };
    await runAutopilot("client-x", { mode: "manual" });
    const newListingRecs = [...recs.values()].filter(
      (r) => r.triggerType === "NEW_LISTING",
    );
    expect(newListingRecs.length).toBe(1);
    // Richer record (with image) wins the payload.
    expect(newListingRecs[0].payloadJson.sourceDataItemId).toBe("with-image");
  });

  it("whyItMatters references the specific recommended channels, not generic copy", async () => {
    reAssetsFixture.ref = {
      listings: [listing("x", { address: "508 King George Court" })],
      reviews: [],
    };
    await runAutopilot("client-x", { mode: "manual" });
    const rec = [...recs.values()][0];
    // Specific copy includes the channel list AND a campaign rationale.
    expect(rec.whyItMatters).toMatch(/A launch campaign/i);
    expect(rec.whyItMatters).toMatch(/INSTAGRAM|FACEBOOK/);
    // The old generic phrase must NOT appear.
    expect(rec.whyItMatters.toLowerCase()).not.toContain(
      "general promotion works for any listing",
    );
  });
});
