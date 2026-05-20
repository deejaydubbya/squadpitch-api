// Ads-10 — creative asset workflow + platform spec notes.
//
// Covers the rules the asset workflow has to hold:
//   - upsertCreative persists a valid primaryAssetId +
//     additionalAssetIds that belong to the workspace.
//   - upsertCreative rejects a cross-workspace primary asset with
//     MEDIA_ASSET_NOT_FOUND_OR_FORBIDDEN (no rows written).
//   - export bundle includes asset URL + width + height + mimeType
//     + altText on the creatives' primaryAsset descriptor.
//   - launch sheets (meta / linkedin / pinterest) include the
//     asset URL, dimensions, alt text, AND a "Creative specs"
//     section seeded by _platformSpecs.js.
//   - readiness validator does NOT require an asset (ads-10 says
//     missing asset is a warning, not a blocker).

import { describe, it, expect, vi, beforeEach } from "vitest";

let fixtures;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return fixtures.prisma;
  },
}));
vi.mock("../domains/studio/generation/clientOrchestrator.js", () => ({
  loadClientGenerationContext: vi.fn(),
}));
vi.mock("../domains/studio/generation/openai.provider.js", () => ({
  generateStructuredContent: vi.fn(),
}));
vi.mock("../domains/billing/aiUsageTracking.service.js", () => ({
  trackAiUsage: vi.fn(),
}));

const service = await import("../domains/ads/ads.service.js");
const exportSvc = await import("../domains/ads/ads.export.service.js");
const { platformSpec } = await import("../domains/ads/exporters/_platformSpecs.js");

const CLIENT_A = "client-a";
const CLIENT_B = "client-b";

function buildPrismaMock(initial = {}) {
  const state = {
    adPackages: new Map(initial.adPackages ?? []),
    adCreatives: new Map(initial.adCreatives ?? []),
    adAudiences: new Map(initial.adAudiences ?? []),
    adBudgets: new Map(initial.adBudgets ?? []),
    adDestinations: new Map(initial.adDestinations ?? []),
    mediaAssets: new Map(initial.mediaAssets ?? []),
  };
  function attach(p) {
    return {
      ...p,
      creatives: [...state.adCreatives.values()]
        .filter((c) => c.adPackageId === p.id)
        .sort((a, b) => a.variantIndex - b.variantIndex),
      audience: [...state.adAudiences.values()].find((a) => a.adPackageId === p.id) ?? null,
      budget: [...state.adBudgets.values()].find((b) => b.adPackageId === p.id) ?? null,
      destination: [...state.adDestinations.values()].find((d) => d.adPackageId === p.id) ?? null,
    };
  }
  return {
    state,
    adPackage: {
      findFirst: vi.fn(async ({ where }) => {
        for (const p of state.adPackages.values()) {
          if (p.id === where.id && p.clientId === where.clientId) return attach(p);
        }
        return null;
      }),
      findUnique: vi.fn(async ({ where }) => {
        const row = state.adPackages.get(where.id);
        return row ? attach(row) : null;
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = state.adPackages.get(where.id);
        const next = { ...row, ...data };
        state.adPackages.set(where.id, next);
        return next;
      }),
    },
    adCreative: {
      upsert: vi.fn(async ({ where, create, update }) => {
        const existing = [...state.adCreatives.values()].find(
          (c) =>
            c.adPackageId === where.adPackageId_variantIndex.adPackageId &&
            c.variantIndex === where.adPackageId_variantIndex.variantIndex,
        );
        if (existing) {
          const next = { ...existing, ...update };
          state.adCreatives.set(existing.id, next);
          return next;
        }
        const id = `cr-${state.adCreatives.size + 1}`;
        const row = { id, ...create };
        state.adCreatives.set(id, row);
        return row;
      }),
    },
    mediaAsset: {
      findMany: vi.fn(async ({ where }) => {
        const wantIds = new Set((where?.id?.in ?? []).filter(Boolean));
        const clientId = where?.clientId;
        return [...state.mediaAssets.values()].filter(
          (a) => wantIds.has(a.id) && (clientId == null || a.clientId === clientId),
        );
      }),
    },
    campaign: { findFirst: vi.fn(async () => null) },
    sitePage: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
    draft: { findFirst: vi.fn(async () => null) },
    workspaceDataItem: { findFirst: vi.fn(async () => null) },
    client: { findUnique: vi.fn(async () => ({ slug: "smith-realty" })) },
  };
}

