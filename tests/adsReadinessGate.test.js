// Ads-02 — production-grade READY/export gate.
//
// Pins:
//   - validatePackageReady runs the full structural + compliance
//     contract: creative content, budget positive + currency,
//     destination valid (incl. SITE_PAGE published + same client),
//     audience locations non-empty + age sane.
//   - HOUSING strict gate: clamps age 18–65, requires
//     genders=['all'], rejects postal/ZIP targeting, rejects narrow
//     custom-audience hints, requires housingRestricted=true.
//   - Copy linter blocks risky phrases (Fair Housing) per creative
//     field with COMPLIANCE_COPY_REVIEW_FAILED + findings shape.
//   - exportPackage re-runs the validator (defense in depth) and
//     translates the typed errors into ExportError.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { lintCreativeCopy, HOUSING_BLOCKED_PHRASES } from "../domains/ads/ads.compliance.js";

let fixtures;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return fixtures.prisma;
  },
}));

vi.mock("../domains/studio/generation/clientOrchestrator.js", () => ({
  loadClientGenerationContext: vi.fn(async () => ({ client: {}, brand: null, voice: null })),
}));
vi.mock("../domains/studio/generation/openai.provider.js", () => ({
  generateStructuredContent: vi.fn(),
}));
vi.mock("../domains/billing/aiUsageTracking.service.js", () => ({
  trackAiUsage: vi.fn(),
}));

const service = await import("../domains/ads/ads.service.js");
const exportSvc = await import("../domains/ads/ads.export.service.js");

const CLIENT_A = "client-A";
const CLIENT_B = "client-B";

function buildPrismaMock({ pages = [] } = {}) {
  const sitePages = new Map(pages);
  return {
    sitePage: {
      findFirst: vi.fn(async ({ where }) => {
        const row = sitePages.get(where.id);
        if (!row) return null;
        if (where.clientId && row.clientId !== where.clientId) return null;
        return row;
      }),
    },
    adPackage: {
      findFirst: vi.fn(),
      update: vi.fn(async ({ data }) => ({ ...data })),
    },
  };
}

beforeEach(() => {
  fixtures = { prisma: buildPrismaMock() };
});

function fullPkg(overrides = {}) {
  return {
    id: "pkg-1",
    clientId: CLIENT_A,
    status: "DRAFT",
    specialCategory: "NONE",
    reviewedByUserId: null,
    creatives: [
      { variantIndex: 0, headline: "Discover your next home", primaryText: "Lovely place.", cta: "Learn more" },
    ],
    audience: {
      locationsJson: [{ kind: "country", value: "US" }],
      ageMin: 25,
      ageMax: 55,
      gendersJson: ["all"],
      customAudienceHintsJson: [],
      housingRestricted: false,
    },
    budget: {
      dailyBudgetCents: 1000,
      totalBudgetCents: 0,
      currency: "USD",
      durationDays: 7,
    },
    destination: { kind: "EXTERNAL_URL", externalUrl: "https://example.com" },
    ...overrides,
  };
}

describe("validatePackageReady — creative content", () => {
  it("rejects when creative headline is empty", async () => {
    const pkg = fullPkg({
      creatives: [{ variantIndex: 0, headline: "   ", primaryText: "ok" }],
    });
    await expect(service.validatePackageReady(pkg)).rejects.toMatchObject({
      code: "READY_PRECONDITIONS_FAILED",
      missing: expect.arrayContaining([expect.stringContaining("needs a headline")]),
    });
  });

  it("rejects when creative primary text is whitespace-only", async () => {
    const pkg = fullPkg({
      creatives: [{ variantIndex: 0, headline: "Hi", primaryText: "  " }],
    });
    await expect(service.validatePackageReady(pkg)).rejects.toMatchObject({
      code: "READY_PRECONDITIONS_FAILED",
    });
  });

  it("rejects when there are zero creatives", async () => {
    const pkg = fullPkg({ creatives: [] });
    await expect(service.validatePackageReady(pkg)).rejects.toMatchObject({
      code: "READY_PRECONDITIONS_FAILED",
      missing: expect.arrayContaining(["at least one creative"]),
    });
  });
});

