// Stripe webhook ordering / dedup tests for handleWebhookEvent.

import { describe, it, expect, vi, beforeEach } from "vitest";

const subStore = new Map();

const prismaMock = {
  subscription: {
    findUnique: vi.fn(async ({ where }) => {
      if (where.userId) return subStore.get(where.userId) ?? null;
      if (where.stripeSubscriptionId) {
        for (const s of subStore.values()) {
          if (s.stripeSubscriptionId === where.stripeSubscriptionId) return s;
        }
      }
      return null;
    }),
    upsert: vi.fn(async ({ where, create, update }) => {
      const existing = subStore.get(where.userId);
      const next = existing ? { ...existing, ...update } : { ...create };
      subStore.set(where.userId, next);
      return next;
    }),
    update: vi.fn(async ({ where, data }) => {
      const userId = where.userId;
      const sid = where.stripeSubscriptionId;
      let row;
      if (userId) row = subStore.get(userId);
      else if (sid) {
        for (const s of subStore.values())
          if (s.stripeSubscriptionId === sid) row = s;
      }
      if (!row) return null;
      Object.assign(row, data);
      return row;
    }),
    updateMany: vi.fn(async ({ where, data }) => {
      let count = 0;
      for (const s of subStore.values()) {
        if (
          where.stripeSubscriptionId &&
          s.stripeSubscriptionId === where.stripeSubscriptionId
        ) {
          Object.assign(s, data);
          count++;
        }
      }
      return { count };
    }),
  },
};

const stripeRetrieveMock = vi.fn();
vi.mock("stripe", () => ({
  default: vi.fn(function Stripe() {
    return {
      subscriptions: { retrieve: stripeRetrieveMock, update: vi.fn() },
      customers: { create: vi.fn() },
      checkout: { sessions: { create: vi.fn() } },
      billingPortal: { sessions: { create: vi.fn() } },
      webhooks: { constructEvent: vi.fn() },
      prices: { retrieve: vi.fn() },
    };
  }),
}));
vi.mock("../config/env.js", () => ({
  env: {
    STRIPE_SECRET_KEY: "sk_test_dummy",
    STRIPE_STARTER_PRICE_ID: "price_starter",
    STRIPE_PRO_PRICE_ID: "price_pro",
    STRIPE_GROWTH_PRICE_ID: "price_growth",
    STRIPE_AGENCY_PRICE_ID: "price_agency",
  },
}));
vi.mock("../prisma.js", () => ({ prisma: prismaMock }));

const billing = await import("../domains/billing/billing.service.js");

beforeEach(() => {
  subStore.clear();
  stripeRetrieveMock.mockReset();
});

describe("Stripe webhook ordering / dedup guard", () => {
  it("checkout.session.completed activates a subscription", async () => {
    stripeRetrieveMock.mockResolvedValue({
      id: "sub_live",
      status: "active",
      current_period_end: 2_000_000_000,
    });
    await billing.handleWebhookEvent({
      id: "evt_1",
      type: "checkout.session.completed",
      created: 1_000_000_000,
      data: {
        object: {
          customer: "cus_x",
          subscription: "sub_live",
          metadata: { userId: "u1", tier: "PRO" },
        },
      },
    });
    const after = subStore.get("u1");
    expect(after.tier).toBe("PRO");
    expect(after.status).toBe("ACTIVE");
    expect(after.lastStripeEventId).toBe("evt_1");
    expect(after.lastStripeEventCreated).toBe(1_000_000_000);
  });

  it("an OLDER subscription.deleted arriving after a NEWER subscription.updated is ignored", async () => {
    // Seed: tier was upgraded to PRO at t=2000.
    subStore.set("u1", {
      userId: "u1",
      stripeCustomerId: "cus_x",
      stripeSubscriptionId: "sub_live",
      tier: "PRO",
      status: "ACTIVE",
      lastStripeEventId: "evt_newer",
      lastStripeEventCreated: 2_000,
    });

    // Older delete event with created=1_500.
    await billing.handleWebhookEvent({
      id: "evt_older_delete",
      type: "customer.subscription.deleted",
      created: 1_500,
      data: { object: { id: "sub_live" } },
    });

    const after = subStore.get("u1");
    // Status must NOT be CANCELED — the stale event was ignored.
    expect(after.status).toBe("ACTIVE");
    expect(after.tier).toBe("PRO");
    expect(after.lastStripeEventId).toBe("evt_newer");
  });

  it("an OLDER invoice.payment_failed after a NEWER invoice.paid is ignored", async () => {
    subStore.set("u1", {
      userId: "u1",
      stripeCustomerId: "cus_x",
      stripeSubscriptionId: "sub_live",
      tier: "PRO",
      status: "ACTIVE",
      lastStripeEventId: "evt_paid",
      lastStripeEventCreated: 3_000,
    });

    await billing.handleWebhookEvent({
      id: "evt_failed_old",
      type: "invoice.payment_failed",
      created: 2_500,
      data: { object: { subscription: "sub_live" } },
    });

    expect(subStore.get("u1").status).toBe("ACTIVE");
  });

  it("duplicate event IDs are idempotent (skipped)", async () => {
    subStore.set("u1", {
      userId: "u1",
      stripeCustomerId: "cus_x",
      stripeSubscriptionId: "sub_live",
      tier: "PRO",
      status: "PAST_DUE",
      lastStripeEventId: "evt_paid_1",
      lastStripeEventCreated: 5_000,
    });

    await billing.handleWebhookEvent({
      id: "evt_paid_1", // same id we already processed
      type: "invoice.paid",
      created: 5_000,
      data: { object: { subscription: "sub_live" } },
    });

    // Status didn't change — duplicate was ignored.
    expect(subStore.get("u1").status).toBe("PAST_DUE");
  });

  it("a NEWER event AFTER stale ones still processes", async () => {
    subStore.set("u1", {
      userId: "u1",
      stripeCustomerId: "cus_x",
      stripeSubscriptionId: "sub_live",
      tier: "PRO",
      status: "ACTIVE",
      lastStripeEventId: "evt_a",
      lastStripeEventCreated: 1_000,
    });

    // Newer cancel: must apply.
    await billing.handleWebhookEvent({
      id: "evt_cancel",
      type: "customer.subscription.deleted",
      created: 2_000,
      data: { object: { id: "sub_live" } },
    });

    expect(subStore.get("u1").status).toBe("CANCELED");
    expect(subStore.get("u1").lastStripeEventId).toBe("evt_cancel");
  });

  it("applies past-due and recovery events in order", async () => {
    subStore.set("u1", {
      userId: "u1",
      stripeCustomerId: "cus_x",
      stripeSubscriptionId: "sub_live",
      tier: "PRO",
      status: "ACTIVE",
      lastStripeEventCreated: 1_000,
      lastStripeEventId: "evt_start",
    });

    await billing.handleWebhookEvent({
      id: "evt_past_due",
      type: "invoice.payment_failed",
      created: 2_000,
      data: { object: { subscription: "sub_live" } },
    });
    expect(subStore.get("u1").status).toBe("PAST_DUE");

    await billing.handleWebhookEvent({
      id: "evt_recovered",
      type: "invoice.paid",
      created: 3_000,
      data: { object: { subscription: "sub_live" } },
    });
    expect(subStore.get("u1").status).toBe("ACTIVE");
  });
});
