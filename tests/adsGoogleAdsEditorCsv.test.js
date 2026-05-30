// Ads-05 — Google Ads Editor CSV renderer.
//
// Covers the rules a paid-media specialist will rely on when
// importing the bytes inside Google Ads Editor:
//   - RFC 4180-style escaping for commas, double quotes, newlines.
//   - One Campaign row + one Ad group row + N Ad rows.
//   - Final URL resolves to the public URL with UTMs applied.
//   - Field-length warnings (machine-readable) when SquadAds copy
//     exceeds Google's RSA limits — never silent truncation.
//   - HOUSING packages carry a compliance hint in the Notes column
//     so the user sees it inside Editor's grid view.
//   - MIME = text/csv; charset=utf-8, extension = .csv.
//   - Missing destination → export fails through the readiness gate.

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

function buildPrismaMock({ pkg, creatives, audience, budget, destination, specialCategory = "NONE" } = {}) {
  const state = {
    adPackages: new Map([
      [
        "pkg-g1",
        pkg ?? {
          id: "pkg-g1",
          clientId: CLIENT_ID,
          name: "Spring open house",
          status: "READY",
          specialCategory,
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
            channel: null,
            headline: "Visit our open house",
            primaryText: "Sunday 1–4 PM at 508 King George Court.",
            description: "Tour the home with our agent.",
            cta: "Schedule Tour",
            primaryAssetId: null,
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
          interestsJson: [],
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
              utmJson: { source: "google", medium: "cpc", campaign: "spring" },
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
    mediaAsset: { findMany: vi.fn(async () => []) },
    client: { findUnique: vi.fn(async () => ({ slug: "smith-realty" })) },
  };
}

beforeEach(() => {
  fixtures = { prisma: buildPrismaMock() };
});

function parseCsv(content) {
  // Minimal RFC 4180 reader. Sufficient for our renderer output:
  // every cell is fully quoted (csvEscape always wraps in quotes),
  // so the parser only needs to handle quote-doubling.
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
  const headerIndex = rows[0].indexOf(columnName);
  return rows[rowIndex][headerIndex];
}

describe("google_ads_editor_csv — MIME / extension / metadata", () => {
  it("returns text/csv and a .csv filename", async () => {
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-g1", "auth0|u1", {
      format: "google_ads_editor_csv",
    });
    expect(res.mimeType).toBe("text/csv; charset=utf-8");
    expect(res.extension).toBe("csv");
    expect(res.filename.endsWith(".google-ads-editor.csv")).toBe(true);
    expect(res.platform).toBe("google");
    expect(res.isDirectImport).toBe(false);
    expect(res.importStyle).toBe("google_ads_editor_csv");
  });
});

describe("google_ads_editor_csv — row structure", () => {
  it("emits header + campaign row + ad-group row + one ad row per creative", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        creatives: [
          {
            id: "c1",
            adPackageId: "pkg-g1",
            variantIndex: 1,
            channel: null,
            headline: "Headline A",
            primaryText: "Body A",
            description: "Desc A",
            cta: "Tour Now",
            primaryAssetId: null,
            additionalAssetIdsJson: [],
            rationale: "Why A",
          },
          {
            id: "c2",
            adPackageId: "pkg-g1",
            variantIndex: 2,
            channel: null,
            headline: "Headline B",
            primaryText: "Body B",
            description: "Desc B",
            cta: "Learn More",
            primaryAssetId: null,
            additionalAssetIdsJson: [],
            rationale: "Why B",
          },
        ],
      }),
    };
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-g1", "auth0|u1", {
      format: "google_ads_editor_csv",
    });
    const rows = parseCsv(res.content);

    // 1 header + 1 campaign + 1 ad group + 2 ad rows.
    expect(rows.length).toBe(5);

    // Campaign row has Campaign + Campaign type + Budget filled,
    // but no Ad group / Headline cells.
    expect(cellByColumn(rows, 1, "Campaign")).toBe("Spring open house");
    expect(cellByColumn(rows, 1, "Campaign type")).toBe("Search");
    expect(cellByColumn(rows, 1, "Campaign status")).toBe("Paused");
    expect(cellByColumn(rows, 1, "Budget")).toBe("50.00");
    expect(cellByColumn(rows, 1, "Budget type")).toBe("Daily");
    expect(cellByColumn(rows, 1, "Ad group")).toBe("");
    expect(cellByColumn(rows, 1, "Headline 1")).toBe("");

    // Ad group row has Ad group + status, no ad fields.
    expect(cellByColumn(rows, 2, "Ad group")).toMatch(/variants$/);
    expect(cellByColumn(rows, 2, "Ad group status")).toBe("Paused");
    expect(cellByColumn(rows, 2, "Headline 1")).toBe("");

    // Ad rows: Campaign + Ad group + Headline 1/2/3 + Description 1/2 + Final URL.
    expect(cellByColumn(rows, 3, "Headline 1")).toBe("Headline A");
    expect(cellByColumn(rows, 3, "Description 1")).toBe("Body A");
    expect(cellByColumn(rows, 4, "Headline 1")).toBe("Headline B");
    expect(cellByColumn(rows, 4, "Description 1")).toBe("Body B");
  });

  it("Final URL is the resolved destination with UTMs applied", async () => {
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-g1", "auth0|u1", {
      format: "google_ads_editor_csv",
    });
    const rows = parseCsv(res.content);
    const finalUrl = cellByColumn(rows, 3, "Final URL");
    expect(finalUrl).toMatch(/^https:\/\/smithrealty\.example\.com\/open-house\?/);
    expect(finalUrl).toContain("utm_source=google");
    expect(finalUrl).toContain("utm_medium=cpc");
    expect(finalUrl).toContain("utm_campaign=spring");
  });
});

