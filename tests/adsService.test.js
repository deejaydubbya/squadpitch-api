// SquadAds service tests.
//
// Covers the rules that have to hold for export-only safety:
//   - Source context loader handles every sourceType + missing rows.
//   - HOUSING auto-tags for property-sourced packages and real-estate
//     workspaces.
//   - Audience demographic clearing fires when specialCategory !== NONE.
//   - "Mark READY" rejects when preconditions are missing.
//   - Export refuses unless status is READY (or already EXPORTED).
//   - Export bundle contains housing disclaimer when specialCategory=HOUSING.
//
// Mocks prisma + the AI provider so no DB or OpenAI is touched.

import { describe, it, expect, vi, beforeEach } from "vitest";

let fixtures;
let captured;

vi.mock("../prisma.js", () => ({
  get prisma() {
    return fixtures.prisma;
  },
}));

vi.mock("../domains/studio/generation/clientOrchestrator.js", () => ({
  loadClientGenerationContext: vi.fn(async () => ({
    client: { name: "Smith Realty" },
    brand: { tagline: "Find your home.", valueProposition: null },
    voice: { tone: "warm", style: "concise" },
  })),
}));

vi.mock("../domains/studio/generation/openai.provider.js", () => ({
  generateStructuredContent: vi.fn(async ({ systemPrompt, userPrompt }) => {
    captured.systemPrompt = systemPrompt;
    captured.userPrompt = userPrompt;
    return {
      parsed: {
        creatives: [
          {
            headline: "Discover your next home",
            primaryText: "508 King George Court is available now.",
            cta: "Schedule Tour",
            rationale: "Lead-in for property-curious browsers.",
          },
          {
            headline: "Now showing in Cary",
            primaryText: "4 bed · 3 bath · $365,000.",
            cta: "See Details",
            rationale: "Hits price-sensitive buyers.",
          },
        ],
        audience: {
          locations: [{ kind: "city", value: "Cary, NC" }],
          ageMin: 25,
          ageMax: 55,
          interests: ["home buying", "real estate"],
          languages: ["en"],
        },
        budget: {
          suggestedDailyCents: 5000,
          suggestedTotalCents: 75000,
          durationDays: 15,
          rationale: "Fits a single-listing two-week push.",
        },
        complianceNotes: "Housing special category — demographic targeting cleared.",
      },
      model: "gpt-stub-test",
      usage: { prompt_tokens: 200, completion_tokens: 80 },
    };
  }),
}));

vi.mock("../domains/billing/aiUsageTracking.service.js", () => ({
  trackAiUsage: vi.fn(),
}));

const service = await import("../domains/ads/ads.service.js");
const exportSvc = await import("../domains/ads/ads.export.service.js");

const CLIENT_ID = "client-1";

// ── Prisma mock builder ────────────────────────────────────────────────

