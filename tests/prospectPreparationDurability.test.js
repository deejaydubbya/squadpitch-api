import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { validateGeneratedPropertyBody } from "../domains/prospects/prospect.service.js";

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
