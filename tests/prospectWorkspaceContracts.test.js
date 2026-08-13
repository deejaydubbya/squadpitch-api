import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (path) => readFileSync(path, "utf8");

describe("prospect workspace release contracts", () => {
  it("keeps migration additive and defaults existing clients to CUSTOMER", () => {
    const migration = read("prisma/migrations/20260812000000_add_prospect_workspaces/migration.sql");
    expect(migration).toContain("ADD COLUMN \"lifecycle\"");
    expect(migration).toContain("DEFAULT 'CUSTOMER'");
    expect(migration).not.toMatch(/DROP\s+(TABLE|COLUMN)/i);
  });

  it("mounts previews before auth and claim mutation after auth", () => {
    const server = read("server.js");
    expect(server.indexOf("app.use(prospectPublicRouter)")).toBeLessThan(server.indexOf('app.use("/api"'));
    expect(server.indexOf("app.use(prospectClaimRouter)")).toBeGreaterThan(server.indexOf('app.use("/api"'));
  });

  it("requires an admin role for all prospect operator routes", () => {
    const routes = read("domains/internal/internal.routes.js");
    const prospectRouteLines = routes.split("\n").filter((line) => line.includes("`${BASE}/prospects"));
    expect(prospectRouteLines.length).toBeGreaterThanOrEqual(7);
    expect(prospectRouteLines.every((line) => line.includes("requireAdminRole"))).toBe(true);
  });

  it("routes prospect listing preparation through the canonical safe import and generation pipeline", () => {
    const service = read("domains/prospects/prospect.service.js");
    expect(service).toContain("analyzeUrl(prospect.clientId");
    expect(service).toContain("confirmUrl(prospect.clientId");
    expect(service).toContain("enrichListingById(prospect.clientId");
    expect(service).toContain("generateDraft({");
    expect(service).toContain("assertSafeExternalUrl(externalUrl)");
    expect(service).toContain("PROSPECT_PROPERTY_FACT_GUARD");
    expect(service).toContain("validateGeneratedPropertyBody");
    expect(service).toContain("buildVerifiedPropertyFallback");
    expect(service).toContain("PROSPECT_PROPERTY_VERIFIED_FALLBACK");
    expect(service).toContain("after three rejected prospect generation attempts");
    expect(service).toContain("ALLOWED_FACTS:");
    expect(service).toContain("ALLOWED_NEUTRAL_FRAMING:");
    expect(service).not.toContain("verifiedPropertyPreviewBody");
    expect(service).toContain("draftAsset.createMany");
    expect(service).toContain('role: orderIndex === 0 ? "primary" : "gallery"');
    expect(service).not.toContain("can use consistent, helpful social content");
  });

  it("projects canonical draft copy and every ordered selected media asset", () => {
    const service = read("domains/prospects/prospect.service.js");
    expect(service).toContain("body: draft.body");
    expect(service).toContain('orderBy: { orderIndex: "asc" }');
    expect(service).toContain("altText: asset.altText");
    expect(service).toContain("orderIndex");
  });

  it("rejects impossible bedroom counts produced by concatenated listing markup", () => {
    const ingestion = read("domains/studio/listingIngestion.service.js");
    expect(ingestion).toContain("parsedBeds <= 20");
    expect(ingestion).toContain("parsedBaths <= 20");
  });

  it("prevents background publication and autopilot for prospect lifecycle", () => {
    const publisher = read("workers/scheduledPublishWorker.js");
    const autopilot = read("domains/studio/autopilot.service.js");
    expect(publisher).toContain('lifecycle: "CUSTOMER"');
    expect(autopilot).toContain('lifecycle: "CUSTOMER"');
  });

  it("never places claim credentials in API route paths or audit metadata", () => {
    const routes = read("domains/prospects/prospect.routes.js");
    expect(routes).toContain('prospect-claims/claim"');
    expect(routes).toContain("req.body?.claimToken");
    expect(routes).not.toContain('prospect-claims/:token');
    expect(routes).not.toMatch(/metadata:\s*\{[^}]*claimToken/s);
  });
});