function buildPrismaMock(initial = {}) {
  const state = {
    adPackages: new Map(initial.adPackages ?? []),
    adCreatives: new Map(initial.adCreatives ?? []),
    adAudiences: new Map(initial.adAudiences ?? []),
    adBudgets: new Map(initial.adBudgets ?? []),
    adDestinations: new Map(initial.adDestinations ?? []),
    brandProfiles: new Map(initial.brandProfiles ?? []),
    campaigns: new Map(initial.campaigns ?? []),
    sitePages: new Map(initial.sitePages ?? []),
    drafts: new Map(initial.drafts ?? []),
    workspaceDataItems: new Map(initial.workspaceDataItems ?? []),
    mediaAssets: new Map(initial.mediaAssets ?? []),
  };

  function attachChildren(pkg) {
    const creatives = [...state.adCreatives.values()]
      .filter((c) => c.adPackageId === pkg.id)
      .sort((a, b) => a.variantIndex - b.variantIndex);
    const audience = [...state.adAudiences.values()].find((a) => a.adPackageId === pkg.id) ?? null;
    const budget = [...state.adBudgets.values()].find((b) => b.adPackageId === pkg.id) ?? null;
    const destination = [...state.adDestinations.values()].find((d) => d.adPackageId === pkg.id) ?? null;
    return { ...pkg, creatives, audience, budget, destination };
  }

  return {
    state,
    adPackage: {
      findFirst: vi.fn(async ({ where }) => {
        for (const p of state.adPackages.values()) {
          if (p.id === where.id && p.clientId === where.clientId) return attachChildren(p);
        }
        return null;
      }),
      findMany: vi.fn(async () => [...state.adPackages.values()].map(attachChildren)),
      findUnique: vi.fn(async ({ where }) => {
        const row = state.adPackages.get(where.id);
        return row ? attachChildren(row) : null;
      }),
      create: vi.fn(async ({ data }) => {
        const id = `pkg-${state.adPackages.size + 1}`;
        const now = new Date();
        const { destination, ...rest } = data;
        const row = {
          id,
          ...rest,
          status: rest.status ?? "DRAFT",
          specialCategory: rest.specialCategory ?? "NONE",
          exportsJson: rest.exportsJson ?? [],
          promptTokens: rest.promptTokens ?? 0,
          completionTokens: rest.completionTokens ?? 0,
          createdAt: now,
          updatedAt: now,
        };
        state.adPackages.set(id, row);
        if (destination?.create) {
          const did = `dest-${state.adDestinations.size + 1}`;
          state.adDestinations.set(did, { id: did, adPackageId: id, ...destination.create });
        }
        return attachChildren(row);
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = state.adPackages.get(where.id);
        if (!row) throw new Error("P2025");
        const next = { ...row, ...data, updatedAt: new Date() };
        state.adPackages.set(where.id, next);
        return attachChildren(next);
      }),
      count: vi.fn(async () => state.adPackages.size),
    },
    adCreative: {
      upsert: vi.fn(async ({ where, create, update }) => {
        const key = `${where.adPackageId_variantIndex.adPackageId}:${where.adPackageId_variantIndex.variantIndex}`;
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
      create: vi.fn(async ({ data }) => {
        const id = `cr-${state.adCreatives.size + 1}`;
        const row = { id, ...data };
        state.adCreatives.set(id, row);
        return row;
      }),
      deleteMany: vi.fn(async ({ where }) => {
        let n = 0;
        for (const [id, c] of state.adCreatives.entries()) {
          if (c.adPackageId === where.adPackageId) {
            state.adCreatives.delete(id);
            n++;
          }
        }
        return { count: n };
      }),
      delete: vi.fn(async ({ where }) => {
        const c = state.adCreatives.get(where.id);
        if (!c) {
          const e = new Error("Not found");
          e.code = "P2025";
          throw e;
        }
        state.adCreatives.delete(where.id);
        return c;
      }),
    },
    adAudience: {
      upsert: vi.fn(async ({ where, create, update }) => {
        const existing = [...state.adAudiences.values()].find((a) => a.adPackageId === where.adPackageId);
        if (existing) {
          const next = { ...existing, ...update };
          state.adAudiences.set(existing.id, next);
          return next;
        }
        const id = `aud-${state.adAudiences.size + 1}`;
        const row = { id, ...create };
        state.adAudiences.set(id, row);
        return row;
      }),
      update: vi.fn(async ({ where, data }) => {
        const row = state.adAudiences.get(where.id);
        if (!row) throw new Error("not found");
        const next = { ...row, ...data };
        state.adAudiences.set(where.id, next);
        return next;
      }),
    },
    adBudget: {
      upsert: vi.fn(async ({ where, create, update }) => {
        const existing = [...state.adBudgets.values()].find((b) => b.adPackageId === where.adPackageId);
        if (existing) {
          const next = { ...existing, ...update };
          state.adBudgets.set(existing.id, next);
          return next;
        }
        const id = `bud-${state.adBudgets.size + 1}`;
        const row = { id, ...create };
        state.adBudgets.set(id, row);
        return row;
      }),
    },
    adDestination: {
      upsert: vi.fn(async ({ where, create, update }) => {
        const existing = [...state.adDestinations.values()].find((d) => d.adPackageId === where.adPackageId);
        if (existing) {
          const next = { ...existing, ...update };
          state.adDestinations.set(existing.id, next);
          return next;
        }
        const id = `dest-${state.adDestinations.size + 1}`;
        const row = { id, ...create };
        state.adDestinations.set(id, row);
        return row;
      }),
    },
    brandProfile: {
      findUnique: vi.fn(async ({ where }) => state.brandProfiles.get(where.clientId) ?? null),
    },
    campaign: {
      findUnique: vi.fn(async ({ where }) => state.campaigns.get(where.id) ?? null),
    },
    sitePage: {
      findUnique: vi.fn(async ({ where }) => state.sitePages.get(where.id) ?? null),
    },
    draft: {
      findUnique: vi.fn(async ({ where }) => state.drafts.get(where.id) ?? null),
    },
    workspaceDataItem: {
      findUnique: vi.fn(async ({ where }) => state.workspaceDataItems.get(where.id) ?? null),
    },
    mediaAsset: {
      findMany: vi.fn(async ({ where }) => {
        const ids = new Set(where.id?.in ?? []);
        return [...state.mediaAssets.values()].filter((a) => ids.has(a.id));
      }),
    },
  };
}

// ── Tests ───────────────────────────────────────────────────────────────

describe("createPackage — special category auto-tagging", () => {
  beforeEach(() => {
    captured = {};
  });

  it("auto-tags HOUSING when sourceType is PROPERTY", async () => {
    fixtures = { prisma: buildPrismaMock() };
    const pkg = await service.createPackage(CLIENT_ID, "auth0|u1", {
      name: "508 King George",
      objective: "LEADS",
      sourceType: "PROPERTY",
      sourceId: "data-1",
    });
    expect(pkg.specialCategory).toBe("HOUSING");
  });

  it("auto-tags HOUSING for real-estate workspaces even on CAMPAIGN source", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        brandProfiles: [[CLIENT_ID, { clientId: CLIENT_ID, industry: "real_estate" }]],
      }),
    };
    const pkg = await service.createPackage(CLIENT_ID, "auth0|u1", {
      name: "Spring Push",
      objective: "AWARENESS",
      sourceType: "CAMPAIGN",
      sourceId: "camp-1",
    });
    expect(pkg.specialCategory).toBe("HOUSING");
  });

  it("leaves specialCategory NONE for non-property, non-real-estate source", async () => {
    fixtures = { prisma: buildPrismaMock() };
    const pkg = await service.createPackage(CLIENT_ID, "auth0|u1", {
      name: "Idea-only",
      objective: "TRAFFIC",
      sourceType: "IDEA",
      sourceIdea: "Promote our new ebook.",
    });
    expect(pkg.specialCategory).toBe("NONE");
  });
});