beforeEach(() => {
  fixtures = {
    prisma: buildPrismaMock({
      adPackages: [
        [
          "pkg-1",
          {
            id: "pkg-1",
            clientId: CLIENT_A,
            name: "Spring open house",
            status: "DRAFT",
            specialCategory: "NONE",
            exportsJson: [],
            objective: "TRAFFIC",
            sourceType: "IDEA",
            sourceId: null,
            sourceIdea: "Brief",
          },
        ],
      ],
      mediaAssets: [
        [
          "asset-a",
          {
            id: "asset-a",
            clientId: CLIENT_A,
            url: "https://cdn.squadpitch.example.com/asset-a.jpg",
            thumbnailUrl: null,
            mimeType: "image/jpeg",
            assetType: "image",
            altText: "Front of 508 King George Court",
            width: 1080,
            height: 1350,
            bytes: 245760,
            videoDurationSec: null,
          },
        ],
        [
          "asset-foreign",
          {
            id: "asset-foreign",
            clientId: CLIENT_B,
            url: "https://cdn.squadpitch.example.com/foreign.jpg",
            mimeType: "image/jpeg",
            assetType: "image",
            altText: null,
            width: 800,
            height: 800,
          },
        ],
      ],
    }),
  };
});

describe("upsertCreative — asset tenant scoping", () => {
  it("persists primary + additional assets that belong to the workspace", async () => {
    const out = await service.upsertCreative(CLIENT_A, "pkg-1", {
      variantIndex: 1,
      headline: "H",
      primaryText: "T",
      primaryAssetId: "asset-a",
      additionalAssetIds: [],
    });
    expect(out.primaryAssetId).toBe("asset-a");
    expect(out.additionalAssetIdsJson).toEqual([]);
  });

  it("rejects a primaryAssetId from another workspace and writes nothing", async () => {
    await expect(
      service.upsertCreative(CLIENT_A, "pkg-1", {
        variantIndex: 1,
        headline: "H",
        primaryText: "T",
        primaryAssetId: "asset-foreign",
        additionalAssetIds: [],
      }),
    ).rejects.toMatchObject({ code: "MEDIA_ASSET_NOT_FOUND_OR_FORBIDDEN" });

    // No creative row should have been written.
    expect(fixtures.prisma.state.adCreatives.size).toBe(0);
  });

  it("rejects when ANY additional asset is cross-workspace (atomic)", async () => {
    await expect(
      service.upsertCreative(CLIENT_A, "pkg-1", {
        variantIndex: 1,
        headline: "H",
        primaryText: "T",
        primaryAssetId: "asset-a",
        additionalAssetIds: ["asset-foreign"],
      }),
    ).rejects.toMatchObject({ code: "MEDIA_ASSET_NOT_FOUND_OR_FORBIDDEN" });
    expect(fixtures.prisma.state.adCreatives.size).toBe(0);
  });
});

