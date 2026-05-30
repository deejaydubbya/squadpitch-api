// Spinstr01 — full automation mode ladder behavior.
//
// Pins:
//   - auto_generate_drafts post-detect step generates drafts only
//     for high-confidence NEEDS_REVIEW recs.
//   - INACTIVITY_GAP, generic-title recs, and recs without
//     sourceDataItemId are skipped with a reason.
//   - Repeat scheduler runs are idempotent (rec.generatedDraftIds
//     already populated → noop).
//   - schedule_after_approval picks safe default slots when no
//     scheduleAt is passed.
//   - buildAutoScheduleSlots returns weekday-only future slots.

import { describe, it, expect, vi, beforeEach } from "vitest";

import { buildAutoScheduleSlots } from "../domains/studio/autopilotCampaignRecommendation.service.js";

describe("buildAutoScheduleSlots", () => {
  it("returns the requested number of future weekday slots", () => {
    const slots = buildAutoScheduleSlots(3);
    expect(slots).toHaveLength(3);
    const now = Date.now();
    for (const iso of slots) {
      const t = new Date(iso);
      expect(t.getTime()).toBeGreaterThan(now);
      const day = t.getUTCDay();
      // 0 = Sun, 6 = Sat — skipped.
      expect(day).not.toBe(0);
      expect(day).not.toBe(6);
    }
  });

  it("returns an empty array on 0 count", () => {
    expect(buildAutoScheduleSlots(0)).toEqual([]);
  });

  it("respects quiet hours by bumping the slot past quietEnd", () => {
    // Quiet hours covering 10am UTC — slot should land at quietEnd.
    const slots = buildAutoScheduleSlots(1, {
      quietHoursStart: 6,
      quietHoursEnd: 14,
    });
    const t = new Date(slots[0]);
    expect(t.getUTCHours()).toBe(14);
  });
});

// ── auto_generate_drafts via runAutopilot ─────────────────────────────