describe("google_ads_editor_csv — RFC 4180 escaping", () => {
  it("escapes embedded double quotes by doubling them", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        creatives: [
          {
            id: "c1",
            adPackageId: "pkg-g1",
            variantIndex: 1,
            channel: null,
            headline: `She said "hello"`,
            primaryText: "Body",
            description: null,
            cta: "Visit",
            primaryAssetId: null,
            additionalAssetIdsJson: [],
            rationale: null,
          },
        ],
      }),
    };
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-g1", "auth0|u1", {
      format: "google_ads_editor_csv",
    });
    // Doubled quotes survive the parser as a single literal quote.
    const rows = parseCsv(res.content);
    expect(cellByColumn(rows, 3, "Headline 1")).toBe(`She said "hello"`);
    // And the on-the-wire bytes really do contain the doubled form.
    expect(res.content).toContain(`"She said ""hello"""`);
  });

  it("preserves commas inside cells without breaking the column count", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        creatives: [
          {
            id: "c1",
            adPackageId: "pkg-g1",
            variantIndex: 1,
            channel: null,
            headline: "Big, bright, sunny",
            primaryText: "Body",
            description: null,
            cta: null,
            primaryAssetId: null,
            additionalAssetIdsJson: [],
            rationale: null,
          },
        ],
      }),
    };
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-g1", "auth0|u1", {
      format: "google_ads_editor_csv",
    });
    const rows = parseCsv(res.content);
    // Every row has the same column count as the header.
    const cols = rows[0].length;
    for (const r of rows) expect(r.length).toBe(cols);
    expect(cellByColumn(rows, 3, "Headline 1")).toBe("Big, bright, sunny");
  });

  it("preserves embedded newlines inside cells", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        creatives: [
          {
            id: "c1",
            adPackageId: "pkg-g1",
            variantIndex: 1,
            channel: null,
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
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-g1", "auth0|u1", {
      format: "google_ads_editor_csv",
    });
    const rows = parseCsv(res.content);
    expect(cellByColumn(rows, 3, "Description 1")).toBe("Line one\nLine two");
    // Still 4 rows: header + campaign + ad group + 1 ad. The embedded
    // newline inside a quoted cell must NOT add an extra row.
    expect(rows.length).toBe(4);
  });
});