describe("validatePackageReady — budget", () => {
  it("rejects when budget has neither daily nor total > 0", async () => {
    const pkg = fullPkg({
      budget: { dailyBudgetCents: 0, totalBudgetCents: 0, currency: "USD" },
    });
    await expect(service.validatePackageReady(pkg)).rejects.toMatchObject({
      code: "READY_PRECONDITIONS_FAILED",
    });
  });

  it("rejects when currency is missing", async () => {
    const pkg = fullPkg({ budget: { dailyBudgetCents: 1000, currency: null } });
    await expect(service.validatePackageReady(pkg)).rejects.toMatchObject({
      code: "READY_PRECONDITIONS_FAILED",
    });
  });

  it("rejects when durationDays is 0", async () => {
    const pkg = fullPkg({ budget: { dailyBudgetCents: 1000, currency: "USD", durationDays: 0 } });
    await expect(service.validatePackageReady(pkg)).rejects.toMatchObject({
      code: "READY_PRECONDITIONS_FAILED",
    });
  });
});

describe("validatePackageReady — destination", () => {
  it("rejects EXTERNAL_URL with empty URL", async () => {
    const pkg = fullPkg({ destination: { kind: "EXTERNAL_URL", externalUrl: "  " } });
    await expect(service.validatePackageReady(pkg)).rejects.toMatchObject({
      code: "READY_PRECONDITIONS_FAILED",
    });
  });

  it("rejects EXTERNAL_URL with non-http(s) scheme", async () => {
    const pkg = fullPkg({ destination: { kind: "EXTERNAL_URL", externalUrl: "javascript:alert(1)" } });
    await expect(service.validatePackageReady(pkg)).rejects.toMatchObject({
      code: "READY_PRECONDITIONS_FAILED",
    });
  });

  it("rejects SITE_PAGE when the page is DRAFT (not PUBLISHED)", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        pages: [["page-1", { id: "page-1", clientId: CLIENT_A, status: "DRAFT" }]],
      }),
    };
    const pkg = fullPkg({ destination: { kind: "SITE_PAGE", sitePageId: "page-1" } });
    await expect(service.validatePackageReady(pkg)).rejects.toMatchObject({
      code: "READY_PRECONDITIONS_FAILED",
      missing: expect.arrayContaining([expect.stringContaining("must be PUBLISHED")]),
    });
  });

  it("rejects SITE_PAGE when page is from another workspace", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        pages: [["page-1", { id: "page-1", clientId: CLIENT_B, status: "PUBLISHED" }]],
      }),
    };
    const pkg = fullPkg({ destination: { kind: "SITE_PAGE", sitePageId: "page-1" } });
    await expect(service.validatePackageReady(pkg)).rejects.toMatchObject({
      code: "READY_PRECONDITIONS_FAILED",
      missing: expect.arrayContaining([expect.stringContaining("not found in this workspace")]),
    });
  });

  it("accepts SITE_PAGE when same-workspace + PUBLISHED", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        pages: [["page-1", { id: "page-1", clientId: CLIENT_A, status: "PUBLISHED" }]],
      }),
    };
    const pkg = fullPkg({ destination: { kind: "SITE_PAGE", sitePageId: "page-1" } });
    await expect(service.validatePackageReady(pkg)).resolves.toBeUndefined();
  });

  it("rejects SOCIAL_PROFILE with empty handle", async () => {
    const pkg = fullPkg({ destination: { kind: "SOCIAL_PROFILE", socialProfile: "" } });
    await expect(service.validatePackageReady(pkg)).rejects.toMatchObject({
      code: "READY_PRECONDITIONS_FAILED",
    });
  });
});