describe("upsertAudience — housing demographic clearing", () => {
  it("forces ageMin=18 / ageMax=65 / genders=['all'] when specialCategory != NONE", async () => {
    fixtures = { prisma: buildPrismaMock() };
    // Seed a HOUSING package directly.
    fixtures.prisma.state.adPackages.set("pkg-h", {
      id: "pkg-h",
      clientId: CLIENT_ID,
      specialCategory: "HOUSING",
    });

    const audience = await service.upsertAudience(CLIENT_ID, "pkg-h", {
      ageMin: 30, // user tried to narrow
      ageMax: 45,
      genders: ["female"], // user tried demographic targeting
      interests: ["luxury home buyers"],
    });
    expect(audience.ageMin).toBe(18);
    expect(audience.ageMax).toBe(65);
    expect(audience.gendersJson).toEqual(["all"]);
    expect(audience.housingRestricted).toBe(true);
    // Interests survive — only demographics are restricted.
    expect(audience.interestsJson).toEqual(["luxury home buyers"]);
  });

  it("preserves user-set demographics when specialCategory is NONE", async () => {
    fixtures = { prisma: buildPrismaMock() };
    fixtures.prisma.state.adPackages.set("pkg-n", {
      id: "pkg-n",
      clientId: CLIENT_ID,
      specialCategory: "NONE",
    });
    const audience = await service.upsertAudience(CLIENT_ID, "pkg-n", {
      ageMin: 25,
      ageMax: 40,
      genders: ["female"],
    });
    expect(audience.ageMin).toBe(25);
    expect(audience.ageMax).toBe(40);
    expect(audience.gendersJson).toEqual(["female"]);
    expect(audience.housingRestricted).toBe(false);
  });
});

