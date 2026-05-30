// Ads export — destination URL resolution.
//
// Final QA found SITE_PAGE destinations were emitted as
// "squadsite://page/<pageId>" — an internal placeholder that no
// agency could click or upload. Fix resolves SITE_PAGE through
// SitePage + Client.slug into a real https://<clientSlug>.<base>/<pageSlug>
// URL, and refuses to export when the page is missing, owned by
// a different workspace, or not yet PUBLISHED.
//
// These tests assert on the resolved URL + the failure modes.
// EXTERNAL_URL and SOCIAL_PROFILE behavior must remain unchanged.

import { describe, it, expect, vi, beforeEach } from "vitest";

let state;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return state.prisma;
  },
}));

const { exportPackage, ExportError } = await import(
  "../domains/ads/ads.export.service.js"
);

const CLIENT_A = "client-a";
const CLIENT_B = "client-b";

function basePackage(overrides = {}) {
  return {
    id: "pkg-1",
    clientId: CLIENT_A,
    name: "Spring push",
    objective: "TRAFFIC",
    status: "READY",
    specialCategory: "NONE",
    sourceType: "IDEA",
    sourceId: null,
    sourceIdea: "Promote spring",
    exportsJson: [],
    reviewedByUserId: "auth0|u1",
    reviewedAt: new Date(),
    reviewNotes: null,
    ...overrides,
  };
}

function buildPrismaMock({
  pkg,
  creatives = [],
  destination = null,
  pages = [],
  clients = [],
}) {
  const pages_ = new Map(pages.map((p) => [p.id, p]));
  const clients_ = new Map(clients.map((c) => [c.id, c]));
  const pkgWithJoins = {
    ...pkg,
    creatives,
    // Ads-02 — the export-side validator now requires populated
    // audience + budget. These tests focus on destination URL
    // resolution, so we inject minimal-but-valid defaults to
    // satisfy the gate without affecting the URL-resolution
    // assertions.
    audience: {
      locationsJson: [{ kind: "country", value: "US" }],
      ageMin: 18,
      ageMax: 65,
      gendersJson: ["all"],
      customAudienceHintsJson: [],
      housingRestricted: false,
    },
    budget: { dailyBudgetCents: 1000, totalBudgetCents: 0, currency: "USD" },
    destination,
  };
  return {
    adPackage: {
      findFirst: vi.fn(async ({ where }) => {
        if (pkgWithJoins.id !== where.id) return null;
        if (where.clientId && pkgWithJoins.clientId !== where.clientId) return null;
        return pkgWithJoins;
      }),
      update: vi.fn(async ({ data }) => ({ ...pkgWithJoins, ...data })),
    },
    sitePage: {
      findUnique: vi.fn(async ({ where }) => pages_.get(where.id) ?? null),
      // Ads-02 — validatePackageReady tenant-scopes the destination
      // lookup via findFirst({ id, clientId }).
      findFirst: vi.fn(async ({ where }) => {
        const row = pages_.get(where.id);
        if (!row) return null;
        if (where.clientId && row.clientId !== where.clientId) return null;
        return row;
      }),
    },
    client: {
      findUnique: vi.fn(async ({ where }) => clients_.get(where.id) ?? null),
    },
    mediaAsset: {
      findMany: vi.fn(async () => []),
    },
    // No campaign / draft / data item lookups exercised by these tests.
    campaign: { findUnique: vi.fn(async () => null) },
    draft: { findUnique: vi.fn(async () => null) },
    workspaceDataItem: { findUnique: vi.fn(async () => null) },
  };
}

