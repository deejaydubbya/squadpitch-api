import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { buildProspectAttemptGuidance, composeStructuredProspectBody, validateGeneratedPropertyBody, validateStructuredProspectDraft } from "../domains/prospects/prospect.service.js";

const root = new URL("..", import.meta.url);
const read = (path) => fs.readFileSync(new URL(path, root), "utf8");

describe("durable prospect preparation", () => {
  it("persists an immutable run and enforces one active run per prospect", () => {
    const migration = read("prisma/migrations/20260813043000_add_prospect_preparation_runs/migration.sql");
    expect(migration).toContain("prospect_preparation_runs");
    expect(migration).toContain("WHERE \"status\" IN ('QUEUED', 'RUNNING')");
  });

  it("executes preparation in BullMQ instead of the HTTP request", () => {
    const routes = read("domains/internal/internal.routes.js");
    const worker = read("workers/prospectPreparationWorker.js");
    expect(routes).toContain("startProspectPreparation");
    expect(routes).not.toContain("prospectService.prepareProspect(");
    expect(worker).toContain("executeProspectPreparation(job.data.runId)");
  });

  it("records per-platform attempts, provenance, stale failure, and terminal warning state", () => {
    const service = read("domains/prospects/prospect.service.js");
    for (const state of ["NOT_STARTED", "GENERATING", "VALIDATING", "RETRYING", "AI_ACCEPTED", "FALLBACK_ACCEPTED"]) expect(service).toContain(state);
    expect(service).toContain("STALE_RUN");
    expect(service).toContain("COMPLETE_WITH_WARNINGS");
  });
});

describe("property copy factuality boundary", () => {
  const item = { title: "1976 Shinkles Ridge Road", dataJson: { street: "1976 Shinkles Ridge Road", city: "Lewis Twp", state: "OH", zip: "45121", price: 479900 } };

  it("allows controlled non-factual framing and CTA language", () => {
    expect(validateGeneratedPropertyBody("Now available: 1976 Shinkles Ridge Road.\n\nTake a look at the verified listing.\n\nContact us to request details or schedule a showing.", item)).toEqual({ valid: true });
  });

  it.each(["This beautiful home is now available at 1976 Shinkles Ridge Road. Contact us to schedule a showing.", "Explore this spacious property at 1976 Shinkles Ridge Road. Contact us to request details."])("rejects unsupported subjective copy", (body) => {
    expect(validateGeneratedPropertyBody(body, item).valid).toBe(false);
  });
});

describe("Christopher Shepherd progressive generation fixture", () => {
  const item = { title: "12823 New Hope White Oak Station Road", dataJson: { street: "12823 New Hope White Oak St", city: "Scott Twp", state: "OH", zip: "45171", price: 464900, bathrooms: 4, sqft: 3245, yearBuilt: 1998 } };

  it("makes each retry progressively narrower and carries rejection feedback", () => {
    const first = buildProspectAttemptGuidance({ item, channel: "INSTAGRAM", attempt: 1 });
    const second = buildProspectAttemptGuidance({ item, channel: "INSTAGRAM", attempt: 2, rejectedPhrases: ["spacious"] });
    const third = buildProspectAttemptGuidance({ item, channel: "INSTAGRAM", attempt: 3, rejectedPhrases: ["spacious", "perfect for"] });
    expect(first).toContain("grounded, natural");
    expect(second).toContain('"spacious"');
    expect(second).toContain("do not replace one subjective claim with another");
    expect(third).toContain("STRICT GROUNDED COMPOSITION");
    expect(third).toContain('"perfect for"');
  });

  it.each([
    ["INSTAGRAM", "Take a look at this newly available listing", "Message us to request details or schedule a showing.", ["JustListed", "ScottTwp", "RealEstate"]],
    ["FACEBOOK", "Now available in the local market", "Contact us to review the complete listing or schedule a showing.", []],
    ["LINKEDIN", "Property listing update", "Contact the listing business for complete details and showing information.", ["RealEstate", "PropertyUpdate"]],
  ])("accepts substantive structured %s output from sparse verified facts", (channel, hook, cta, hashtags) => {
    const draft = { hooks: [hook], body: "12823 New Hope White Oak St in Scott Twp, OH 45171 is listed at $464,900. The listing records 4 bathrooms, 3,245 square feet, and a year built of 1998.", cta, hashtags };
    const body = composeStructuredProspectBody(draft, channel);
    expect(validateStructuredProspectDraft(draft, item, channel)).toEqual({ valid: true });
    expect(body.split("\n\n").length).toBeGreaterThanOrEqual(3);
  });

  it("rejects an undeclared numeric property claim at the component boundary", () => {
    const draft = { hooks: ["Take a look at this newly available listing"], body: "12823 New Hope White Oak St is listed at $464,900 and includes 7 bedrooms.", cta: "Message us to request details.", hashtags: ["JustListed", "RealEstate"] };
    expect(validateStructuredProspectDraft(draft, item, "INSTAGRAM")).toMatchObject({ valid: false, reason: "UNSUPPORTED_NUMERIC_CLAIM", matchedText: "7" });
  });

  it.each(["beautiful", "spacious", "desirable", "perfect for", "welcoming", "investment opportunity"])("continues rejecting unsupported %s language", (claim) => {
    const body = `Take a look at 12823 New Hope White Oak St. This ${claim} property is listed at $464,900. Contact us to schedule a showing.`;
    expect(validateGeneratedPropertyBody(body, item)).toMatchObject({ valid: false, reason: "UNSUPPORTED_PROPERTY_CLAIM" });
  });
});
