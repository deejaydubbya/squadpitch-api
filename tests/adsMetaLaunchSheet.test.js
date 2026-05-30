// Ads-07 — Meta launch sheet (Markdown brief).
//
// Covers:
//   - MIME = text/markdown; charset=utf-8, extension = .md, label
//     mentions Meta/Facebook/Instagram.
//   - HOUSING packages get a prominent Special Ad Category block
//     at the top with the 4 Meta-specific compliance items
//     (Housing category set, no ZIP-only, no narrow age/gender,
//     protected-class copy review).
//   - Non-HOUSING packages do NOT show housing-only instructions.
//   - Every creative variant is rendered with headline + primary
//     text + CTA + asset URL.
//   - Destination URL + budget appear.
//   - Objective mapping (SquadAds → Meta) with confirm-notes for
//     ambiguous cases.
//   - isDirectImport=false; SETUP CHECKLIST present.

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

const exportSvc = await import("../domains/ads/ads.export.service.js");
const { getExporter } = await import("../domains/ads/exporters/index.js");

const CLIENT_ID = "client-1";

function buildPrismaMock({ pkg, creatives, audience, budget, destination } = {}) {
  const state = {
    adPackages: new Map([
      [
        "pkg-meta",
        pkg ?? {
          id: "pkg-meta",
          clientId: CLIENT_ID,
          name: "Spring open house",
          status: "READY",
          specialCategory: "NONE",
          exportsJson: [],
          objective: "TRAFFIC",
          sourceType: "IDEA",
          sourceId: null,
          sourceIdea: "Brief",
        },
      ],
    ]),
  };
  function attach(p) {
    return {
      ...p,
      creatives:
        creatives ?? [
          {
            id: "c1",
            adPackageId: p.id,
            variantIndex: 1,
            channel: "FACEBOOK",
            headline: "Visit our open house",
            primaryText: "Sunday 1–4 PM at 508 King George Court.",
            description: "Tour the home with our agent.",
            cta: "Schedule Tour",
            primaryAssetId: "asset-1",
            additionalAssetIdsJson: [],
            rationale: "Lead-in for open-house weekend.",
          },
        ],
      audience:
        audience ?? {
          id: "a1",
          adPackageId: p.id,
          locationsJson: [{ kind: "city", value: "Cary, NC" }],
          ageMin: 25,
          ageMax: 55,
          gendersJson: ["all"],
          interestsJson: ["home buying"],
          customAudienceHintsJson: [],
          languagesJson: ["en"],
          housingRestricted: p.specialCategory === "HOUSING",
        },
      budget:
        budget ?? {
          id: "b1",
          adPackageId: p.id,
          dailyBudgetCents: 5000,
          totalBudgetCents: null,
          currency: "USD",
          durationDays: 14,
          startsAt: null,
          endsAt: null,
        },
      destination:
        destination === undefined
          ? {
              id: "d1",
              adPackageId: p.id,
              kind: "EXTERNAL_URL",
              sitePageId: null,
              externalUrl: "https://smithrealty.example.com/open-house",
              socialProfile: null,
              utmJson: { source: "meta", medium: "paid_social", campaign: "spring" },
              pixelIdsJson: ["123456789012345"],
            }
          : destination,
    };
  }
  return {
    state,
    adPackage: {
      findFirst: vi.fn(async ({ where }) => {
        const p = state.adPackages.get(where.id);
        if (!p || p.clientId !== where.clientId) return null;
        return attach(p);
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = state.adPackages.get(where.id);
        const next = { ...row, ...data };
        state.adPackages.set(where.id, next);
        return next;
      }),
    },
    campaign: { findFirst: vi.fn(async () => null) },
    sitePage: { findFirst: vi.fn(async () => null), findUnique: vi.fn(async () => null) },
    draft: { findFirst: vi.fn(async () => null) },
    workspaceDataItem: { findFirst: vi.fn(async () => null) },
    mediaAsset: {
      findMany: vi.fn(async ({ where }) => {
        const ids = new Set((where?.id?.in ?? []).filter(Boolean));
        if (ids.has("asset-1")) {
          return [
            {
              id: "asset-1",
              url: "https://cdn.squadpitch.example.com/asset-1.jpg",
              thumbnailUrl: null,
              mimeType: "image/jpeg",
              assetType: "image",
              altText: null,
            },
          ];
        }
        return [];
      }),
    },
    client: { findUnique: vi.fn(async () => ({ slug: "smith-realty" })) },
  };
}