let prismaMock;
const generateCalls = [];

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
  generateDraft: vi.fn(async ({ clientId, channel }) => {
    const id = `draft-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    return { id, clientId, channel, status: "DRAFT", bucketKey: "just_listed" };
  }),
}));
vi.mock("../domains/industry/techStack.service.js", () => ({
  resolveRealEstateContext: vi.fn(async () => ({})),
}));

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
const drafts = new Map();
const runRows = new Map();
let recCounter = 0;
let runCounter = 0;
const settingsState = {
  ref: {
    enabled: true,
    mode: "auto_generate_drafts",
    allowListingPosts: true,
    allowTestimonialPosts: true,
    allowMilestonePosts: true,
    allowFallbackPosts: true,
    maxDraftsPerWeek: 10,
    maxDraftsPerDay: 5,
    maxDraftsPerScheduledRun: 3,
    minimumHoursBetweenDrafts: 12,
    quietHoursStart: null,
    quietHoursEnd: null,
  },
};

function makePrisma() {
  return {
    client: {
      findUnique: vi.fn(async ({ where }) =>
        where.id === "client-x" ? { id: "client-x", industryKey: "real_estate" } : null,
      ),
    },
    workspaceTechStackConnection: {
      findUnique: vi.fn(async () => ({ metadataJson: settingsState.ref })),
      upsert: vi.fn(async () => ({})),
    },
    channelSettings: {
      findMany: vi.fn(async () => [{ channel: "FACEBOOK" }]),
    },
    draft: {
      findFirst: vi.fn(async () => null),
      findMany: vi.fn(async ({ where }) => {
        const ids = where?.id?.in ?? [];
        return ids.map((id) => drafts.get(id)).filter(Boolean);
      }),
      count: vi.fn(async () => 0),
    },
    autopilotCampaignRecommendation: {
      findFirst: vi.fn(async ({ where }) => {
        for (const r of recs.values()) {
          if (where.clientId && r.clientId !== where.clientId) continue;
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
      findMany: vi.fn(async ({ where = {} } = {}) => {
        return [...recs.values()].filter((r) => {
          if (where.clientId && r.clientId !== where.clientId) return false;
          if (typeof where.status === "string" && r.status !== where.status) return false;
          if (where.generatedDraftIds?.isEmpty === true) {
            if (Array.isArray(r.generatedDraftIds) && r.generatedDraftIds.length > 0) {
              return false;
            }
          }
          return true;
        });
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
  drafts.clear();
  runRows.clear();
  recCounter = 0;
  runCounter = 0;
  generateCalls.length = 0;
  prismaMock = makePrisma();
  settingsState.ref = {
    ...settingsState.ref,
    mode: "auto_generate_drafts",
  };
});

function listingItem(id, data = {}, title = null) {
  return { source: { id, dataJson: data, createdAt: new Date(), title }, normalized: {} };
}

const { runAutopilot } = await import("../domains/studio/autopilot.service.js");

describe("auto_generate_drafts — post-detect step", () => {
  it("auto-generates drafts for high-confidence NEW_LISTING recs", async () => {
    reAssetsFixture.ref = {
      listings: [
        listingItem("listing-1", {
          address: "111 First St",
          imageUrl: "https://example.com/p.jpg",
        }),
      ],
      reviews: [],
    };
    const out = await runAutopilot("client-x", { mode: "manual" });
    expect(out.autoGeneratedDrafts).toBeGreaterThan(0);
    const rec = [...recs.values()].find((r) => r.triggerType === "NEW_LISTING");
    expect(rec.status).toBe("DRAFT_GENERATED");
    expect(rec.generatedDraftIds.length).toBeGreaterThan(0);
  });

  it("skips INACTIVITY_GAP — too generic to safely auto-generate", async () => {
    reAssetsFixture.ref = { listings: [], reviews: [] };
    // Force inactivity by leaving lastDraft.findFirst null (it is).
    const out = await runAutopilot("client-x", { mode: "manual" });
    const recList = [...recs.values()];
    const inactRec = recList.find((r) => r.triggerType === "INACTIVITY_GAP");
    expect(inactRec).toBeTruthy();
    expect(inactRec.status).toBe("NEEDS_REVIEW");
    // autoGen skip array should mention it.
    const skipped = out.autoGenerateSkipped ?? [];
    expect(skipped.some((s) => s.recommendationId === inactRec.id)).toBe(true);
  });

  it("does not auto-generate twice on a re-run (idempotent)", async () => {
    reAssetsFixture.ref = {
      listings: [
        listingItem("listing-1", {
          address: "111 First St",
          imageUrl: "https://example.com/p.jpg",
        }),
      ],
      reviews: [],
    };
    await runAutopilot("client-x", { mode: "manual" });
    const first = [...recs.values()].find((r) => r.triggerType === "NEW_LISTING");
    const firstDraftIds = [...first.generatedDraftIds];
    expect(firstDraftIds.length).toBeGreaterThan(0);

    // Re-run. The detector touches the existing rec but the
    // auto-gen step must NOT regenerate.
    await runAutopilot("client-x", { mode: "manual" });
    const second = recs.get(first.id);
    expect(second.generatedDraftIds).toEqual(firstDraftIds);
  });

  it("recommend_only does NOT auto-generate drafts", async () => {
    settingsState.ref = { ...settingsState.ref, mode: "recommend_only" };
    reAssetsFixture.ref = {
      listings: [
        listingItem("listing-1", {
          address: "111 First St",
          imageUrl: "https://example.com/p.jpg",
        }),
      ],
      reviews: [],
    };
    const out = await runAutopilot("client-x", { mode: "manual" });
    expect(out.autoGeneratedDrafts ?? 0).toBe(0);
    const rec = [...recs.values()].find((r) => r.triggerType === "NEW_LISTING");
    expect(rec.status).toBe("NEEDS_REVIEW");
    expect(rec.generatedDraftIds.length).toBe(0);
  });

  it("draft_on_click does NOT auto-generate drafts (MVP baseline)", async () => {
    settingsState.ref = { ...settingsState.ref, mode: "draft_on_click" };
    reAssetsFixture.ref = {
      listings: [
        listingItem("listing-1", {
          address: "111 First St",
          imageUrl: "https://example.com/p.jpg",
        }),
      ],
      reviews: [],
    };
    const out = await runAutopilot("client-x", { mode: "manual" });
    expect(out.autoGeneratedDrafts ?? 0).toBe(0);
  });
});