describe("export destination — SITE_PAGE resolves to public URL", () => {
  beforeEach(() => {
    state = {
      prisma: buildPrismaMock({
        pkg: basePackage(),
        creatives: [
          {
            id: "c1",
            adPackageId: "pkg-1",
            variantIndex: 1,
            headline: "Hi",
            primaryText: "Body",
            additionalAssetIdsJson: [],
          },
        ],
        destination: {
          id: "dest-1",
          adPackageId: "pkg-1",
          kind: "SITE_PAGE",
          sitePageId: "page-1",
          externalUrl: null,
          socialProfile: null,
          utmJson: null,
          pixelIdsJson: [],
        },
        pages: [
          {
            id: "page-1",
            slug: "phase-b-test",
            status: "PUBLISHED",
            clientId: CLIENT_A,
            title: "Phase B Test",
          },
        ],
        clients: [{ id: CLIENT_A, slug: "daniel-wardlow" }],
      }),
    };
  });

  it("emits https://<clientSlug>.squadpitchsites.com/<pageSlug> in the JSON bundle", async () => {
    const result = await exportPackage(CLIENT_A, "pkg-1", "auth0|u1", {
      format: "json",
    });
    expect(result.bundle.destination.url).toBe(
      "https://daniel-wardlow.squadpitchsites.com/phase-b-test",
    );
    expect(result.content).not.toMatch(/squadsite:\/\//);
  });

  it("emits the same URL in the markdown body", async () => {
    const result = await exportPackage(CLIENT_A, "pkg-1", "auth0|u1", {
      format: "markdown",
    });
    expect(result.content).toMatch(
      /https:\/\/daniel-wardlow\.squadpitchsites\.com\/phase-b-test/,
    );
    expect(result.content).not.toMatch(/squadsite:\/\//);
  });

  it("respects PUBLIC_SITES_BASE_DOMAIN env var", async () => {
    const originalEnv = process.env.PUBLIC_SITES_BASE_DOMAIN;
    process.env.PUBLIC_SITES_BASE_DOMAIN = "ads.example.com";
    try {
      const result = await exportPackage(CLIENT_A, "pkg-1", "auth0|u1", {
        format: "json",
      });
      expect(result.bundle.destination.url).toBe(
        "https://daniel-wardlow.ads.example.com/phase-b-test",
      );
    } finally {
      // process.env values are coerced to strings — restoring an
      // originally-undefined value via assignment would leave the
      // literal string "undefined" behind. Delete it instead.
      if (originalEnv === undefined) {
        delete process.env.PUBLIC_SITES_BASE_DOMAIN;
      } else {
        process.env.PUBLIC_SITES_BASE_DOMAIN = originalEnv;
      }
    }
  });

  it("appends UTMs to the resolved URL", async () => {
    // Re-seed with a UTM-bearing destination
    state.prisma.adPackage.findFirst = vi.fn(async () => ({
      ...basePackage(),
      creatives: [
        {
          id: "c1",
          adPackageId: "pkg-1",
          variantIndex: 1,
          headline: "h",
          primaryText: "t",
          additionalAssetIdsJson: [],
        },
      ],
      // Ads-02 — validator now requires audience + budget.
      audience: {
        locationsJson: [{ kind: "country", value: "US" }],
        ageMin: 18,
        ageMax: 65,
        gendersJson: ["all"],
        customAudienceHintsJson: [],
      },
      budget: { dailyBudgetCents: 1000, currency: "USD" },
      destination: {
        id: "dest-1",
        adPackageId: "pkg-1",
        kind: "SITE_PAGE",
        sitePageId: "page-1",
        externalUrl: null,
        socialProfile: null,
        utmJson: { source: "meta", medium: "paid_social", campaign: "spring" },
        pixelIdsJson: [],
      },
    }));
    const result = await exportPackage(CLIENT_A, "pkg-1", "auth0|u1", {
      format: "json",
    });
    expect(result.bundle.destination.url).toMatch(
      /^https:\/\/daniel-wardlow\.squadpitchsites\.com\/phase-b-test\?/,
    );
    expect(result.bundle.destination.url).toContain("utm_source=meta");
    expect(result.bundle.destination.url).toContain("utm_medium=paid_social");
    expect(result.bundle.destination.url).toContain("utm_campaign=spring");
  });
});

describe("export destination — failure modes for SITE_PAGE", () => {
  it("throws SITE_PAGE_NOT_FOUND when the page doesn't exist", async () => {
    state = {
      prisma: buildPrismaMock({
        pkg: basePackage(),
        creatives: [{ id: "c1", adPackageId: "pkg-1", variantIndex: 1, headline: "h", primaryText: "t", additionalAssetIdsJson: [] }],
        destination: {
          id: "dest-1",
          adPackageId: "pkg-1",
          kind: "SITE_PAGE",
          sitePageId: "missing-page",
          externalUrl: null,
          socialProfile: null,
          utmJson: null,
          pixelIdsJson: [],
        },
        pages: [], // empty
        clients: [{ id: CLIENT_A, slug: "daniel-wardlow" }],
      }),
    };
    // Ads-02 — validator runs first and catches missing/foreign pages
    // with READY_PRECONDITIONS_FAILED. The URL builder's stricter
    // SITE_PAGE_NOT_FOUND code is now unreachable via the export path
    // (it remains in place as belt-and-suspenders for direct calls).
    await expect(exportPackage(CLIENT_A, "pkg-1", "auth0|u1")).rejects.toMatchObject({
      code: "READY_PRECONDITIONS_FAILED",
      missing: expect.arrayContaining([
        expect.stringContaining("site page not found"),
      ]),
    });
  });

  it("throws SITE_PAGE_NOT_FOUND when the page belongs to a different workspace", async () => {
    state = {
      prisma: buildPrismaMock({
        pkg: basePackage(),
        creatives: [{ id: "c1", adPackageId: "pkg-1", variantIndex: 1, headline: "h", primaryText: "t", additionalAssetIdsJson: [] }],
        destination: {
          id: "dest-1",
          adPackageId: "pkg-1",
          kind: "SITE_PAGE",
          sitePageId: "page-foreign",
          externalUrl: null,
          socialProfile: null,
          utmJson: null,
          pixelIdsJson: [],
        },
        pages: [
          {
            id: "page-foreign",
            slug: "other-page",
            status: "PUBLISHED",
            clientId: CLIENT_B, // ← different workspace
            title: "Foreign Page",
          },
        ],
        clients: [{ id: CLIENT_A, slug: "daniel-wardlow" }],
      }),
    };
    await expect(exportPackage(CLIENT_A, "pkg-1", "auth0|u1")).rejects.toMatchObject({
      code: "READY_PRECONDITIONS_FAILED",
      missing: expect.arrayContaining([
        expect.stringContaining("site page not found"),
      ]),
    });
  });

  it("throws SITE_PAGE_NOT_PUBLISHED when the page is DRAFT", async () => {
    state = {
      prisma: buildPrismaMock({
        pkg: basePackage(),
        creatives: [{ id: "c1", adPackageId: "pkg-1", variantIndex: 1, headline: "h", primaryText: "t", additionalAssetIdsJson: [] }],
        destination: {
          id: "dest-1",
          adPackageId: "pkg-1",
          kind: "SITE_PAGE",
          sitePageId: "page-draft",
          externalUrl: null,
          socialProfile: null,
          utmJson: null,
          pixelIdsJson: [],
        },
        pages: [
          {
            id: "page-draft",
            slug: "wip",
            status: "DRAFT",
            clientId: CLIENT_A,
            title: "Work in progress",
          },
        ],
        clients: [{ id: CLIENT_A, slug: "daniel-wardlow" }],
      }),
    };
    await expect(exportPackage(CLIENT_A, "pkg-1", "auth0|u1")).rejects.toMatchObject({
      code: "READY_PRECONDITIONS_FAILED",
      missing: expect.arrayContaining([
        expect.stringContaining("must be PUBLISHED"),
      ]),
    });
  });

  it("throws WORKSPACE_SLUG_MISSING when Client.slug is empty", async () => {
    state = {
      prisma: buildPrismaMock({
        pkg: basePackage(),
        creatives: [{ id: "c1", adPackageId: "pkg-1", variantIndex: 1, headline: "h", primaryText: "t", additionalAssetIdsJson: [] }],
        destination: {
          id: "dest-1",
          adPackageId: "pkg-1",
          kind: "SITE_PAGE",
          sitePageId: "page-1",
          externalUrl: null,
          socialProfile: null,
          utmJson: null,
          pixelIdsJson: [],
        },
        pages: [
          {
            id: "page-1",
            slug: "phase-b-test",
            status: "PUBLISHED",
            clientId: CLIENT_A,
            title: "Page",
          },
        ],
        clients: [{ id: CLIENT_A, slug: "" }], // no slug
      }),
    };
    await expect(exportPackage(CLIENT_A, "pkg-1", "auth0|u1")).rejects.toMatchObject({
      code: "WORKSPACE_SLUG_MISSING",
    });
  });

  it("throws DESTINATION_MISSING_SITE_PAGE when sitePageId is null", async () => {
    state = {
      prisma: buildPrismaMock({
        pkg: basePackage(),
        creatives: [{ id: "c1", adPackageId: "pkg-1", variantIndex: 1, headline: "h", primaryText: "t", additionalAssetIdsJson: [] }],
        destination: {
          id: "dest-1",
          adPackageId: "pkg-1",
          kind: "SITE_PAGE",
          sitePageId: null, // ← unset
          externalUrl: null,
          socialProfile: null,
          utmJson: null,
          pixelIdsJson: [],
        },
        pages: [],
        clients: [{ id: CLIENT_A, slug: "daniel-wardlow" }],
      }),
    };
    await expect(exportPackage(CLIENT_A, "pkg-1", "auth0|u1")).rejects.toMatchObject({
      code: "READY_PRECONDITIONS_FAILED",
      missing: expect.arrayContaining([
        expect.stringContaining("SITE_PAGE destination needs a sitePageId"),
      ]),
    });
  });
});

describe("export destination — EXTERNAL_URL / SOCIAL_PROFILE unchanged", () => {
  it("EXTERNAL_URL passes through verbatim and appends UTMs", async () => {
    state = {
      prisma: buildPrismaMock({
        pkg: basePackage(),
        creatives: [{ id: "c1", adPackageId: "pkg-1", variantIndex: 1, headline: "h", primaryText: "t", additionalAssetIdsJson: [] }],
        destination: {
          id: "dest-1",
          adPackageId: "pkg-1",
          kind: "EXTERNAL_URL",
          sitePageId: null,
          externalUrl: "https://example.com/landing",
          socialProfile: null,
          utmJson: { source: "google", medium: "cpc" },
          pixelIdsJson: [],
        },
        pages: [],
        clients: [{ id: CLIENT_A, slug: "daniel-wardlow" }],
      }),
    };
    const res = await exportPackage(CLIENT_A, "pkg-1", "auth0|u1", { format: "json" });
    expect(res.bundle.destination.url).toBe(
      "https://example.com/landing?utm_source=google&utm_medium=cpc",
    );
  });

  it("SOCIAL_PROFILE passes through and does NOT get UTMs appended", async () => {
    state = {
      prisma: buildPrismaMock({
        pkg: basePackage(),
        creatives: [{ id: "c1", adPackageId: "pkg-1", variantIndex: 1, headline: "h", primaryText: "t", additionalAssetIdsJson: [] }],
        destination: {
          id: "dest-1",
          adPackageId: "pkg-1",
          kind: "SOCIAL_PROFILE",
          sitePageId: null,
          externalUrl: null,
          socialProfile: "instagram:smithrealty",
          utmJson: { source: "would_be_ignored" },
          pixelIdsJson: [],
        },
        pages: [],
        clients: [{ id: CLIENT_A, slug: "daniel-wardlow" }],
      }),
    };
    const res = await exportPackage(CLIENT_A, "pkg-1", "auth0|u1", { format: "json" });
    expect(res.bundle.destination.url).toBe("instagram:smithrealty");
    expect(res.bundle.destination.url).not.toContain("utm_");
  });
});
