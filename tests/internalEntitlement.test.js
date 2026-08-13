import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { getEffectiveTier, getHighestInternalEntitlement } from "../domains/billing/billing.service.js";

const routes = readFileSync(new URL("../domains/billing/billing.routes.js", import.meta.url), "utf8");
const service = readFileSync(new URL("../domains/billing/billing.service.js", import.meta.url), "utf8");
const middleware = readFileSync(new URL("../middleware/requireTier.js", import.meta.url), "utf8");
const canary = readFileSync(new URL("../domains/canary/canary.service.js", import.meta.url), "utf8");

describe("internal workspace entitlement safety", () => {
  it("1. normal Free stays Free", () => {
    expect(getEffectiveTier(null, null)).toBe("FREE");
  });

  it("2. ordinary users cannot reach grant/revoke without the admin role", () => {
    expect(routes).toMatch(/internal-entitlements\/:clientId`[\s\S]*?requireAdminRole/);
    expect(routes.match(/internal-entitlements\/:clientId`[\s\S]*?requireAdminRole/g)).toHaveLength(2);
  });

  it("3. an active internal canary grant resolves to Pro", () => {
    expect(getEffectiveTier(null, { active: true, tier: "PRO" })).toBe("PRO");
  });

  it("4. internal Pro needs no Stripe subscription ID", () => {
    expect(getEffectiveTier({ stripeSubscriptionId: null, status: "ACTIVE", tier: "FREE" }, { active: true, tier: "PRO" })).toBe("PRO");
  });

  it("5. Stripe reconciliation cannot overwrite the separate grant record", () => {
    expect(service).not.toMatch(/internalEntitlement\.(?:update|upsert)[\s\S]{0,200}stripe/i);
  });

  it("6. revoke restores normal plan resolution", () => {
    expect(getEffectiveTier(null, { active: false, tier: "PRO" })).toBe("FREE");
  });

  it("8. normal paid Pro stays unchanged", () => {
    expect(getEffectiveTier({ stripeSubscriptionId: "opaque", status: "ACTIVE", tier: "PRO" })).toBe("PRO");
  });

  it("9. usage and canary checks use the effective workspace entitlement", () => {
    expect(service).toMatch(/getUsage\(userId, clientId = null\)[\s\S]*getEffectiveEntitlement\(userId, clientId\)/);
    expect(canary).toContain("getUsage(userId, workspaceId)");
    expect(middleware).toContain("getEffectiveEntitlement(req.user.id, clientId)");
  });

  it("10. entitlement resolution verifies immutable workspace ownership", () => {
    expect(service).toMatch(/where: \{ id: clientId, createdBy: user\.auth0Sub \}/);
  });

  it("11. account-level surfaces use the highest active owned workspace grant", () => {
    expect(getHighestInternalEntitlement([
      { active: false, tier: "AGENCY" },
      { active: true, tier: "STARTER" },
      { active: true, tier: "PRO" },
    ])).toMatchObject({ active: true, tier: "PRO" });
    expect(service).toMatch(/if \(!clientId\)[\s\S]*getAccountInternalEntitlement\(userId\)/);
    expect(service).toMatch(/checkClientLimit\(userId\)[\s\S]*getEffectiveEntitlement\(userId\)/);
  });
});
