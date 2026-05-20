// industry-02 — sites/page generation must NOT inject real-estate
// fabrication rules into prompts for no-industry or non-RE
// workspaces. Before this split, the system prompt was telling
// restaurant owners "do not invent school districts" — nonsense
// for their domain.

import { describe, it, expect } from "vitest";
import { buildSystemPrompt } from "../domains/sites/sites.generation.service.js";

function buildCtx(industryKey) {
  return {
    client: { name: "Test Workspace", industryKey },
    voice: null,
    brand: null,
  };
}

describe("sites.generation buildSystemPrompt — industry-aware grounding rules", () => {
  it("real_estate prompt includes the real-estate fabrication rules", () => {
    const prompt = buildSystemPrompt({
      ctx: buildCtx("real_estate"),
      pageGoal: "LEAD_CAPTURE",
      template: null,
    });
    expect(prompt).toContain("school ratings, school districts");
    expect(prompt).toContain("market statistics");
    expect(prompt).toContain("walkability");
    expect(prompt).toContain("mortgage rates");
    // Also includes the neutral baseline rules:
    expect(prompt).toContain("prices, fees, or financial terms");
  });

  it("null industry prompt does NOT include real-estate fabrication rules", () => {
    const prompt = buildSystemPrompt({
      ctx: buildCtx(null),
      pageGoal: "LEAD_CAPTURE",
      template: null,
    });
    expect(prompt).not.toContain("school ratings");
    expect(prompt).not.toContain("school districts");
    expect(prompt).not.toContain("walkability");
    expect(prompt).not.toContain("mortgage rates");
    expect(prompt).not.toContain("MLS");
    expect(prompt).not.toContain("median price, days on market");
    // Still has the neutral baseline so the LLM doesn't invent prices.
    expect(prompt).toContain("prices, fees, or financial terms");
  });

  it("car_sales industry (placeholder vertical) does NOT include real-estate rules", () => {
    const prompt = buildSystemPrompt({
      ctx: buildCtx("car_sales"),
      pageGoal: "LEAD_CAPTURE",
      template: null,
    });
    expect(prompt).not.toContain("school ratings");
    expect(prompt).not.toContain("mortgage rates");
    expect(prompt).not.toContain("days on market");
    expect(prompt).toContain("prices, fees, or financial terms");
  });

  it("industryName shows in the lead sentence only when industryKey is set", () => {
    const withRe = buildSystemPrompt({
      ctx: buildCtx("real_estate"),
      pageGoal: "LEAD_CAPTURE",
      template: null,
    });
    expect(withRe).toMatch(/industry: real_estate/);

    const withNull = buildSystemPrompt({
      ctx: buildCtx(null),
      pageGoal: "LEAD_CAPTURE",
      template: null,
    });
    expect(withNull).not.toMatch(/industry:/);
  });
});
