// Ads-01 — tenant-scoping contract for SquadAds.
//
// Pins the rules locked in by spinstr ads-01:
//   - createPackage rejects a source from another workspace.
//   - createPackage IDEA path requires sourceIdea; other types
//     require sourceId.
//   - upsertCreative rejects any cross-workspace media asset id
//     atomically (mixed valid + invalid = reject all).
//   - deleteCreative scoped delete throws CREATIVE_NOT_FOUND for a
//     creativeId that doesn't belong to the package's workspace.
//   - loadPackageSourceContext returns row=null for cross-workspace
//     sources (defensive — never leak foreign workspace data).
//   - Export media resolver silently drops cross-workspace asset
//     ids (legacy / pre-validation rows).

import { describe, it, expect, vi, beforeEach } from "vitest";

let fixtures;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return fixtures.prisma;
  },
}));

vi.mock("../domains/studio/generation/clientOrchestrator.js", () => ({
  loadClientGenerationContext: vi.fn(async () => ({
    client: { name: "Test" },
    brand: null,
    voice: null,
  })),
}));

vi.mock("../domains/studio/generation/openai.provider.js", () => ({
  generateStructuredContent: vi.fn(),
}));

vi.mock("../domains/billing/aiUsageTracking.service.js", () => ({
  trackAiUsage: vi.fn(),
}));

const service = await import("../domains/ads/ads.service.js");
const exportService = await import("../domains/ads/ads.export.service.js");

const CLIENT_A = "client-A";
const CLIENT_B = "client-B";

