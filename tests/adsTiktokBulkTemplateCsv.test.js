// Ads-06 — TikTok Ads bulk-template worksheet renderer.
//
// Covers:
//   - Header row + N variant rows.
//   - Asset URL column populated when the creative has a primary
//     asset; left blank with a "upload creative asset manually"
//     setup note when not.
//   - RFC 4180 escaping for commas / quotes / newlines.
//   - SquadAds objective → TikTok objective mapping (with confirm
//     notes for ambiguous mappings: LEADS, ENGAGEMENT, EVENT).
//   - HOUSING packages carry a compliance note in the Compliance
//     Notes column on every ad row.
//   - Response carries requiresPlatformTemplateReview=true so the
//     FE knows to render the "download TikTok's template first"
//     framing.
//   - Filename + MIME + extension.

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
        "pkg-tt",
        pkg ?? {
          id: "pkg-tt",
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
            channel: "TIKTOK",
            headline: "Visit our open house",
            primaryText: "Sunday 1–4 PM at 508 King George Court.",
            description: null,
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
          dailyBudgetCents: 7500,
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
              utmJson: { source: "tiktok", medium: "paid_social" },
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
        // Honor whatever asset IDs the creatives declare; return
        // matching rows with a URL so the renderer can populate the
        // Asset URL column.
        const ids = new Set((where?.id?.in ?? []).filter(Boolean));
        if (ids.has("asset-1")) {
          return [
            {
              id: "asset-1",
              url: "https://cdn.squadpitch.example.com/asset-1.mp4",
              thumbnailUrl: null,
              mimeType: "video/mp4",
              assetType: "video",
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

function parseCsv(content) {
  const rows = [];
  let row = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (inQuotes) {
      if (ch === '"') {
        if (content[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      continue;
    }
    if (ch === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (ch === "\n") {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = "";
      continue;
    }
    cell += ch;
  }
  if (cell !== "" || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

function cellByColumn(rows, rowIndex, columnName) {
  return rows[rowIndex][rows[0].indexOf(columnName)];
}

describe("tiktok_bulk_template_csv — metadata + framing", () => {
  it("returns text/csv + .csv + tiktok platform + isDirectImport false", async () => {
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-tt", "auth0|u1", {
      format: "tiktok_bulk_template_csv",
    });
    expect(res.mimeType).toBe("text/csv; charset=utf-8");
    expect(res.extension).toBe("csv");
    expect(res.platform).toBe("tiktok");
    expect(res.isDirectImport).toBe(false);
    expect(res.importStyle).toBe("tiktok_bulk_template_csv");
    expect(res.filename.endsWith(".tiktok-bulk.csv")).toBe(true);
  });

  it("response flags requiresPlatformTemplateReview so the FE renders honest framing", async () => {
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-tt", "auth0|u1", {
      format: "tiktok_bulk_template_csv",
    });
    expect(res.requiresPlatformTemplateReview).toBe(true);
    expect(res.platformNotes.toLowerCase()).toMatch(/template/);
    expect(res.platformNotes.toLowerCase()).toMatch(/ads manager/);
  });
});

describe("tiktok_bulk_template_csv — row structure + asset handling", () => {
  it("emits header + one ad row per variant; populates Asset URL when creative has a primary asset", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        creatives: [
          {
            id: "c1",
            adPackageId: "pkg-tt",
            variantIndex: 1,
            channel: "TIKTOK",
            headline: "Title 1",
            primaryText: "Body 1",
            description: null,
            cta: "Tour",
            primaryAssetId: "asset-1",
            additionalAssetIdsJson: [],
            rationale: "R1",
          },
          {
            id: "c2",
            adPackageId: "pkg-tt",
            variantIndex: 2,
            channel: "TIKTOK",
            headline: "Title 2",
            primaryText: "Body 2",
            description: null,
            cta: "Learn",
            primaryAssetId: null,
            additionalAssetIdsJson: [],
            rationale: null,
          },
        ],
      }),
    };
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-tt", "auth0|u1", {
      format: "tiktok_bulk_template_csv",
    });
    const rows = parseCsv(res.content);

    // 1 header + 2 ad rows.
    expect(rows.length).toBe(3);
    expect(rows[0]).toContain("Campaign Name");
    expect(rows[0]).toContain("Asset URL");

    expect(cellByColumn(rows, 1, "Ad Text")).toBe("Body 1");
    expect(cellByColumn(rows, 1, "Asset URL")).toBe(
      "https://cdn.squadpitch.example.com/asset-1.mp4",
    );

    expect(cellByColumn(rows, 2, "Ad Text")).toBe("Body 2");
    // Variant 2 has no asset — the cell is blank and the setup
    // notes column flags it (TikTok requires uploading the actual
    // file to its asset library; URLs alone aren't enough).
    expect(cellByColumn(rows, 2, "Asset URL")).toBe("");
    const setupNotes = cellByColumn(rows, 2, "Manual Setup Notes").toLowerCase();
    expect(setupNotes).toContain("asset");
    expect(setupNotes).toContain("upload");
  });

  it("Landing Page URL is the resolved destination with UTMs", async () => {
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-tt", "auth0|u1", {
      format: "tiktok_bulk_template_csv",
    });
    const rows = parseCsv(res.content);
    const url = cellByColumn(rows, 1, "Landing Page URL");
    expect(url).toMatch(/^https:\/\/smithrealty\.example\.com\/open-house\?/);
    expect(url).toContain("utm_source=tiktok");
    expect(url).toContain("utm_medium=paid_social");
  });
});

