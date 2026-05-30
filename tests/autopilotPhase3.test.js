// Autopilot Phase 3 — generate drafts from a recommendation.
//
// Pins the contract from docs/AUTOPILOT_PRODUCT_AUDIT.md §10:
//   - idempotent on repeat clicks (returns existing drafts)
//   - cannot generate on DISMISSED / EXPIRED rows
//   - tenant-isolated (cross-workspace 404)
//   - no auto-publish / scheduling (drafts come back DRAFT)
//   - all-channel-failure does NOT flip status to DRAFT_GENERATED
//   - partial success returns successful ids + skipped reasons
//   - Instagram skipped without media

import { describe, it, expect, vi, beforeEach } from "vitest";

let prismaMock;
let generateDraftMock;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return prismaMock;
  },
}));

vi.mock("../lib/auditLog.js", () => ({
  writeAudit: vi.fn(),
}));

vi.mock("../domains/studio/generation/aiGenerationService.js", () => ({
  generateDraft: (...args) => generateDraftMock(...args),
}));

const svc = await import(
  "../domains/studio/autopilotCampaignRecommendation.service.js"
);

const CLIENT_A = "client-a";
const CLIENT_B = "client-b";

function makeMock({
  recs = [],
  channels = ["INSTAGRAM", "FACEBOOK", "LINKEDIN"],
} = {}) {
  const recsMap = new Map(recs.map((r) => [r.id, r]));
  let draftCounter = 0;
  const drafts = new Map();
  return {
    state: { recs: recsMap, drafts },
    autopilotCampaignRecommendation: {
      findFirst: vi.fn(async ({ where }) => {
        const r = recsMap.get(where.id);
        if (!r) return null;
        if (where.clientId && r.clientId !== where.clientId) return null;
        return r;
      }),
      update: vi.fn(async ({ where, data }) => {
        const r = recsMap.get(where.id);
        Object.assign(r, data);
        return r;
      }),
    },
    draft: {
      findMany: vi.fn(async ({ where }) => {
        const ids = where?.id?.in ?? [];
        return ids
          .map((id) => drafts.get(id))
          .filter((d) => d && d.clientId === where.clientId);
      }),
      // Indirect — generateDraftMock writes here so subsequent
      // idempotency lookups find them.
      _create(d) {
        const row = {
          id: `draft-${++draftCounter}`,
          status: "DRAFT",
          bucketKey: d.bucketKey ?? "post",
          ...d,
        };
        drafts.set(row.id, row);
        return row;
      },
    },
    channelSettings: {
      findMany: vi.fn(async () =>
        channels.map((c) => ({ channel: c })),
      ),
    },
  };
}

function baseRec(extra = {}) {
  return {
    id: "rec-1",
    clientId: CLIENT_A,
    triggerType: "NEW_LISTING",
    triggerObjectType: "listing",
    triggerObjectId: "listing-1",
    status: "NEEDS_REVIEW",
    headline: "New listing launch — 123 Main",
    whatWeNoticed: "Added on 2026-05-18.",
    whyItMatters: "First-7-days engagement.",
    recommendedChannels: ["INSTAGRAM", "FACEBOOK", "LINKEDIN"],
    recommendedAngles: [],
    generatedDraftIds: [],
    payloadJson: {
      propertyTitle: "123 Main St",
      propertyImageUrl: "https://example.com/img.jpg",
    },
    ...extra,
  };
}

beforeEach(() => {
  prismaMock = null;
  generateDraftMock = vi.fn(async ({ clientId, channel }) =>
    prismaMock.draft._create({ clientId, channel }),
  );
});

describe("generateDraftsForRecommendation — happy path", () => {
  it("creates one draft per eligible channel, flips status to DRAFT_GENERATED", async () => {
    prismaMock = makeMock({ recs: [baseRec()] });
    const result = await svc.generateDraftsForRecommendation({
      clientId: CLIENT_A,
      recommendationId: "rec-1",
      userId: "auth0|alice",
    });
    expect(result.status).toBe("success");
    expect(result.drafts.length).toBe(3);
    expect(result.skipped.length).toBe(0);
    const rec = prismaMock.state.recs.get("rec-1");
    expect(rec.status).toBe("DRAFT_GENERATED");
    expect(rec.generatedDraftIds.length).toBe(3);
    // No draft was created with a PUBLISHED or SCHEDULED status —
    // the generator returns DRAFT and Phase 3 doesn't touch that.
    for (const d of result.drafts) {
      expect(d.status).toBe("DRAFT");
    }
  });

  it("skips Instagram when the recommendation has no image and reports the reason", async () => {
    const rec = baseRec({
      payloadJson: { propertyTitle: "123 Main St" }, // no image
    });
    prismaMock = makeMock({ recs: [rec] });
    const result = await svc.generateDraftsForRecommendation({
      clientId: CLIENT_A,
      recommendationId: "rec-1",
      userId: "auth0|alice",
    });
    expect(result.status).toBe("partial_success");
    const channels = result.drafts.map((d) => d.channel);
    expect(channels).not.toContain("INSTAGRAM");
    expect(channels).toEqual(expect.arrayContaining(["FACEBOOK", "LINKEDIN"]));
    expect(result.skipped.find((s) => s.channel === "INSTAGRAM")).toMatchObject({
      reason: expect.stringMatching(/instagram/i),
    });
  });

  it("skips a channel that is not enabled in the workspace", async () => {
    prismaMock = makeMock({
      recs: [baseRec()],
      channels: ["FACEBOOK"], // IG + LinkedIn not enabled
    });
    const result = await svc.generateDraftsForRecommendation({
      clientId: CLIENT_A,
      recommendationId: "rec-1",
      userId: "auth0|alice",
    });
    expect(result.status).toBe("partial_success");
    expect(result.drafts.map((d) => d.channel)).toEqual(["FACEBOOK"]);
    expect(result.skipped.find((s) => s.channel === "INSTAGRAM")).toMatchObject({
      reason: expect.stringMatching(/not enabled/i),
    });
  });
});

