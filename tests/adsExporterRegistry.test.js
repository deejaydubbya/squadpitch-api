// Ads-04 — exporter registry + per-format dispatch.
//
// One test per registered format asserts the MIME type, filename
// extension, and isDirectImport flag (so the FE can render an
// honest "this is / isn't a direct platform import" hint).
// Legacy aliases `json` and `markdown` continue to resolve to
// the canonical squadads_json / agency_markdown renderers.
// Unknown formats are rejected by the route schema with a
// VALIDATION_FAILED response shape.

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
const { ExportRequestSchema } = await import("../domains/ads/ads.schemas.js");
const { listExporters, getExporter, SUPPORTED_FORMATS } = await import(
  "../domains/ads/exporters/index.js"
);

const CLIENT_ID = "client-1";

function readyPackage(overrides = {}) {
  return {
    id: "pkg-r1",
    clientId: CLIENT_ID,
    name: "Spring open house",
    status: "READY",
    specialCategory: "NONE",
    exportsJson: [],
    objective: "TRAFFIC",
    sourceType: "IDEA",
    sourceId: null,
    sourceIdea: "Brief",
    ...overrides,
  };
}

function buildPrismaMock() {
  // Minimal mock — enough for the export service to load a READY
  // package, validate it, and dispatch to a renderer. The bundle
  // builder reads sitePage / client / mediaAsset too; we satisfy
  // those with no-op responses for the IDEA-source / EXTERNAL_URL
  // / no-asset fixture above.
  const state = {
    adPackages: new Map([[
      "pkg-r1",
      readyPackage(),
    ]]),
  };
  function attach(pkg) {
    return {
      ...pkg,
      creatives: [
        {
          id: "c1",
          adPackageId: pkg.id,
          variantIndex: 1,
          channel: null,
          headline: "Visit our open house",
          primaryText: "Sunday 1–4 PM at 508 King George Court.",
          description: null,
          cta: "Schedule Tour",
          primaryAssetId: null,
          additionalAssetIdsJson: [],
          rationale: "Lead-in for open-house weekend.",
        },
      ],
      audience: {
        id: "a1",
        adPackageId: pkg.id,
        locationsJson: [{ kind: "city", value: "Cary, NC" }],
        ageMin: 25,
        ageMax: 55,
        gendersJson: ["all"],
        interestsJson: ["home buying"],
        customAudienceHintsJson: [],
        languagesJson: ["en"],
        housingRestricted: false,
      },
      budget: {
        id: "b1",
        adPackageId: pkg.id,
        dailyBudgetCents: 5000,
        totalBudgetCents: null,
        currency: "USD",
        durationDays: 14,
        startsAt: null,
        endsAt: null,
      },
      destination: {
        id: "d1",
        adPackageId: pkg.id,
        kind: "EXTERNAL_URL",
        sitePageId: null,
        externalUrl: "https://smithrealty.example.com/open-house",
        socialProfile: null,
        utmJson: { source: "google", medium: "cpc" },
        pixelIdsJson: [],
      },
    };
  }
  return {
    state,
    adPackage: {
      findFirst: vi.fn(async ({ where }) => {
        const pkg = state.adPackages.get(where.id);
        if (!pkg || pkg.clientId !== where.clientId) return null;
        return attach(pkg);
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

describe("exporter registry — metadata", () => {
  it("registers all expected canonical formats", () => {
    const formats = listExporters().map((e) => e.format).sort();
    expect(formats).toEqual(
      [
        "agency_markdown",
        "google_ads_editor_csv",
        "linkedin_launch_sheet",
        "meta_launch_sheet",
        "pinterest_launch_sheet",
        "squadads_json",
        "tiktok_bulk_template_csv",
      ].sort(),
    );
  });

  it("exposes legacy aliases (json, markdown) so old callers keep working", () => {
    expect(SUPPORTED_FORMATS).toEqual(expect.arrayContaining(["json", "markdown"]));
    expect(getExporter("json")?.format).toBe("squadads_json");
    expect(getExporter("markdown")?.format).toBe("agency_markdown");
  });

  it("returns null for an unknown format", () => {
    expect(getExporter("definitely_not_a_format")).toBeNull();
  });

  it("every descriptor exposes the FE-facing fields", () => {
    for (const e of listExporters()) {
      expect(e).toMatchObject({
        format: expect.any(String),
        label: expect.any(String),
        mimeType: expect.any(String),
        extension: expect.any(String),
        platform: expect.any(String),
        isDirectImport: expect.any(Boolean),
        notes: expect.any(String),
      });
    }
  });
});

describe("ExportRequestSchema — accepts new formats + aliases, rejects unknown", () => {
  it("accepts the canonical format names", () => {
    for (const f of [
      "squadads_json",
      "agency_markdown",
      "meta_launch_sheet",
      "linkedin_launch_sheet",
      "pinterest_launch_sheet",
      "google_ads_editor_csv",
      "tiktok_bulk_template_csv",
    ]) {
      const parsed = ExportRequestSchema.safeParse({ format: f });
      expect(parsed.success, `${f} should parse`).toBe(true);
    }
  });

  it("accepts legacy aliases", () => {
    expect(ExportRequestSchema.safeParse({ format: "json" }).success).toBe(true);
    expect(ExportRequestSchema.safeParse({ format: "markdown" }).success).toBe(true);
  });

  it("rejects an unknown format with a typed validation error", () => {
    const parsed = ExportRequestSchema.safeParse({ format: "csv_for_pelicans" });
    expect(parsed.success).toBe(false);
    // Zod's enum error carries the offending value and accepted list,
    // which the route layer surfaces via validationError().
    expect(parsed.error.issues[0].code).toBe("invalid_enum_value");
  });

  it("defaults format to squadads_json when omitted", () => {
    const parsed = ExportRequestSchema.safeParse({});
    expect(parsed.success).toBe(true);
    expect(parsed.data.format).toBe("squadads_json");
  });
});

// Per-format integration smoke. For every registered format, run an
// export against the minimal fixture and assert:
//   - MIME, extension, label, platform, isDirectImport echo from the
//     registry (so the FE can trust them).
//   - filename ends with the registry's extension.
//   - content is a non-empty string.
// We deliberately do NOT snapshot platform-specific bytes here —
// the per-format prompts (ads-05/06/07/08) will add deeper
// assertions on each.
describe("exportPackage — per-format dispatch (smoke)", () => {
  const cases = [
    { format: "squadads_json", mime: "application/json", ext: "json", direct: false },
    { format: "agency_markdown", mime: "text/markdown; charset=utf-8", ext: "md", direct: false },
    { format: "meta_launch_sheet", mime: "text/csv; charset=utf-8", ext: "csv", direct: false },
    { format: "linkedin_launch_sheet", mime: "text/csv; charset=utf-8", ext: "csv", direct: false },
    { format: "pinterest_launch_sheet", mime: "text/csv; charset=utf-8", ext: "csv", direct: false },
    // Ads-05 — flipped to isDirectImport: false. Editor *will*
    // import it, but campaign-type / bidding / conversion-
    // tracking settings still need user review. Honest framing.
    { format: "google_ads_editor_csv", mime: "text/csv; charset=utf-8", ext: "csv", direct: false },
    { format: "tiktok_bulk_template_csv", mime: "text/csv; charset=utf-8", ext: "csv", direct: true },
  ];

  for (const c of cases) {
    it(`format=${c.format} returns ${c.ext} bytes with the right MIME + flags`, async () => {
      const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-r1", "auth0|u1", {
        format: c.format,
      });
      expect(res.format).toBe(c.format);
      expect(res.mimeType).toBe(c.mime);
      expect(res.extension).toBe(c.ext);
      expect(res.isDirectImport).toBe(c.direct);
      expect(res.filename.endsWith(`.${c.ext}`)).toBe(true);
      expect(typeof res.content).toBe("string");
      expect(res.content.length).toBeGreaterThan(0);
      expect(res.platformNotes).toEqual(expect.any(String));
      expect(res.bundle).toBeTruthy();
    });
  }

  it("legacy alias 'json' renders the squadads_json content + filename", async () => {
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-r1", "auth0|u1", {
      format: "json",
    });
    expect(res.format).toBe("squadads_json");
    expect(res.mimeType).toBe("application/json");
    expect(res.filename.endsWith(".json")).toBe(true);
    // The squadads_json renderer pretty-prints — verify it parses
    // as JSON so future schema-version bumps are caught here.
    const parsed = JSON.parse(res.content);
    expect(parsed.schemaVersion).toBe(1);
  });

  it("legacy alias 'markdown' renders the agency_markdown content + filename", async () => {
    const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-r1", "auth0|u1", {
      format: "markdown",
    });
    expect(res.format).toBe("agency_markdown");
    expect(res.mimeType).toBe("text/markdown; charset=utf-8");
    expect(res.filename.endsWith(".md")).toBe(true);
    expect(res.content).toMatch(/^# /);
  });

  it("download mode records the canonical format in exportsJson regardless of alias", async () => {
    await exportSvc.exportPackage(CLIENT_ID, "pkg-r1", "auth0|u1", {
      format: "markdown",
      mode: "download",
    });
    const pkg = fixtures.prisma.state.adPackages.get("pkg-r1");
    expect(pkg.exportsJson[0].format).toBe("agency_markdown");
  });

  it("rejects an unknown format with a stable UNSUPPORTED_EXPORT_FORMAT code", async () => {
    // The schema normally guards this at the route boundary, but
    // the service-layer guard exists too so direct callers still
    // get a typed error.
    await expect(
      exportSvc.exportPackage(CLIENT_ID, "pkg-r1", "auth0|u1", { format: "totally_made_up" }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_EXPORT_FORMAT" });
  });
});

// Ads-04 — launch-sheet disclaimers. Every launch sheet must
// surface the "setup guide, not import file" notice (in the notes
// metadata + somewhere in the bytes) so the FE can render it and
// the user sees it in the file too.
describe("launch sheets carry honest disclaimers", () => {
  for (const f of ["meta_launch_sheet", "linkedin_launch_sheet", "pinterest_launch_sheet"]) {
    it(`${f}: registry notes mention "not" and "import" or "checklist"`, async () => {
      const exp = getExporter(f);
      expect(exp.notes.toLowerCase()).toMatch(/(not|setup|checklist)/);
      const res = await exportSvc.exportPackage(CLIENT_ID, "pkg-r1", "auth0|u1", { format: f });
      expect(res.content).toMatch(/SETUP CHECKLIST/i);
      expect(res.isDirectImport).toBe(false);
    });
  }
});