describe("validatePackageReady — audience", () => {
  it("rejects when locationsJson is empty", async () => {
    const pkg = fullPkg({ audience: { ...fullPkg().audience, locationsJson: [] } });
    await expect(service.validatePackageReady(pkg)).rejects.toMatchObject({
      code: "READY_PRECONDITIONS_FAILED",
      missing: expect.arrayContaining([expect.stringContaining("at least one location")]),
    });
  });

  it("rejects when ageMin > ageMax", async () => {
    const pkg = fullPkg({
      audience: { ...fullPkg().audience, ageMin: 60, ageMax: 40 },
    });
    await expect(service.validatePackageReady(pkg)).rejects.toMatchObject({
      code: "READY_PRECONDITIONS_FAILED",
    });
  });
});

describe("validatePackageReady — HOUSING strict gate", () => {
  function housingPkg(audienceOverrides = {}) {
    return fullPkg({
      specialCategory: "HOUSING",
      reviewedByUserId: "u1",
      audience: {
        locationsJson: [{ kind: "country", value: "US" }],
        ageMin: 18,
        ageMax: 65,
        gendersJson: ["all"],
        customAudienceHintsJson: [],
        housingRestricted: true,
        ...audienceOverrides,
      },
    });
  }

  it("accepts a clean HOUSING package", async () => {
    await expect(service.validatePackageReady(housingPkg())).resolves.toBeUndefined();
  });

  it("rejects HOUSING with postal/ZIP targeting", async () => {
    const pkg = housingPkg({
      locationsJson: [
        { kind: "country", value: "US" },
        { kind: "postal", value: "45066" },
      ],
    });
    await expect(service.validatePackageReady(pkg)).rejects.toMatchObject({
      code: "READY_PRECONDITIONS_FAILED",
      missing: expect.arrayContaining([expect.stringContaining("postal/ZIP")]),
    });
  });

  it("rejects HOUSING with zip key shape", async () => {
    const pkg = housingPkg({
      locationsJson: [{ zip: "45066" }],
    });
    await expect(service.validatePackageReady(pkg)).rejects.toMatchObject({
      code: "READY_PRECONDITIONS_FAILED",
    });
  });

  it("rejects HOUSING with narrow custom-audience hints", async () => {
    const pkg = housingPkg({
      customAudienceHintsJson: ["recent home buyers in zip 45066"],
    });
    await expect(service.validatePackageReady(pkg)).rejects.toMatchObject({
      code: "READY_PRECONDITIONS_FAILED",
      missing: expect.arrayContaining([expect.stringContaining("custom-audience hints")]),
    });
  });

  it("rejects HOUSING with non-['all'] genders", async () => {
    const pkg = housingPkg({ gendersJson: ["female"] });
    await expect(service.validatePackageReady(pkg)).rejects.toMatchObject({
      code: "READY_PRECONDITIONS_FAILED",
    });
  });

  it("rejects HOUSING with age min < 18", async () => {
    const pkg = housingPkg({ ageMin: 13 });
    await expect(service.validatePackageReady(pkg)).rejects.toMatchObject({
      code: "READY_PRECONDITIONS_FAILED",
    });
  });

  it("rejects HOUSING with housingRestricted=false", async () => {
    const pkg = housingPkg({ housingRestricted: false });
    await expect(service.validatePackageReady(pkg)).rejects.toMatchObject({
      code: "READY_PRECONDITIONS_FAILED",
    });
  });
});

