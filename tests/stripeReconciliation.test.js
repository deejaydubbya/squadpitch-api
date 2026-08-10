import { describe, expect, it } from "vitest";

import {
  assertRestrictedLiveKey,
  reconcileStripeBilling,
} from "../scripts/stripe-reconciliation/reconcile.js";
import { assertReadOnlySource } from "../scripts/stripe-reconciliation/safety.js";

const periodEnd = 1_800_000_000;

function local(overrides = {}) {
  return {
    userId: "user-sensitive-1",
    stripeCustomerId: "cus_sensitive_1",
    stripeSubscriptionId: "sub_sensitive_1",
    tier: "STARTER",
    status: "ACTIVE",
    cancelAtPeriodEnd: false,
    currentPeriodEnd: new Date(periodEnd * 1000),
    lastStripeEventId: "evt_sensitive_1",
    lastStripeEventCreated: 1_700_000_000,
    ...overrides,
  };
}

function subscription(overrides = {}) {
  return {
    id: "sub_sensitive_1",
    customer: "cus_sensitive_1",
    status: "active",
    cancel_at_period_end: false,
    current_period_end: periodEnd,
    metadata: { userId: "user-sensitive-1" },
    items: {
      data: [{ price: { id: "price_start" }, current_period_end: periodEnd }],
    },
    ...overrides,
  };
}

function customer(overrides = {}) {
  return {
    id: "cus_sensitive_1",
    metadata: { userId: "user-sensitive-1" },
    ...overrides,
  };
}

function resourceMissing() {
  return Object.assign(new Error("missing"), { code: "resource_missing" });
}

function adapter(overrides = {}) {
  const sub = subscription();
  return {
    retrieveCustomer: async () => customer(),
    retrieveSubscription: async () => sub,
    listSubscriptions: async () => [sub],
    retrievePrice: async () => ({ id: "price_start", product: "prod_start" }),
    retrieveProduct: async () => ({ id: "prod_start" }),
    listRecentEvents: async () => ({ data: [] }),
    ...overrides,
  };
}

const catalog = {
  entries: [
    { tier: "STARTER", priceId: "price_start", productId: "prod_start" },
  ],
  priceToTier: { price_start: "STARTER" },
};

async function run(rows = [local()], stripe = adapter()) {
  return reconcileStripeBilling({ localRows: rows, catalog, stripe });
}