describe("tiktok_bulk_template_csv — RFC 4180 escaping", () => {
  it("escapes embedded quotes in Ad Text by doubling them", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        creatives: [
          {
            id: "c1",
            adPackageId: "pkg-tt",
            variantIndex: 1,
            channel: "TIKTOK",
            headline: "Headline",
            // TikTok renderer maps primaryText → "Ad Text" column,
            // so put the special-character test data there.
            primaryText: `She said "hello"`,
            description: null,
            cta: null,
            primaryAssetId: null,
            additionalAssetIdsJson: [],
            rationale: null,
          },
        ],
      }),
    };
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-tt", "auth0|u1", {
      format: "tiktok_bulk_template_csv",
    });
    // RFC 4180: each `"` inside a quoted cell becomes `""`. So
    // `"hello"` shows up as `""hello""` in the bytes, wrapped in
    // the cell's own quote pair.
    expect(res.content).toContain(`""hello""`);
    const rows = parseCsv(res.content);
    expect(cellByColumn(rows, 1, "Ad Text")).toBe(`She said "hello"`);
  });

  it("preserves commas inside cells without breaking column count", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        creatives: [
          {
            id: "c1",
            adPackageId: "pkg-tt",
            variantIndex: 1,
            channel: "TIKTOK",
            headline: "Big, bright, sunny",
            primaryText: "Roomy, walkable, charming.",
            description: null,
            cta: null,
            primaryAssetId: null,
            additionalAssetIdsJson: [],
            rationale: null,
          },
        ],
      }),
    };
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-tt", "auth0|u1", {
      format: "tiktok_bulk_template_csv",
    });
    const rows = parseCsv(res.content);
    const cols = rows[0].length;
    for (const r of rows) expect(r.length).toBe(cols);
    expect(cellByColumn(rows, 1, "Ad Text")).toBe("Roomy, walkable, charming.");
  });

  it("preserves embedded newlines inside cells", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        creatives: [
          {
            id: "c1",
            adPackageId: "pkg-tt",
            variantIndex: 1,
            channel: "TIKTOK",
            headline: "Headline",
            primaryText: "Line one\nLine two",
            description: null,
            cta: null,
            primaryAssetId: null,
            additionalAssetIdsJson: [],
            rationale: null,
          },
        ],
      }),
    };
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-tt", "auth0|u1", {
      format: "tiktok_bulk_template_csv",
    });
    const rows = parseCsv(res.content);
    expect(cellByColumn(rows, 1, "Ad Text")).toBe("Line one\nLine two");
    expect(rows.length).toBe(2); // header + 1 ad row
  });
});

describe("tiktok_bulk_template_csv — objective mapping", () => {
  const cases = [
    { objective: "TRAFFIC", expected: "Traffic", needsConfirm: false },
    { objective: "LEADS", expected: "Lead Generation", needsConfirm: true },
    { objective: "AWARENESS", expected: "Reach", needsConfirm: false },
    { objective: "ENGAGEMENT", expected: "Community Interaction", needsConfirm: true },
    { objective: "EVENT", expected: "Traffic", needsConfirm: true },
  ];
  for (const c of cases) {
    it(`SquadAds ${c.objective} → TikTok '${c.expected}'${c.needsConfirm ? " + confirm note" : ""}`, async () => {
      fixtures = {
        prisma: buildPrismaMock({
          pkg: {
            id: "pkg-tt",
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
      const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-tt", "auth0|u1", {
        format: "tiktok_bulk_template_csv",
      });
      const rows = parseCsv(res.content);
      expect(cellByColumn(rows, 1, "Campaign Objective")).toBe(c.expected);
      if (c.needsConfirm) {
        expect(cellByColumn(rows, 1, "Manual Setup Notes").toLowerCase()).toMatch(/confirm/i);
      }
    });
  }
});

describe("tiktok_bulk_template_csv — HOUSING compliance note", () => {
  it("HOUSING packages get a compliance note in the Compliance Notes column on each row", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        pkg: {
          id: "pkg-tt",
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
          adPackageId: "pkg-tt",
          locationsJson: [{ kind: "city", value: "Cary, NC" }],
          ageMin: 18,
          ageMax: 65,
          gendersJson: ["all"],
          interestsJson: [],
          customAudienceHintsJson: [],
          languagesJson: ["en"],
          housingRestricted: true,
        },
      }),
    };
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-tt", "auth0|u1", {
      format: "tiktok_bulk_template_csv",
    });
    const rows = parseCsv(res.content);
    expect(cellByColumn(rows, 1, "Compliance Notes")).toMatch(/Housing/i);
  });
});

describe("tiktok_bulk_template_csv — field length warnings", () => {
  it("FIELD_TRUNCATED warning when Ad Text > 100 chars (silent loss never acceptable)", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        creatives: [
          {
            id: "c1",
            adPackageId: "pkg-tt",
            variantIndex: 1,
            channel: "TIKTOK",
            headline: "Headline",
            primaryText: "x".repeat(300),
            description: null,
            cta: null,
            primaryAssetId: null,
            additionalAssetIdsJson: [],
            rationale: null,
          },
        ],
      }),
    };
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-tt", "auth0|u1", {
      format: "tiktok_bulk_template_csv",
    });
    const warn = res.warnings.find(
      (w) => w.code === "FIELD_TRUNCATED" && w.field === "Ad Text",
    );
    expect(warn).toBeTruthy();
    expect(warn.limit).toBe(100);
    expect(warn.variantIndex).toBe(1);

    const rows = parseCsv(res.content);
    expect(cellByColumn(rows, 1, "Ad Text").length).toBeLessThanOrEqual(100);
    expect(cellByColumn(rows, 1, "Ad Text").endsWith("…")).toBe(true);
  });

  it("no warnings when every field fits", async () => {
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-tt", "auth0|u1", {
      format: "tiktok_bulk_template_csv",
    });
    expect(res.warnings).toEqual([]);
  });
});