function buildPrismaMock(initial = {}) {
  const state = {
    adPackages: new Map(initial.adPackages ?? []),
    adCreatives: new Map(initial.adCreatives ?? []),
    campaigns: new Map(initial.campaigns ?? []),
    sitePages: new Map(initial.sitePages ?? []),
    drafts: new Map(initial.drafts ?? []),
    workspaceDataItems: new Map(initial.workspaceDataItems ?? []),
    mediaAssets: new Map(initial.mediaAssets ?? []),
    brandProfiles: new Map(),
  };
  return {
    state,
    adPackage: {
      findFirst: vi.fn(async ({ where }) => {
        const row = state.adPackages.get(where.id);
        if (!row) return null;
        if (where.clientId && row.clientId !== where.clientId) return null;
        return row;
      }),
      create: vi.fn(async ({ data }) => {
        const id = `pkg-${state.adPackages.size + 1}`;
        const { destination, ...rest } = data;
        const row = {
          id,
          ...rest,
          status: "DRAFT",
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        state.adPackages.set(id, row);
        return { ...row, creatives: [], audience: null, budget: null, destination: null };
      }),
    },
    adCreative: {
      upsert: vi.fn(async ({ create }) => {
        const id = `cr-${state.adCreatives.size + 1}`;
        const row = { id, ...create };
        state.adCreatives.set(id, row);
        return row;
      }),
      deleteMany: vi.fn(async ({ where }) => {
        let n = 0;
        for (const [id, c] of state.adCreatives.entries()) {
          if (c.id !== where.id) continue;
          if (c.adPackageId !== where.adPackageId) continue;
          const pkg = state.adPackages.get(c.adPackageId);
          if (!pkg || pkg.clientId !== where.adPackage.clientId) continue;
          state.adCreatives.delete(id);
          n++;
        }
        return { count: n };
      }),
    },
    brandProfile: {
      findUnique: vi.fn(async () => null),
    },
    campaign: {
      findFirst: vi.fn(async ({ where }) => {
        const row = state.campaigns.get(where.id);
        if (!row) return null;
        if (where.clientId && row.clientId !== where.clientId) return null;
        return row;
      }),
    },
    sitePage: {
      findFirst: vi.fn(async ({ where }) => {
        const row = state.sitePages.get(where.id);
        if (!row) return null;
        if (where.clientId && row.clientId !== where.clientId) return null;
        return row;
      }),
    },
    draft: {
      findFirst: vi.fn(async ({ where }) => {
        const row = state.drafts.get(where.id);
        if (!row) return null;
        if (where.clientId && row.clientId !== where.clientId) return null;
        return row;
      }),
    },
    workspaceDataItem: {
      findFirst: vi.fn(async ({ where }) => {
        const row = state.workspaceDataItems.get(where.id);
        if (!row) return null;
        if (where.clientId && row.clientId !== where.clientId) return null;
        if (typeof where.type === "string" && row.type !== where.type) return null;
        if (where.type?.not && row.type === where.type.not) return null;
        return row;
      }),
    },
    mediaAsset: {
      findMany: vi.fn(async ({ where }) => {
        const ids = new Set(where.id?.in ?? []);
        return [...state.mediaAssets.values()].filter((a) => {
          if (!ids.has(a.id)) return false;
          if (where.clientId && a.clientId !== where.clientId) return false;
          return true;
        });
      }),
    },
  };
}

beforeEach(() => {
  fixtures = { prisma: buildPrismaMock() };
});

describe("createPackage — source ownership", () => {
  it("rejects a CAMPAIGN sourceId that belongs to another workspace", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        campaigns: [["camp-b1", { id: "camp-b1", clientId: CLIENT_B, name: "X", campaignType: "X" }]],
      }),
    };
    await expect(
      service.createPackage(CLIENT_A, "u1", {
        name: "X",
        objective: "LEADS",
        sourceType: "CAMPAIGN",
        sourceId: "camp-b1",
      }),
    ).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND_OR_FORBIDDEN", status: 404 });
  });

  it("rejects a SITE_PAGE sourceId from another workspace", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        sitePages: [["page-b1", { id: "page-b1", clientId: CLIENT_B, title: "X", slug: "x" }]],
      }),
    };
    await expect(
      service.createPackage(CLIENT_A, "u1", {
        name: "X",
        objective: "LEADS",
        sourceType: "SITE_PAGE",
        sourceId: "page-b1",
      }),
    ).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND_OR_FORBIDDEN" });
  });

  it("rejects a DRAFT sourceId from another workspace", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        drafts: [["draft-b1", { id: "draft-b1", clientId: CLIENT_B, channel: "FACEBOOK", body: "X" }]],
      }),
    };
    await expect(
      service.createPackage(CLIENT_A, "u1", {
        name: "X",
        objective: "LEADS",
        sourceType: "DRAFT",
        sourceId: "draft-b1",
      }),
    ).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND_OR_FORBIDDEN" });
  });

  it("rejects a PROPERTY sourceId from another workspace", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        workspaceDataItems: [
          ["data-b1", { id: "data-b1", clientId: CLIENT_B, type: "PROPERTY", title: "X" }],
        ],
      }),
    };
    await expect(
      service.createPackage(CLIENT_A, "u1", {
        name: "X",
        objective: "LEADS",
        sourceType: "PROPERTY",
        sourceId: "data-b1",
      }),
    ).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND_OR_FORBIDDEN" });
  });

  it("rejects PROPERTY sourceId pointing at a non-PROPERTY WorkspaceDataItem", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        workspaceDataItems: [
          ["data-a1", { id: "data-a1", clientId: CLIENT_A, type: "TESTIMONIAL", title: "X" }],
        ],
      }),
    };
    await expect(
      service.createPackage(CLIENT_A, "u1", {
        name: "X",
        objective: "LEADS",
        sourceType: "PROPERTY",
        sourceId: "data-a1",
      }),
    ).rejects.toMatchObject({ code: "SOURCE_NOT_FOUND_OR_FORBIDDEN" });
  });

  it("IDEA without sourceIdea is rejected", async () => {
    await expect(
      service.createPackage(CLIENT_A, "u1", {
        name: "X",
        objective: "LEADS",
        sourceType: "IDEA",
      }),
    ).rejects.toMatchObject({ code: "MISSING_SOURCE_IDEA" });
  });

  it("non-IDEA without sourceId is rejected", async () => {
    await expect(
      service.createPackage(CLIENT_A, "u1", {
        name: "X",
        objective: "LEADS",
        sourceType: "CAMPAIGN",
      }),
    ).rejects.toMatchObject({ code: "MISSING_SOURCE_ID" });
  });

  it("CAMPAIGN owned by the same workspace persists", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        campaigns: [["camp-a1", { id: "camp-a1", clientId: CLIENT_A, name: "X", campaignType: "X" }]],
      }),
    };
    const pkg = await service.createPackage(CLIENT_A, "u1", {
      name: "X",
      objective: "LEADS",
      sourceType: "CAMPAIGN",
      sourceId: "camp-a1",
    });
    expect(pkg.id).toBeDefined();
    expect(pkg.sourceId).toBe("camp-a1");
  });
});