describe("generateDraftsForRecommendation — idempotency", () => {
  it("returns existing drafts on a second click instead of regenerating", async () => {
    const rec = baseRec({
      status: "DRAFT_GENERATED",
      generatedDraftIds: ["draft-existing-1", "draft-existing-2"],
    });
    prismaMock = makeMock({ recs: [rec] });
    prismaMock.draft._create({
      clientId: CLIENT_A,
      channel: "INSTAGRAM",
    });
    prismaMock.draft._create({
      clientId: CLIENT_A,
      channel: "FACEBOOK",
    });
    // Make the existing draft ids resolvable via findMany.
    prismaMock.state.drafts.set("draft-existing-1", {
      id: "draft-existing-1",
      clientId: CLIENT_A,
      channel: "INSTAGRAM",
      status: "DRAFT",
    });
    prismaMock.state.drafts.set("draft-existing-2", {
      id: "draft-existing-2",
      clientId: CLIENT_A,
      channel: "FACEBOOK",
      status: "DRAFT",
    });
    const result = await svc.generateDraftsForRecommendation({
      clientId: CLIENT_A,
      recommendationId: "rec-1",
      userId: "auth0|alice",
    });
    expect(result.status).toBe("noop");
    expect(result.alreadyGenerated).toBe(true);
    expect(generateDraftMock).not.toHaveBeenCalled();
  });
});

describe("generateDraftsForRecommendation — refuses ineligible states", () => {
  it("refuses on DISMISSED with PROVIDER_NOT_AVAILABLE-style 412", async () => {
    prismaMock = makeMock({ recs: [baseRec({ status: "DISMISSED" })] });
    await expect(
      svc.generateDraftsForRecommendation({
        clientId: CLIENT_A,
        recommendationId: "rec-1",
        userId: "auth0|alice",
      }),
    ).rejects.toMatchObject({ code: "RECOMMENDATION_NOT_ELIGIBLE", status: 412 });
  });

  it("refuses on EXPIRED", async () => {
    prismaMock = makeMock({ recs: [baseRec({ status: "EXPIRED" })] });
    await expect(
      svc.generateDraftsForRecommendation({
        clientId: CLIENT_A,
        recommendationId: "rec-1",
        userId: "auth0|alice",
      }),
    ).rejects.toMatchObject({ code: "RECOMMENDATION_NOT_ELIGIBLE" });
  });

  it("refuses cross-workspace access with 404 (no rec mutation)", async () => {
    prismaMock = makeMock({ recs: [baseRec()] });
    await expect(
      svc.generateDraftsForRecommendation({
        clientId: CLIENT_B,
        recommendationId: "rec-1",
        userId: "auth0|alice",
      }),
    ).rejects.toMatchObject({ code: "RECOMMENDATION_NOT_FOUND", status: 404 });
    const stored = prismaMock.state.recs.get("rec-1");
    expect(stored.status).toBe("NEEDS_REVIEW");
  });
});

describe("generateDraftsForRecommendation — failure handling", () => {
  it("returns status=failed and DOES NOT flip the rec when every channel fails", async () => {
    generateDraftMock = vi.fn(async () => ({
      id: "draft-failed",
      status: "FAILED",
    }));
    prismaMock = makeMock({ recs: [baseRec()] });
    const result = await svc.generateDraftsForRecommendation({
      clientId: CLIENT_A,
      recommendationId: "rec-1",
      userId: "auth0|alice",
    });
    expect(result.status).toBe("failed");
    expect(result.drafts.length).toBe(0);
    expect(result.skipped.length).toBeGreaterThan(0);
    const rec = prismaMock.state.recs.get("rec-1");
    expect(rec.status).toBe("NEEDS_REVIEW");
    expect(rec.generatedDraftIds.length).toBe(0);
  });

  it("returns status=failed when there are no eligible channels at all", async () => {
    prismaMock = makeMock({
      recs: [baseRec()],
      channels: [], // nothing enabled
    });
    const result = await svc.generateDraftsForRecommendation({
      clientId: CLIENT_A,
      recommendationId: "rec-1",
      userId: "auth0|alice",
    });
    expect(result.status).toBe("failed");
    const rec = prismaMock.state.recs.get("rec-1");
    expect(rec.status).toBe("NEEDS_REVIEW");
  });
});