describe("google_ads_editor_csv — field length warnings", () => {
  it("truncates headline > 30 chars and returns a FIELD_TRUNCATED warning", async () => {
    const tooLong = "x".repeat(60);
    fixtures = {
      prisma: buildPrismaMock({
        creatives: [
          {
            id: "c1",
            adPackageId: "pkg-g1",
            variantIndex: 1,
            channel: null,
            headline: tooLong,
            primaryText: "Body",
            description: null,
            cta: null,
            primaryAssetId: null,
            additionalAssetIdsJson: [],
            rationale: null,
          },
        ],
      }),
    };
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-g1", "auth0|u1", {
      format: "google_ads_editor_csv",
    });
    expect(res.warnings.length).toBeGreaterThan(0);
    const headlineWarn = res.warnings.find(
      (w) => w.code === "FIELD_TRUNCATED" && w.field === "Headline 1",
    );
    expect(headlineWarn).toBeTruthy();
    expect(headlineWarn.variantIndex).toBe(1);
    expect(headlineWarn.limit).toBe(30);

    const rows = parseCsv(res.content);
    expect(cellByColumn(rows, 3, "Headline 1").length).toBeLessThanOrEqual(30);
    expect(cellByColumn(rows, 3, "Headline 1").endsWith("…")).toBe(true);
  });

  it("truncates description > 90 chars with a warning", async () => {
    const tooLong = "y".repeat(200);
    fixtures = {
      prisma: buildPrismaMock({
        creatives: [
          {
            id: "c1",
            adPackageId: "pkg-g1",
            variantIndex: 1,
            channel: null,
            headline: "Headline",
            primaryText: tooLong,
            description: null,
            cta: null,
            primaryAssetId: null,
            additionalAssetIdsJson: [],
            rationale: null,
          },
        ],
      }),
    };
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-g1", "auth0|u1", {
      format: "google_ads_editor_csv",
    });
    const descWarn = res.warnings.find(
      (w) => w.code === "FIELD_TRUNCATED" && w.field === "Description 1",
    );
    expect(descWarn).toBeTruthy();
    expect(descWarn.limit).toBe(90);
    const rows = parseCsv(res.content);
    expect(cellByColumn(rows, 3, "Description 1").length).toBeLessThanOrEqual(90);
  });

  it("emits no warnings when every field fits", async () => {
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-g1", "auth0|u1", {
      format: "google_ads_editor_csv",
    });
    expect(res.warnings).toEqual([]);
  });
});

describe("google_ads_editor_csv — housing compliance hint", () => {
  it("HOUSING packages get a compliance hint in the Notes column on each ad row", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        specialCategory: "HOUSING",
        pkg: {
          id: "pkg-g1",
          clientId: CLIENT_ID,
          name: "508 King George listing",
          status: "READY",
          specialCategory: "HOUSING",
          exportsJson: [],
          objective: "LEADS",
          sourceType: "IDEA",
          sourceId: null,
          sourceIdea: "Brief",
        },
        audience: {
          id: "a1",
          adPackageId: "pkg-g1",
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
    // HOUSING requires reviewedAt + acknowledgeReview to pass the
    // readiness validator. Patch the package fixture inline:
    const pkg = fixtures.prisma.state.adPackages.get("pkg-g1");
    pkg.reviewedByUserId = "auth0|u1";
    pkg.reviewedAt = new Date();

    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-g1", "auth0|u1", {
      format: "google_ads_editor_csv",
    });
    const rows = parseCsv(res.content);

    // Notes column on the campaign row AND the ad row mentions housing.
    expect(cellByColumn(rows, 1, "Notes")).toMatch(/Housing/i);
    expect(cellByColumn(rows, 3, "Notes")).toMatch(/Housing/i);
  });
});

describe("google_ads_editor_csv — guarded by export readiness", () => {
  it("cannot export when destination is missing (validator blocks before renderer runs)", async () => {
    fixtures = {
      prisma: buildPrismaMock({ destination: null }),
    };
    await expect(
      exportSvc.exportPackage(CLIENT_ID, "pkg-g1", "auth0|u1", {
        format: "google_ads_editor_csv",
      }),
    ).rejects.toMatchObject({
      code: "READY_PRECONDITIONS_FAILED",
    });
  });
});