describe("exportPackage — bundle carries enriched asset descriptors", () => {
  function makeReadyPackage(specialCategory = "NONE") {
    const pkg = fixtures.prisma.state.adPackages.get("pkg-1");
    fixtures.prisma.state.adPackages.set("pkg-1", { ...pkg, status: "READY", specialCategory });
    fixtures.prisma.state.adCreatives.set("c1", {
      id: "c1",
      adPackageId: "pkg-1",
      variantIndex: 1,
      channel: null,
      headline: "Headline",
      primaryText: "Body",
      description: null,
      cta: "Tour",
      primaryAssetId: "asset-a",
      additionalAssetIdsJson: [],
      rationale: null,
    });
    fixtures.prisma.state.adAudiences.set("a1", {
      id: "a1",
      adPackageId: "pkg-1",
      locationsJson: [{ kind: "city", value: "Cary, NC" }],
      ageMin: 25,
      ageMax: 55,
      gendersJson: ["all"],
      interestsJson: [],
      customAudienceHintsJson: [],
      languagesJson: ["en"],
      housingRestricted: specialCategory === "HOUSING",
    });
    fixtures.prisma.state.adBudgets.set("b1", {
      id: "b1",
      adPackageId: "pkg-1",
      dailyBudgetCents: 5000,
      totalBudgetCents: null,
      currency: "USD",
      durationDays: 14,
      startsAt: null,
      endsAt: null,
    });
    fixtures.prisma.state.adDestinations.set("d1", {
      id: "d1",
      adPackageId: "pkg-1",
      kind: "EXTERNAL_URL",
      sitePageId: null,
      externalUrl: "https://smithrealty.example.com/open-house",
      socialProfile: null,
      utmJson: { source: "meta", medium: "paid_social" },
      pixelIdsJson: [],
    });
  }

  it("squadads_json bundle.creatives[0].primaryAsset carries width/height/mime/alt", async () => {
    makeReadyPackage();
    const res = await exportSvc.exportPackage(CLIENT_A, "pkg-1", "auth0|u1", {
      format: "squadads_json",
    });
    const parsed = JSON.parse(res.content);
    const c = parsed.creatives[0];
    expect(c.primaryAssetUrl).toBe("https://cdn.squadpitch.example.com/asset-a.jpg");
    expect(c.primaryAsset).toMatchObject({
      url: "https://cdn.squadpitch.example.com/asset-a.jpg",
      mimeType: "image/jpeg",
      assetType: "image",
      altText: "Front of 508 King George Court",
      width: 1080,
      height: 1350,
    });
  });

  it("meta_launch_sheet renders asset URL + dimensions + alt text + Creative specs section", async () => {
    makeReadyPackage();
    const res = await exportSvc.exportPackage(CLIENT_A, "pkg-1", "auth0|u1", {
      format: "meta_launch_sheet",
    });
    // Asset URL appears with the (image · 1080×1350 · 240 KB) suffix.
    expect(res.content).toContain("https://cdn.squadpitch.example.com/asset-a.jpg");
    expect(res.content).toMatch(/1080×1350/);
    expect(res.content).toMatch(/image/);
    // Alt text surfaces underneath.
    expect(res.content).toContain("Front of 508 King George Court");
    // Creative specs section appears (seeded from _platformSpecs.meta).
    expect(res.content).toMatch(/## Creative specs \(Meta\)/);
    expect(res.content).toMatch(/Square 1:1/);
  });

  it("linkedin_launch_sheet renders Creative specs (LinkedIn) section", async () => {
    makeReadyPackage();
    const res = await exportSvc.exportPackage(CLIENT_A, "pkg-1", "auth0|u1", {
      format: "linkedin_launch_sheet",
    });
    expect(res.content).toMatch(/## Creative specs \(LinkedIn\)/);
    expect(res.content).toMatch(/Single Image/);
  });

  it("pinterest_launch_sheet renders Creative specs (Pinterest) section + 2:3 vertical hint", async () => {
    makeReadyPackage();
    const res = await exportSvc.exportPackage(CLIENT_A, "pkg-1", "auth0|u1", {
      format: "pinterest_launch_sheet",
    });
    expect(res.content).toMatch(/## Creative specs \(Pinterest\)/);
    expect(res.content).toMatch(/vertical 2:3/i);
  });

  it("when no primary asset attached, bundle.primaryAsset is null and launch sheet says 'none'", async () => {
    makeReadyPackage();
    // Strip the asset id from the creative.
    const c = fixtures.prisma.state.adCreatives.get("c1");
    fixtures.prisma.state.adCreatives.set("c1", { ...c, primaryAssetId: null });
    const res = await exportSvc.exportPackage(CLIENT_A, "pkg-1", "auth0|u1", {
      format: "meta_launch_sheet",
    });
    expect(res.content).toMatch(/upload the creative directly in Ads Manager/);
  });
});

describe("platform spec lookup", () => {
  it("returns spec text for each registered platform", () => {
    for (const p of ["meta", "tiktok", "linkedin", "pinterest", "google"]) {
      const spec = platformSpec(p);
      expect(spec, `${p} should have a spec`).toBeTruthy();
      expect(spec.length).toBeGreaterThan(20);
    }
  });
  it("returns null for unknown platforms", () => {
    expect(platformSpec("definitely_not_a_platform")).toBeNull();
  });
});

describe("readiness validator — missing asset is NOT a blocker (ads-10)", () => {
  it("validatePackageReady passes when no primary asset is attached", async () => {
    // Build a fully-ready package WITHOUT any asset on the creative.
    fixtures.prisma.state.adCreatives.set("c1", {
      id: "c1",
      adPackageId: "pkg-1",
      variantIndex: 1,
      channel: null,
      headline: "Headline",
      primaryText: "Body",
      description: null,
      cta: "Tour",
      primaryAssetId: null,
      additionalAssetIdsJson: [],
      rationale: null,
    });
    fixtures.prisma.state.adAudiences.set("a1", {
      id: "a1",
      adPackageId: "pkg-1",
      locationsJson: [{ kind: "city", value: "Cary, NC" }],
      ageMin: 25,
      ageMax: 55,
      gendersJson: ["all"],
      interestsJson: [],
      customAudienceHintsJson: [],
      languagesJson: ["en"],
      housingRestricted: false,
    });
    fixtures.prisma.state.adBudgets.set("b1", {
      id: "b1",
      adPackageId: "pkg-1",
      dailyBudgetCents: 5000,
      currency: "USD",
      durationDays: 14,
    });
    fixtures.prisma.state.adDestinations.set("d1", {
      id: "d1",
      adPackageId: "pkg-1",
      kind: "EXTERNAL_URL",
      externalUrl: "https://smithrealty.example.com/open-house",
      pixelIdsJson: [],
    });
    const pkg = await fixtures.prisma.adPackage.findFirst({
      where: { id: "pkg-1", clientId: CLIENT_A },
    });
    // Should not throw — asset isn't required.
    await expect(service.validatePackageReady(pkg)).resolves.not.toThrow();
  });
});
