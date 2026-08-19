import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { buildProspectAttemptGuidance, composeStructuredProspectBody, repairStructuredProspectDraft, validateGeneratedPropertyBody, validateProspectComposition, validateStructuredProspectDraft } from "../domains/prospects/prospect.service.js";

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

  it("queues outreach delivery and processes it with a single delay-aware worker", () => {
    const routes = read("domains/internal/internal.routes.js");
    const worker = read("workers/outreachEmailWorker.js");
    expect(routes).toContain("queueOutreachEmail");
    expect(worker).toContain("waitForDelay: true");
    expect(worker).toContain("concurrency: 1");
  });

  it("records per-platform attempts, provenance, stale failure, and terminal warning state", () => {
    const service = read("domains/prospects/prospect.service.js");
    for (const state of ["NOT_STARTED", "GENERATING", "VALIDATING", "RETRYING", "AI_ACCEPTED", "FALLBACK_ACCEPTED"]) expect(service).toContain(state);
    expect(service).toContain("STALE_RUN");
    expect(service).toContain("COMPLETE_WITH_WARNINGS");
  });

  it("distinguishes queued previews from actively generating previews and reconciles abandoned work", () => {
    const prospectService = read("domains/prospects/prospect.service.js");
    const outreachService = read("domains/prospects/outreach.service.js");
    expect(outreachService).toContain('status: "PREVIEW_PENDING"');
    expect(prospectService).toContain('data: { status: "PREVIEW_GENERATING", lastError: null }');
    expect(prospectService).toContain("staleQueuedBefore");
    expect(prospectService).toContain("staleRunningBefore");
    expect(outreachService).toContain("reconcileProspectPreparationRuns");
  });

  it("persists selected channels and derives generation and expected counts from them", () => {
    const schema = read("prisma/schema.prisma");
    const service = read("domains/prospects/prospect.service.js");
    expect(schema).toContain("selectedChannels  String[]");
    expect(service).toContain("expectedCount: selectedChannels.length");
    expect(service).toContain("for (const [channelIndex, channel] of selectedChannels.entries())");
    expect(service).toContain("listingSelections[channelIndex % listingSelections.length]");
    expect(service).toContain("dataItemId: item.id");
    expect(service).toContain("preferredChannels: normalizeProspectChannels(row.selectedChannels)");
    expect(service).not.toContain('for (const channel of ["INSTAGRAM", "FACEBOOK", "LINKEDIN"])');
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
    ["FACEBOOK", "A new property is now available", "Contact us to review the complete listing or schedule a showing.", []],
    ["LINKEDIN", "New property listing", "Contact the listing business for complete details and showing information.", ["RealEstate", "PropertyUpdate"]],
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

describe("Lakewood final copy assembly", () => {
  const item = { title: "203 Lakewood Lane", summary: "3 bed · 2 bath · 1,620 sqft · $285,000", dataJson: { street: "203 Lakewood Lane", city: "Georgetown", state: "OH", zip: "45121", price: 285000, bedrooms: 3, bathrooms: 2, sqft: 1620, yearBuilt: 1996 } };
  const drafts = {
    INSTAGRAM: { hooks: ["New listing in Georgetown"], body: "203 Lakewood Lane is listed at $285,000 with 3 bedrooms, 2 bathrooms, and 1,620 square feet. Built in 1996, browse the listing photos for a closer look.", cta: "Message us for details or to schedule a showing.", hashtags: ["Georgetown", "RealEstate", "Ohio", "JustListed"] },
    FACEBOOK: { hooks: ["Now available in Georgetown: 203 Lakewood Lane"], body: "The property is listed at $285,000 with 3 bedrooms, 2 bathrooms, and 1,620 square feet. It was built in 1996; browse the listing photos for a closer look.", cta: "Contact us for more information or to schedule a showing.", hashtags: [] },
    LINKEDIN: { hooks: ["New property listing in Georgetown, Ohio"], body: "203 Lakewood Lane is listed at $285,000 with 3 bedrooms, 2 bathrooms, and 1,620 square feet. The property was built in 1996.", cta: "Contact the listing business for complete details or showing information.", hashtags: ["RealEstate", "PropertyListing"] },
  };

  it("repairs the observed strict-attempt contract drift without admitting unsupported copy", () => {
    const raw = {
      hooks: ["A new property is now available."],
      body: "A new property is now available. This 3-bedroom, 2-bathroom home at 203 Lakewood Lane in Georgetown, OH offers 1,620 square feet of living space and was built in 1996. Priced at $285,000, it’s a great opportunity for those looking to settle in this vibrant community. Contact us to review the complete listing or schedule a showing.",
      cta: "Contact us to review the complete listing or schedule a showing.", hashtags: [],
    };
    const repaired = repairStructuredProspectDraft(raw, item);
    expect(repaired.body).not.toMatch(/great opportunity|vibrant community/i);
    expect(repaired.body).not.toContain(raw.hooks[0]);
    expect(repaired.body).not.toContain(raw.cta);
    expect(validateStructuredProspectDraft(repaired, item, "FACEBOOK")).toEqual({ valid: true });
  });

  it.each(Object.entries(drafts))("assembles one natural, valid %s hook, CTA, and hashtag block", (channel, draft) => {
    const body = composeStructuredProspectBody(draft, channel);
    expect(validateStructuredProspectDraft(draft, item, channel)).toEqual({ valid: true });
    expect(body.split(draft.hooks[0])).toHaveLength(2);
    expect(body.split(draft.cta)).toHaveLength(2);
    expect(body.split(/\n\s*\n/).filter((block) => block.startsWith("#"))).toHaveLength(channel === "FACEBOOK" ? 0 : 1);
    if (channel === "LINKEDIN") expect(body).not.toMatch(/current listing details|professionals and clients/i);
  });

  it.each([
    "New listing in Georgetown.\n\nNew listing in Georgetown.\n\n203 Lakewood Lane is listed at $285,000.\n\nContact us for details.",
    "Take a look at this new listing.\n\nTake a look at this newly available listing.\n\n203 Lakewood Lane is listed at $285,000.\n\nContact us for details.",
    "203 Lakewood Lane has 3 bedrooms, 2 bathrooms, and 1,620 sq ft.\n\nThis 3-bedroom, 2-bathroom property contains 1,620 sq ft.\n\nContact us for details.",
    "New listing: 203 Lakewood Lane.\n\nListed at $285,000.\n\nContact us for details.\n\nContact us for details.",
    "New listing: 203 Lakewood Lane.\n\nListed at $285,000.\n\nContact us for details.\n\n#JustListed #Ohio\n\n#JustListed #Ohio",
  ])("rejects duplicated post composition", (body) => {
    expect(validateProspectComposition(body)).toMatchObject({ valid: false, reason: "DUPLICATE_POST_COMPONENT" });
  });

  it("rejects unsupported condition claims but permits exact source-backed condition text", () => {
    const unsupported = { ...drafts.FACEBOOK, body: `${drafts.FACEBOOK.body} This well-maintained home is available now.` };
    expect(validateStructuredProspectDraft(unsupported, item, "FACEBOOK")).toMatchObject({ valid: false, reason: "UNSUPPORTED_PROPERTY_CLAIM" });
    const verified = { ...item, summary: `${item.summary}. Well-maintained.` };
    expect(validateGeneratedPropertyBody("Now available: 203 Lakewood Lane. This well-maintained property is listed at $285,000. Contact us for details or a showing.", verified)).toEqual({ valid: true });
  });

  it.each(["updated", "renovated", "move-in ready", "well cared for", "pristine", "immaculate"])("rejects unsupported %s condition language", (claim) => {
    expect(validateGeneratedPropertyBody(`Now available: 203 Lakewood Lane. This ${claim} property is listed at $285,000. Contact us for details or a showing.`, item)).toMatchObject({ valid: false, reason: "UNSUPPORTED_PROPERTY_CLAIM" });
  });
});