beforeEach(() => {
  fixtures = { prisma: buildPrismaMock() };
});

describe("meta_launch_sheet — metadata + framing", () => {
  it("returns text/markdown + .md + meta platform + label mentions Facebook/Instagram", async () => {
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-meta", "auth0|u1", {
      format: "meta_launch_sheet",
    });
    expect(res.mimeType).toBe("text/markdown; charset=utf-8");
    expect(res.extension).toBe("md");
    expect(res.platform).toBe("meta");
    expect(res.label).toMatch(/Facebook/i);
    expect(res.label).toMatch(/Instagram/i);
    expect(res.isDirectImport).toBe(false);
    expect(res.importStyle).toBe("meta_launch_sheet");
    expect(res.filename.endsWith(".meta-launch-sheet.md")).toBe(true);
  });

  it("registry notes are honest: not a direct import, points at Ads Manager", async () => {
    const exp = getExporter("meta_launch_sheet");
    expect(exp.notes.toLowerCase()).toMatch(/not.*bulk-import/);
    expect(exp.notes.toLowerCase()).toMatch(/ads manager/);
  });
});

describe("meta_launch_sheet — required sections + content", () => {
  it("renders Campaign / Destination / Audience / Budget / Creatives / SETUP CHECKLIST sections", async () => {
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-meta", "auth0|u1", {
      format: "meta_launch_sheet",
    });
    expect(res.content).toMatch(/^# Meta launch sheet/);
    expect(res.content).toMatch(/## Campaign/);
    expect(res.content).toMatch(/## Destination/);
    expect(res.content).toMatch(/## Audience/);
    expect(res.content).toMatch(/## Budget/);
    expect(res.content).toMatch(/## Creatives/);
    expect(res.content).toMatch(/## SETUP CHECKLIST/);
  });

  it("destination URL with UTMs is rendered (Meta does not auto-append, so the brief notes that)", async () => {
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-meta", "auth0|u1", {
      format: "meta_launch_sheet",
    });
    expect(res.content).toMatch(/https:\/\/smithrealty\.example\.com\/open-house\?[^>]*utm_source=meta/);
    expect(res.content).toMatch(/Meta does not auto-append UTMs/i);
  });

  it("budget shows daily amount + currency", async () => {
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-meta", "auth0|u1", {
      format: "meta_launch_sheet",
    });
    expect(res.content).toMatch(/Daily budget:.*\$50/);
    expect(res.content).toMatch(/Currency:.*USD/);
  });

  it("every creative variant is rendered with headline, primary text, CTA, and asset URL", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        creatives: [
          {
            id: "c1",
            adPackageId: "pkg-meta",
            variantIndex: 1,
            channel: "FACEBOOK",
            headline: "Headline A",
            primaryText: "Body A",
            description: "Desc A",
            cta: "Tour",
            primaryAssetId: "asset-1",
            additionalAssetIdsJson: [],
            rationale: "Why A",
          },
          {
            id: "c2",
            adPackageId: "pkg-meta",
            variantIndex: 2,
            channel: "INSTAGRAM",
            headline: "Headline B",
            primaryText: "Body B",
            description: null,
            cta: "Learn More",
            primaryAssetId: null,
            additionalAssetIdsJson: [],
            rationale: null,
          },
        ],
      }),
    };
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-meta", "auth0|u1", {
      format: "meta_launch_sheet",
    });

    // Both variants present.
    expect(res.content).toMatch(/### Variant 1 — FACEBOOK/);
    expect(res.content).toMatch(/### Variant 2 — INSTAGRAM/);

    // Headlines + bodies + CTAs survive.
    expect(res.content).toContain("Headline A");
    expect(res.content).toContain("Body A");
    expect(res.content).toContain("Headline B");
    expect(res.content).toContain("Body B");
    expect(res.content).toContain("Tour");
    expect(res.content).toContain("Learn More");

    // Variant 1 has asset → URL appears.
    expect(res.content).toContain("https://cdn.squadpitch.example.com/asset-1.jpg");
    // Variant 2 has no asset → the brief surfaces the "upload in Ads Manager" line.
    expect(res.content).toMatch(/upload the creative directly in Ads Manager/i);
  });
});