describe("updatePackage — READY transition gate", () => {
  it("rejects READY when there are no creatives", async () => {
    fixtures = { prisma: buildPrismaMock() };
    fixtures.prisma.state.adPackages.set("pkg-empty", {
      id: "pkg-empty",
      clientId: CLIENT_ID,
      status: "DRAFT",
      specialCategory: "NONE",
    });
    await expect(
      service.updatePackage(CLIENT_ID, "pkg-empty", "auth0|u1", { status: "READY" }),
    ).rejects.toMatchObject({ code: "READY_PRECONDITIONS_FAILED" });
  });

  it("rejects READY for HOUSING package without compliance acknowledgment", async () => {
    fixtures = { prisma: buildPrismaMock() };
    // Fully populated except reviewedByUserId.
    fixtures.prisma.state.adPackages.set("pkg-h", {
      id: "pkg-h",
      clientId: CLIENT_ID,
      status: "DRAFT",
      specialCategory: "HOUSING",
    });
    fixtures.prisma.state.adCreatives.set("c1", {
      id: "c1",
      adPackageId: "pkg-h",
      variantIndex: 1,
      headline: "h",
      primaryText: "t",
    });
    fixtures.prisma.state.adAudiences.set("a1", { id: "a1", adPackageId: "pkg-h", housingRestricted: true });
    fixtures.prisma.state.adBudgets.set("b1", { id: "b1", adPackageId: "pkg-h", dailyBudgetCents: 5000 });
    fixtures.prisma.state.adDestinations.set("d1", { id: "d1", adPackageId: "pkg-h", kind: "EXTERNAL_URL", externalUrl: "https://example.com" });

    await expect(
      service.updatePackage(CLIENT_ID, "pkg-h", "auth0|u1", { status: "READY" }),
    ).rejects.toMatchObject({ code: "READY_PRECONDITIONS_FAILED" });
  });

  it("accepts READY when everything is populated and review is acknowledged", async () => {
    fixtures = { prisma: buildPrismaMock() };
    fixtures.prisma.state.adPackages.set("pkg-ok", {
      id: "pkg-ok",
      clientId: CLIENT_ID,
      status: "DRAFT",
      specialCategory: "NONE",
    });
    fixtures.prisma.state.adCreatives.set("c1", {
      id: "c1",
      adPackageId: "pkg-ok",
      variantIndex: 1,
      headline: "h",
      primaryText: "t",
    });
    fixtures.prisma.state.adAudiences.set("a1", { id: "a1", adPackageId: "pkg-ok" });
    fixtures.prisma.state.adBudgets.set("b1", { id: "b1", adPackageId: "pkg-ok", dailyBudgetCents: 1000 });
    fixtures.prisma.state.adDestinations.set("d1", { id: "d1", adPackageId: "pkg-ok", kind: "EXTERNAL_URL", externalUrl: "https://example.com" });

    // First: acknowledge review.
    await service.updatePackage(CLIENT_ID, "pkg-ok", "auth0|u1", { acknowledgeReview: true });
    const pkg = await service.updatePackage(CLIENT_ID, "pkg-ok", "auth0|u1", { status: "READY" });
    expect(pkg.status).toBe("READY");
    expect(pkg.reviewedByUserId).toBe("auth0|u1");
    expect(pkg.reviewedAt).toBeTruthy();
  });
});

describe("generatePackage — prompt grounding + side effects", () => {
  beforeEach(() => {
    captured = {};
  });

  it("includes property facts in the prompt and persists creatives + audience + budget", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        adPackages: [
          [
            "pkg-1",
            {
              id: "pkg-1",
              clientId: CLIENT_ID,
              name: "508 KGC",
              objective: "LEADS",
              status: "DRAFT",
              specialCategory: "HOUSING",
              sourceType: "PROPERTY",
              sourceId: "data-1",
              promptTokens: 0,
              completionTokens: 0,
            },
          ],
        ],
        workspaceDataItems: [
          [
            "data-1",
            {
              id: "data-1",
              type: "PROPERTY",
              title: "508 King George Court",
              summary: "Renovated 4-bed in Cary, NC.",
              dataJson: { street: "508 King George Court", city: "Cary", state: "NC", price: 365000, bedrooms: 4, bathrooms: 3, sqft: 2850 },
              tags: ["listing"],
            },
          ],
        ],
      }),
    };

    const pkg = await service.generatePackage(CLIENT_ID, "pkg-1", "auth0|u1");

    // Prompt-side: housing directive present, facts surfaced.
    expect(captured.systemPrompt).toMatch(/HOUSING SPECIAL CATEGORY/);
    expect(captured.userPrompt).toContain("508 King George Court");
    expect(captured.userPrompt).toContain("Price: 365000");

    // Persistence: 2 creatives written, audience seeded, budget seeded.
    expect(pkg.creatives.length).toBe(2);
    expect(pkg.creatives[0].headline).toContain("Discover your next home");
    expect(pkg.audience).toBeTruthy();
    expect(pkg.audience.housingRestricted).toBe(true);
    expect(pkg.audience.ageMin).toBe(18); // forced regardless of AI suggestion
    expect(pkg.audience.ageMax).toBe(65);
    expect(pkg.budget).toBeTruthy();
    expect(pkg.budget.suggestedDailyBudgetCents).toBe(5000);
  });
});