describe("Stripe DR reconciliation", () => {
  it("reports fully matching billing state", async () => {
    const report = await run();
    expect(report.reconciliation).toMatchObject({
      exactMatches: 1,
      mismatches: 0,
      orphans: 0,
    });
    expect(report.reconstructability).toMatchObject({
      automaticallyReconstructable: 1,
      manualReviewRequired: 0,
    });
  });

  it("detects a status mismatch", async () => {
    const report = await run([local({ status: "PAST_DUE" })]);
    expect(report.reconciliation.mismatchCounts.status).toBe(1);
  });

  it("detects a price/tier mismatch", async () => {
    const report = await run([local({ tier: "PRO" })]);
    expect(report.reconciliation.mismatchCounts.priceTier).toBe(1);
  });

  it("detects a cancellation mismatch", async () => {
    const report = await run([local({ cancelAtPeriodEnd: true })]);
    expect(report.reconciliation.mismatchCounts.cancellation).toBe(1);
  });

  it("detects a period mismatch", async () => {
    const report = await run([
      local({ currentPeriodEnd: new Date((periodEnd + 60) * 1000) }),
    ]);
    expect(report.reconciliation.mismatchCounts.period).toBe(1);
  });

  it("detects a missing Stripe customer", async () => {
    const report = await run(
      [local()],
      adapter({
        retrieveCustomer: async () => {
          throw resourceMissing();
        },
      }),
    );
    expect(report.reconciliation.mismatchCounts.missingCustomer).toBe(1);
  });

  it("detects a missing Stripe subscription", async () => {
    const report = await run(
      [local()],
      adapter({
        retrieveSubscription: async () => {
          throw resourceMissing();
        },
        listSubscriptions: async () => [],
      }),
    );
    expect(report.reconciliation.mismatchCounts.missingSubscription).toBe(1);
  });

  it("detects duplicate local ownership", async () => {
    const duplicate = local({ userId: "user-sensitive-2" });
    const report = await run([local(), duplicate]);
    expect(report.reconciliation.duplicateOwnership).toBeGreaterThan(0);
  });

  it("detects an active Stripe orphan for a known customer", async () => {
    const orphan = subscription({ id: "sub_sensitive_orphan" });
    const report = await run(
      [local()],
      adapter({ listSubscriptions: async () => [subscription(), orphan] }),
    );
    expect(report.reconciliation.orphans).toBe(1);
  });

  it("requires manual review when ownership metadata is missing", async () => {
    const bareSub = subscription({ metadata: {} });
    const report = await run(
      [local()],
      adapter({
        retrieveCustomer: async () => customer({ metadata: {} }),
        retrieveSubscription: async () => bareSub,
        listSubscriptions: async () => [bareSub],
      }),
    );
    expect(report.reconstructability).toMatchObject({
      manualReviewRequired: 1,
      ownershipMetadataSufficient: "no",
    });
  });

  it("requires manual review when ownership metadata is ambiguous", async () => {
    const conflicting = subscription({
      metadata: { userId: "different-user" },
    });
    const report = await run(
      [local()],
      adapter({
        retrieveSubscription: async () => conflicting,
        listSubscriptions: async () => [conflicting],
      }),
    );
    expect(report.reconstructability).toMatchObject({
      manualReviewRequired: 1,
      ambiguousOwnership: 1,
    });
  });

  it("detects incoherent local event markers", async () => {
    const report = await run([local({ lastStripeEventCreated: null })]);
    expect(report.reconciliation.eventMarkerIncoherent).toBe(1);
  });

  it("accepts only the restricted live credential path", () => {
    expect(() => assertRestrictedLiveKey("rk_live_synthetic")).not.toThrow();
    expect(() => assertRestrictedLiveKey("sk_live_synthetic")).toThrow();
    expect(() => assertRestrictedLiveKey("rk_test_synthetic")).toThrow();
  });

  it("has no unrestricted-key fallback in the execution path", async () => {
    const source = await import("node:fs/promises").then(({ readFile }) =>
      readFile(
        new URL("../scripts/stripe-reconciliation/index.js", import.meta.url),
        "utf8",
      ),
    );
    expect(source).not.toContain("STRIPE_SECRET_KEY");
  });

  it("rejects mutation methods in the static safety guard", () => {
    expect(() => assertReadOnlySource("client.customers.create({})")).toThrow();
    expect(() =>
      assertReadOnlySource("prisma.subscription.update({})"),
    ).toThrow();
    expect(() =>
      assertReadOnlySource("client.customers.retrieve('x')"),
    ).not.toThrow();
  });

  it("sanitizes raw identifiers and metadata values", async () => {
    const report = await run([local({ status: "PAST_DUE" })]);
    const output = JSON.stringify(report);
    for (const sensitive of [
      "user-sensitive-1",
      "cus_sensitive_1",
      "sub_sensitive_1",
      "evt_sensitive_1",
    ]) {
      expect(output).not.toContain(sensitive);
    }
    expect(report.reconciliation.mismatchRefs[0].ref).toMatch(/^[a-f0-9]{12}$/);
  });

  it("fails catalog and event checks without exposing provider errors", async () => {
    const report = await run(
      [local()],
      adapter({
        retrievePrice: async () => {
          throw new Error("raw provider payload");
        },
        listRecentEvents: async () => {
          throw new Error("raw event payload");
        },
      }),
    );
    expect(report.reconciliation.catalogMapping).toBe("FAIL");
    expect(report.reconciliation.recentEventsAccess).toBe("FAIL");
    expect(JSON.stringify(report)).not.toContain("raw provider payload");
  });
});