describe("meta_launch_sheet — HOUSING special-category visibility", () => {
  function housingFixture() {
    return {
      pkg: {
        id: "pkg-meta",
        clientId: CLIENT_ID,
        name: "508 King George listing",
        status: "READY",
        specialCategory: "HOUSING",
        exportsJson: [],
        objective: "LEADS",
        sourceType: "IDEA",
        sourceId: null,
        sourceIdea: "Brief",
        reviewedByUserId: "auth0|u1",
        reviewedAt: new Date(),
      },
      audience: {
        id: "a1",
        adPackageId: "pkg-meta",
        locationsJson: [{ kind: "city", value: "Cary, NC" }],
        ageMin: 18,
        ageMax: 65,
        gendersJson: ["all"],
        interestsJson: [],
        customAudienceHintsJson: [],
        languagesJson: ["en"],
        housingRestricted: true,
      },
    };
  }

  it("HOUSING package surfaces the Special Ad Category: HOUSING block prominently near the top", async () => {
    fixtures = { prisma: buildPrismaMock(housingFixture()) };
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-meta", "auth0|u1", {
      format: "meta_launch_sheet",
    });

    // Block appears BEFORE the Campaign section.
    const housingIdx = res.content.indexOf("Special Ad Category: HOUSING");
    const campaignIdx = res.content.indexOf("## Campaign");
    expect(housingIdx).toBeGreaterThan(-1);
    expect(campaignIdx).toBeGreaterThan(-1);
    expect(housingIdx).toBeLessThan(campaignIdx);

    // The 4 Meta-specific compliance directives are all present.
    expect(res.content).toMatch(/Set Special Ad Category to \*\*Housing\*\*/i);
    expect(res.content).toMatch(/Do \*\*not\*\* use ZIP-only/i);
    expect(res.content).toMatch(/Do \*\*not\*\* narrow targeting by age.*or by gender/i);
    expect(res.content).toMatch(/protected-class language/i);
  });

  it("non-HOUSING package does NOT include housing-only instructions", async () => {
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-meta", "auth0|u1", {
      format: "meta_launch_sheet",
    });
    expect(res.content).not.toMatch(/Special Ad Category: HOUSING/i);
    expect(res.content).not.toMatch(/ZIP-only/i);
    expect(res.content).not.toMatch(/protected-class language/i);
  });

  it("HOUSING setup checklist includes a final HOUSING-compliance re-verification step", async () => {
    fixtures = { prisma: buildPrismaMock(housingFixture()) };
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-meta", "auth0|u1", {
      format: "meta_launch_sheet",
    });
    expect(res.content).toMatch(/Re-verify HOUSING-compliance/i);
  });
});

describe("meta_launch_sheet — objective mapping", () => {
  const cases = [
    { objective: "TRAFFIC", expected: "Traffic", needsConfirm: false },
    { objective: "LEADS", expected: "Leads", needsConfirm: true },
    { objective: "AWARENESS", expected: "Awareness", needsConfirm: false },
    { objective: "ENGAGEMENT", expected: "Engagement", needsConfirm: false },
    { objective: "EVENT", expected: "Engagement (Event responses)", needsConfirm: true },
  ];
  for (const c of cases) {
    it(`SquadAds ${c.objective} → Meta '${c.expected}'${c.needsConfirm ? " + confirm-note" : ""}`, async () => {
      fixtures = {
        prisma: buildPrismaMock({
          pkg: {
            id: "pkg-meta",
            clientId: CLIENT_ID,
            name: "Test",
            status: "READY",
            specialCategory: "NONE",
            exportsJson: [],
            objective: c.objective,
            sourceType: "IDEA",
            sourceId: null,
            sourceIdea: "Brief",
          },
        }),
      };
      const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-meta", "auth0|u1", {
        format: "meta_launch_sheet",
      });
      // Objective wording appears in the Campaign block.
      expect(res.content).toMatch(
        new RegExp(`Objective \\(Meta\\):\\*\\*\\s*${c.expected.replace(/[()]/g, "\\$&")}`),
      );
      if (c.needsConfirm) {
        expect(res.content.toLowerCase()).toMatch(/confirm/);
      }
    });
  }
});
