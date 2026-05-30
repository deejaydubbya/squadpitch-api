// Ads-08 — LinkedIn + Pinterest launch sheet renderers.
//
// Mirrors the Meta launch sheet test shape (ads-07). For each
// platform:
//   - MIME = text/markdown, extension = .md, isDirectImport=false.
//   - Required sections present (Campaign, Destination, Audience,
//     Budget, Creatives/Pins, SETUP CHECKLIST).
//   - HOUSING packages get a Fair-Housing compliance block at the
//     top with platform-appropriate wording.
//   - Non-HOUSING packages do NOT show housing-only instructions.
//   - Every creative variant is rendered with the platform's
//     primary copy/title fields.
//   - Destination URL + budget appear.
//   - Objective mapping (SquadAds → platform) with confirm-notes
//     for ambiguous cases.
//
// Plus Pinterest-specific: the "URLs are reference only; upload
// the file to Pinterest" guidance must appear in the brief.

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

const CLIENT_ID = "client-1";

function buildPrismaMock({ pkg, creatives, audience, budget, destination } = {}) {
  const state = {
    adPackages: new Map([
      [
        "pkg-l",
        pkg ?? {
          id: "pkg-l",
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
            channel: "LINKEDIN",
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
          interestsJson: ["home buying", "real estate"],
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
              utmJson: { source: "social", medium: "paid_social" },
              pixelIdsJson: [],
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

// Parameterized over both platforms — exercises the shared shape.
const PLATFORMS = [
  {
    format: "linkedin_launch_sheet",
    platform: "linkedin",
    filenameSuffix: ".linkedin-launch-sheet.md",
    headerRe: /^# LinkedIn launch sheet/,
    creativesHeader: /## Creatives/,
    importStyle: "linkedin_launch_sheet",
    labelKeywords: [/LinkedIn/i],
    notesRequire: /Campaign Manager/i,
    housingExpect: {
      sectionTitle: /Housing-restricted creative \(Fair Housing Act\)/i,
      zipBlock: /Do \*\*not\*\* use ZIP-only/i,
    },
    objectiveCases: [
      { objective: "AWARENESS", expected: "Brand awareness", needsConfirm: false },
      { objective: "TRAFFIC", expected: "Website visits", needsConfirm: false },
      { objective: "LEADS", expected: "Lead generation", needsConfirm: true },
      { objective: "ENGAGEMENT", expected: "Engagement", needsConfirm: false },
      { objective: "EVENT", expected: "Event registrations", needsConfirm: true },
    ],
  },
  {
    format: "pinterest_launch_sheet",
    platform: "pinterest",
    filenameSuffix: ".pinterest-launch-sheet.md",
    headerRe: /^# Pinterest launch sheet/,
    creativesHeader: /## Pins/,
    importStyle: "pinterest_launch_sheet",
    labelKeywords: [/Pinterest/i],
    notesRequire: /Ads Manager/i,
    housingExpect: {
      sectionTitle: /Housing-restricted creative \(Fair Housing Act\)/i,
      zipBlock: /Do \*\*not\*\* use ZIP-only/i,
    },
    objectiveCases: [
      { objective: "AWARENESS", expected: "Brand awareness", needsConfirm: false },
      { objective: "TRAFFIC", expected: "Consideration (Outbound clicks)", needsConfirm: false },
      { objective: "LEADS", expected: "Conversions", needsConfirm: true },
      { objective: "ENGAGEMENT", expected: "Engagement", needsConfirm: false },
      { objective: "EVENT", expected: "Consideration (Outbound clicks)", needsConfirm: true },
    ],
  },
];

for (const p of PLATFORMS) {
  describe(`${p.format} — metadata + framing`, () => {
    it(`returns text/markdown + .md + ${p.platform} platform; isDirectImport=false`, async () => {
      const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-l", "auth0|u1", {
        format: p.format,
      });
      expect(res.mimeType).toBe("text/markdown; charset=utf-8");
      expect(res.extension).toBe("md");
      expect(res.platform).toBe(p.platform);
      expect(res.isDirectImport).toBe(false);
      expect(res.importStyle).toBe(p.importStyle);
      expect(res.filename.endsWith(p.filenameSuffix)).toBe(true);
      for (const re of p.labelKeywords) expect(res.label).toMatch(re);
      expect(res.platformNotes).toMatch(p.notesRequire);
    });
  });

  describe(`${p.format} — required sections + content`, () => {
    it("renders header, Campaign, Destination, Audience, Budget, Creatives/Pins, SETUP CHECKLIST", async () => {
      const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-l", "auth0|u1", {
        format: p.format,
      });
      expect(res.content).toMatch(p.headerRe);
      expect(res.content).toMatch(/## Campaign/);
      expect(res.content).toMatch(/## Destination/);
      expect(res.content).toMatch(/## Audience/);
      expect(res.content).toMatch(/## Budget/);
      expect(res.content).toMatch(p.creativesHeader);
      expect(res.content).toMatch(/## SETUP CHECKLIST/);
    });

    it("destination URL with UTMs and budget appear", async () => {
      const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-l", "auth0|u1", {
        format: p.format,
      });
      expect(res.content).toMatch(/https:\/\/smithrealty\.example\.com\/open-house\?[^>]*utm_source=social/);
      expect(res.content).toMatch(/Daily budget:.*\$50/);
      expect(res.content).toMatch(/Currency:.*USD/);
    });

    it("every creative variant is rendered with copy + asset link or upload hint", async () => {
      fixtures = {
        prisma: buildPrismaMock({
          creatives: [
            {
              id: "c1",
              adPackageId: "pkg-l",
              variantIndex: 1,
              channel: p.platform === "linkedin" ? "LINKEDIN" : "PINTEREST",
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
              adPackageId: "pkg-l",
              variantIndex: 2,
              channel: p.platform === "linkedin" ? "LINKEDIN" : "PINTEREST",
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
      const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-l", "auth0|u1", {
        format: p.format,
      });
      // Both variants present (LinkedIn = "Variant N", Pinterest = "Pin N")
      const variantWord = p.platform === "linkedin" ? "Variant" : "Pin";
      expect(res.content).toMatch(new RegExp(`### ${variantWord} 1`));
      expect(res.content).toMatch(new RegExp(`### ${variantWord} 2`));
      // Headlines + bodies survive.
      expect(res.content).toContain("Headline A");
      expect(res.content).toContain("Body A");
      expect(res.content).toContain("Headline B");
      expect(res.content).toContain("Body B");
      // Variant 1 has asset → URL appears.
      expect(res.content).toContain("https://cdn.squadpitch.example.com/asset-1.jpg");
      // Variant 2 has no asset → upload-in-platform hint surfaces.
      expect(res.content.toLowerCase()).toMatch(/upload/i);
    });
  });

  describe(`${p.format} — HOUSING compliance visibility`, () => {
    function housingFixture() {
      return {
        pkg: {
          id: "pkg-l",
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
          adPackageId: "pkg-l",
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

    it("HOUSING package surfaces a Fair Housing block above the Campaign section", async () => {
      fixtures = { prisma: buildPrismaMock(housingFixture()) };
      const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-l", "auth0|u1", {
        format: p.format,
      });
      expect(res.content).toMatch(p.housingExpect.sectionTitle);
      expect(res.content).toMatch(p.housingExpect.zipBlock);
      expect(res.content).toMatch(/Fair Housing Act/i);

      const housingIdx = res.content.search(p.housingExpect.sectionTitle);
      const campaignIdx = res.content.indexOf("## Campaign");
      expect(housingIdx).toBeGreaterThan(-1);
      expect(campaignIdx).toBeGreaterThan(-1);
      expect(housingIdx).toBeLessThan(campaignIdx);
    });

    it("non-HOUSING package does NOT show Fair Housing instructions", async () => {
      const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-l", "auth0|u1", {
        format: p.format,
      });
      expect(res.content).not.toMatch(/Fair Housing Act/i);
      expect(res.content).not.toMatch(/ZIP-only/i);
    });
  });

  describe(`${p.format} — objective mapping`, () => {
    for (const c of p.objectiveCases) {
      it(`SquadAds ${c.objective} → ${p.platform} '${c.expected}'${c.needsConfirm ? " + confirm note" : ""}`, async () => {
        fixtures = {
          prisma: buildPrismaMock({
            pkg: {
              id: "pkg-l",
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
        const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-l", "auth0|u1", {
          format: p.format,
        });
        const platformLabel = p.platform === "linkedin" ? "LinkedIn" : "Pinterest";
        expect(res.content).toMatch(
          new RegExp(`Objective \\(${platformLabel}\\):\\*\\*\\s*${c.expected.replace(/[()]/g, "\\$&")}`),
        );
        if (c.needsConfirm) {
          expect(res.content.toLowerCase()).toMatch(/confirm/i);
        }
      });
    }
  });
}

// Pinterest-specific: the "upload the actual file to Pinterest" guidance
// must appear in the brief. Pinterest doesn't accept URL-only Pin creative.
describe("pinterest_launch_sheet — asset upload guidance", () => {
  it("brief includes the 'asset URLs are reference only; upload to Pinterest' callout", async () => {
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-l", "auth0|u1", {
      format: "pinterest_launch_sheet",
    });
    expect(res.content.toLowerCase()).toContain("asset urls below are reference only");
    expect(res.content.toLowerCase()).toMatch(/upload.*pinterest/);
  });
});