describe("upsertCreative — media asset ownership", () => {
  function seedPkg(initial = {}) {
    fixtures = {
      prisma: buildPrismaMock({
        adPackages: [
          [
            "pkg-1",
            {
              id: "pkg-1",
              clientId: CLIENT_A,
              name: "X",
              objective: "LEADS",
              status: "DRAFT",
              sourceType: "IDEA",
              sourceIdea: "x",
            },
          ],
        ],
        ...initial,
      }),
    };
  }

  it("rejects a primaryAssetId from another workspace", async () => {
    seedPkg({
      mediaAssets: [["asset-b1", { id: "asset-b1", clientId: CLIENT_B, url: "https://x" }]],
    });
    await expect(
      service.upsertCreative(CLIENT_A, "pkg-1", {
        variantIndex: 0,
        headline: "H",
        primaryText: "P",
        primaryAssetId: "asset-b1",
      }),
    ).rejects.toMatchObject({
      code: "MEDIA_ASSET_NOT_FOUND_OR_FORBIDDEN",
      status: 404,
    });
  });

  it("rejects atomically when additionalAssetIds mixes valid + invalid", async () => {
    seedPkg({
      mediaAssets: [
        ["asset-a1", { id: "asset-a1", clientId: CLIENT_A, url: "https://a1" }],
        ["asset-b1", { id: "asset-b1", clientId: CLIENT_B, url: "https://b1" }],
      ],
    });
    await expect(
      service.upsertCreative(CLIENT_A, "pkg-1", {
        variantIndex: 0,
        headline: "H",
        primaryText: "P",
        primaryAssetId: "asset-a1",
        additionalAssetIds: ["asset-a1", "asset-b1"],
      }),
    ).rejects.toMatchObject({
      code: "MEDIA_ASSET_NOT_FOUND_OR_FORBIDDEN",
      missingAssetIds: ["asset-b1"],
    });
    // Nothing should have been written.
    expect(fixtures.prisma.state.adCreatives.size).toBe(0);
  });

  it("persists when every asset belongs to the workspace", async () => {
    seedPkg({
      mediaAssets: [
        ["asset-a1", { id: "asset-a1", clientId: CLIENT_A, url: "https://a1" }],
        ["asset-a2", { id: "asset-a2", clientId: CLIENT_A, url: "https://a2" }],
      ],
    });
    const cr = await service.upsertCreative(CLIENT_A, "pkg-1", {
      variantIndex: 0,
      headline: "H",
      primaryText: "P",
      primaryAssetId: "asset-a1",
      additionalAssetIds: ["asset-a2"],
    });
    expect(cr.primaryAssetId).toBe("asset-a1");
    expect(cr.additionalAssetIdsJson).toEqual(["asset-a2"]);
  });

  it("allows null primaryAssetId + empty additionalAssetIds", async () => {
    seedPkg();
    const cr = await service.upsertCreative(CLIENT_A, "pkg-1", {
      variantIndex: 0,
      headline: "H",
      primaryText: "P",
    });
    expect(cr.primaryAssetId).toBeNull();
  });
});

describe("deleteCreative — scoped delete", () => {
  it("throws CREATIVE_NOT_FOUND when the creative belongs to another package", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        adPackages: [
          ["pkg-a", { id: "pkg-a", clientId: CLIENT_A, status: "DRAFT" }],
          ["pkg-b", { id: "pkg-b", clientId: CLIENT_B, status: "DRAFT" }],
        ],
        adCreatives: [
          ["cr-b1", { id: "cr-b1", adPackageId: "pkg-b", variantIndex: 0 }],
        ],
      }),
    };
    await expect(
      service.deleteCreative(CLIENT_A, "pkg-a", "cr-b1"),
    ).rejects.toMatchObject({ code: "CREATIVE_NOT_FOUND", status: 404 });
    // Cross-package creative still exists.
    expect(fixtures.prisma.state.adCreatives.size).toBe(1);
  });

  it("throws CREATIVE_NOT_FOUND when packageId is from another workspace", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        adPackages: [
          ["pkg-b", { id: "pkg-b", clientId: CLIENT_B, status: "DRAFT" }],
        ],
        adCreatives: [
          ["cr-b1", { id: "cr-b1", adPackageId: "pkg-b", variantIndex: 0 }],
        ],
      }),
    };
    await expect(
      service.deleteCreative(CLIENT_A, "pkg-b", "cr-b1"),
    ).rejects.toMatchObject({ code: "CREATIVE_NOT_FOUND" });
    expect(fixtures.prisma.state.adCreatives.size).toBe(1);
  });

  it("deletes when everything matches", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        adPackages: [["pkg-a", { id: "pkg-a", clientId: CLIENT_A, status: "DRAFT" }]],
        adCreatives: [["cr-a1", { id: "cr-a1", adPackageId: "pkg-a", variantIndex: 0 }]],
      }),
    };
    const result = await service.deleteCreative(CLIENT_A, "pkg-a", "cr-a1");
    expect(result.deleted).toBe(true);
    expect(fixtures.prisma.state.adCreatives.size).toBe(0);
  });
});

describe("loadPackageSourceContext — silently drops cross-workspace sources", () => {
  it("CAMPAIGN: returns row=null when the source belongs to another workspace", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        campaigns: [["camp-b1", { id: "camp-b1", clientId: CLIENT_B, name: "X", campaignType: "X" }]],
      }),
    };
    const ctx = await service.loadPackageSourceContext({
      sourceType: "CAMPAIGN",
      sourceId: "camp-b1",
      clientId: CLIENT_A,
    });
    expect(ctx).toEqual({ kind: "campaign", row: null });
  });

  it("PROPERTY: returns row=null when the source belongs to another workspace", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        workspaceDataItems: [
          ["data-b1", { id: "data-b1", clientId: CLIENT_B, type: "PROPERTY", title: "X" }],
        ],
      }),
    };
    const ctx = await service.loadPackageSourceContext({
      sourceType: "PROPERTY",
      sourceId: "data-b1",
      clientId: CLIENT_A,
    });
    expect(ctx).toEqual({ kind: "data_item", row: null });
  });
});
