// Pricing-constant lock-in tests.
//
// If anyone changes these values without updating the Stripe products in
// the dashboard, customers see different prices on the landing page than
// what they're charged. Lock the contract here.

import { describe, it, expect } from "vitest";
import {
  PLAN_TIERS,
  PAID_TIERS,
  SELF_SERVICE_TIERS,
  TIER_ORDER,
  getLimitsForTier,
  getTierRank,
  normalizeSelfServiceTier,
} from "../domains/billing/billing.constants.js";

describe("PLAN_TIERS — pricing matches the launch contract", () => {
  it("FREE is $0", () => {
    expect(PLAN_TIERS.FREE.priceMonthly).toBe(0);
    expect(PLAN_TIERS.FREE.label).toBe("Free");
  });

  it("STARTER (Solo) is $29/mo and shown as 'Solo'", () => {
    expect(PLAN_TIERS.STARTER.priceMonthly).toBe(2900);
    expect(PLAN_TIERS.STARTER.label).toBe("Solo");
    // Reviewer trip-wire: do NOT show "Starter" to users.
    expect(PLAN_TIERS.STARTER.label).not.toBe("Starter");
  });

  it("PRO is $59/mo", () => {
    expect(PLAN_TIERS.PRO.priceMonthly).toBe(5900);
    expect(PLAN_TIERS.PRO.label).toBe("Pro");
  });

  it("GROWTH (Team) is $149/mo and shown as 'Team'", () => {
    expect(PLAN_TIERS.GROWTH.priceMonthly).toBe(14900);
    expect(PLAN_TIERS.GROWTH.label).toBe("Team");
    expect(PLAN_TIERS.GROWTH.label).not.toBe("Growth");
  });

  it("AGENCY is $299/mo", () => {
    expect(PLAN_TIERS.AGENCY.priceMonthly).toBe(29900);
    expect(PLAN_TIERS.AGENCY.label).toBe("Agency");
  });
});

describe("Tier helpers", () => {
  it("PAID_TIERS lists the four billable tiers (FREE excluded)", () => {
    expect(PAID_TIERS).toEqual(["STARTER", "PRO", "GROWTH", "AGENCY"]);
    expect(PAID_TIERS).not.toContain("FREE");
  });

  it("keeps Agency internal and normalizes public plan aliases", () => {
    expect(SELF_SERVICE_TIERS).toEqual(["STARTER", "PRO", "GROWTH"]);
    expect(normalizeSelfServiceTier("SOLO")).toBe("STARTER");
    expect(normalizeSelfServiceTier("starter")).toBe("STARTER");
    expect(normalizeSelfServiceTier("PRO")).toBe("PRO");
    expect(normalizeSelfServiceTier("TEAM")).toBe("GROWTH");
    expect(normalizeSelfServiceTier("growth")).toBe("GROWTH");
    expect(normalizeSelfServiceTier("AGENCY")).toBeNull();
    expect(normalizeSelfServiceTier("price_123")).toBeNull();
  });

  it("TIER_ORDER ranks lowest → highest", () => {
    expect(TIER_ORDER).toEqual(["FREE", "STARTER", "PRO", "GROWTH", "AGENCY"]);
    expect(getTierRank("FREE")).toBe(0);
    expect(getTierRank("AGENCY")).toBe(4);
    expect(getTierRank("UNKNOWN")).toBe(0);
  });

  it("getLimitsForTier falls back to FREE for unknown tier strings", () => {
    expect(getLimitsForTier("DOES_NOT_EXIST")).toEqual(PLAN_TIERS.FREE.limits);
    expect(getLimitsForTier(undefined)).toEqual(PLAN_TIERS.FREE.limits);
  });

  it("Each paid tier has strictly more posts/mo than the one below it", () => {
    let prev = PLAN_TIERS.FREE.limits.posts;
    for (const tier of PAID_TIERS) {
      const cur = PLAN_TIERS[tier].limits.posts;
      expect(cur).toBeGreaterThan(prev);
      prev = cur;
    }
  });
});