describe("exportPackage — gating + bundle", () => {
  it("rejects when package status is DRAFT", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        adPackages: [
          [
            "pkg-draft",
            { id: "pkg-draft", clientId: CLIENT_ID, status: "DRAFT", specialCategory: "NONE", exportsJson: [] },
          ],
        ],
      }),
    };
    await expect(exportSvc.exportPackage(CLIENT_ID, "pkg-draft", "auth0|u1")).rejects.toMatchObject({
      code: "PACKAGE_NOT_READY",
    });
  });

  it("returns JSON bundle when ready, flips status to EXPORTED, appends to exportsJson", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        adPackages: [
          [
            "pkg-ready",
            {
              id: "pkg-ready",
              clientId: CLIENT_ID,
              name: "Test",
              status: "READY",
              specialCategory: "HOUSING",
              exportsJson: [],
              objective: "LEADS",
              sourceType: "PROPERTY",
              sourceId: "data-1",
              sourceIdea: null,
              reviewedByUserId: "auth0|u1",
              reviewedAt: new Date(),
            },
          ],
        ],
        adCreatives: [
          [
            "c1",
            {
              id: "c1",
              adPackageId: "pkg-ready",
              variantIndex: 1,
              headline: "h",
              primaryText: "t",
              additionalAssetIdsJson: [],
            },
          ],
        ],
      }),
    };

    const result = await exportSvc.exportPackage(CLIENT_ID, "pkg-ready", "auth0|u1", { format: "json" });
    expect(result.filename).toMatch(/\.json$/);
    expect(result.mimeType).toBe("application/json");
    expect(result.bundle.package.specialCategory).toBe("HOUSING");
    expect(result.bundle.compliance.housingDisclaimer).toMatch(/Fair Housing/);
    expect(result.bundle.compliance.notLaunchedDisclaimer).toMatch(/NOT LAUNCHED BY SQUADPITCH/);

    // Side effects: status flips, exportsJson appended.
    const pkg = fixtures.prisma.state.adPackages.get("pkg-ready");
    expect(pkg.status).toBe("EXPORTED");
    expect(pkg.exportsJson).toHaveLength(1);
    expect(pkg.exportsJson[0].format).toBe("json");
  });

  it("renders markdown with all compliance disclaimers when format=markdown", async () => {
    fixtures = {
      prisma: buildPrismaMock({
        adPackages: [
          [
            "pkg-md",
            {
              id: "pkg-md",
              clientId: CLIENT_ID,
              name: "MD",
              status: "READY",
              specialCategory: "HOUSING",
              exportsJson: [],
              objective: "LEADS",
              sourceType: "IDEA",
              sourceId: null,
              sourceIdea: "Promote new listing",
              reviewNotes: "Reviewed by agent",
              reviewedByUserId: "auth0|u1",
              reviewedAt: new Date(),
            },
          ],
        ],
        adCreatives: [
          [
            "c1",
            {
              id: "c1",
              adPackageId: "pkg-md",
              variantIndex: 1,
              headline: "Hello",
              primaryText: "World",
              additionalAssetIdsJson: [],
            },
          ],
        ],
      }),
    };

    const result = await exportSvc.exportPackage(CLIENT_ID, "pkg-md", "auth0|u1", { format: "markdown" });
    expect(result.filename).toMatch(/\.md$/);
    expect(result.content).toMatch(/^# MD/);
    expect(result.content).toMatch(/HOUSING SPECIAL AD CATEGORY/);
    expect(result.content).toMatch(/NOT LAUNCHED BY SQUADPITCH/);
    expect(result.content).toMatch(/Reviewed by agent/);
  });
});

describe("loadPackageSourceContext — defensive lookups", () => {
  it("returns null shape for missing rows without throwing", async () => {
    fixtures = { prisma: buildPrismaMock() };
    const ctx1 = await service.loadPackageSourceContext({
      sourceType: "CAMPAIGN",
      sourceId: "missing",
    });
    expect(ctx1).toEqual({ kind: "campaign", row: null });
    const ctx2 = await service.loadPackageSourceContext({
      sourceType: "IDEA",
      sourceIdea: "freeform brief",
    });
    expect(ctx2).toEqual({ kind: "idea", text: "freeform brief" });
  });
});