describe("lintCreativeCopy — Fair Housing phrase blocker", () => {
  it("returns empty for non-HOUSING categories", () => {
    expect(
      lintCreativeCopy(
        [{ variantIndex: 0, headline: "perfect for families", primaryText: "ok" }],
        "NONE",
      ),
    ).toEqual([]);
  });

  it("catches familial-status phrases", () => {
    const findings = lintCreativeCopy(
      [{ variantIndex: 0, headline: "Perfect for families", primaryText: "ok" }],
      "HOUSING",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      variantIndex: 0,
      field: "headline",
      phrase: "perfect for families",
    });
  });

  it("catches age phrases like 'young professionals'", () => {
    const findings = lintCreativeCopy(
      [{ variantIndex: 1, headline: "Hi", primaryText: "Ideal for young professionals." }],
      "HOUSING",
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].phrase).toBe("young professionals");
    expect(findings[0].field).toBe("primaryText");
  });

  it("catches religious-preference signals", () => {
    const findings = lintCreativeCopy(
      [{ variantIndex: 0, headline: "Walk to church!", primaryText: "ok" }],
      "HOUSING",
    );
    expect(findings.map((f) => f.phrase)).toContain("walk to church");
  });

  it("catches multiple phrases across multiple fields and creatives", () => {
    const findings = lintCreativeCopy(
      [
        { variantIndex: 0, headline: "Bachelor pad", primaryText: "Safe neighborhood." },
        { variantIndex: 1, headline: "Ok", primaryText: "Empty nesters welcome.", description: "Walk to synagogue." },
      ],
      "HOUSING",
    );
    expect(findings.length).toBeGreaterThanOrEqual(4);
  });

  it("respects word boundaries (does not match inside another word)", () => {
    const findings = lintCreativeCopy(
      [{ variantIndex: 0, headline: "Singletree apartments", primaryText: "ok" }],
      "HOUSING",
    );
    expect(findings.find((f) => f.phrase === "single")).toBeUndefined();
  });

  it("ignores empty / missing fields without throwing", () => {
    expect(
      lintCreativeCopy(
        [{ variantIndex: 0, headline: null, primaryText: undefined, description: "" }],
        "HOUSING",
      ),
    ).toEqual([]);
  });

  it("phrase list is non-empty (sanity)", () => {
    expect(HOUSING_BLOCKED_PHRASES.length).toBeGreaterThan(10);
  });
});

describe("validatePackageReady — copy linter integration", () => {
  it("rejects HOUSING when copy contains a blocked phrase", async () => {
    const pkg = fullPkg({
      specialCategory: "HOUSING",
      reviewedByUserId: "u1",
      audience: {
        locationsJson: [{ kind: "country", value: "US" }],
        ageMin: 18,
        ageMax: 65,
        gendersJson: ["all"],
        customAudienceHintsJson: [],
        housingRestricted: true,
      },
      creatives: [
        { variantIndex: 0, headline: "Perfect for families", primaryText: "Schedule a tour" },
      ],
    });
    await expect(service.validatePackageReady(pkg)).rejects.toMatchObject({
      code: "COMPLIANCE_COPY_REVIEW_FAILED",
      findings: expect.arrayContaining([
        expect.objectContaining({ field: "headline", phrase: "perfect for families" }),
      ]),
    });
  });

  it("does not lint when specialCategory is NONE", async () => {
    const pkg = fullPkg({
      creatives: [{ variantIndex: 0, headline: "Perfect for families", primaryText: "ok" }],
    });
    await expect(service.validatePackageReady(pkg)).resolves.toBeUndefined();
  });
});

describe("exportPackage — defense in depth", () => {
  it("re-runs validator at export time and rejects a stale READY package", async () => {
    fixtures = {
      prisma: {
        ...buildPrismaMock(),
        adPackage: {
          findFirst: vi.fn(async () => ({
            id: "pkg-stale",
            clientId: CLIENT_A,
            name: "X",
            status: "READY",
            specialCategory: "NONE",
            exportsJson: [],
            objective: "LEADS",
            sourceType: "IDEA",
            sourceIdea: "x",
            // Creative exists but headline is empty — stale.
            creatives: [{ variantIndex: 0, headline: "", primaryText: "" }],
            audience: { locationsJson: [{ kind: "country", value: "US" }], gendersJson: ["all"], customAudienceHintsJson: [] },
            budget: { dailyBudgetCents: 1000, currency: "USD" },
            destination: { kind: "EXTERNAL_URL", externalUrl: "https://example.com" },
          })),
        },
      },
    };
    await expect(
      exportSvc.exportPackage(CLIENT_A, "pkg-stale", "u1", { format: "json" }),
    ).rejects.toMatchObject({ code: "READY_PRECONDITIONS_FAILED", status: 400 });
  });
});
