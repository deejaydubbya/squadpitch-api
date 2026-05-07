// Billing-integrity regression tests.
//
// These guard the contract that "you only get a paid tier after Stripe
// confirms you paid". Specifically:
//   - creating a Stripe customer must NOT grant a paid tier
//   - a Subscription row without a stripeSubscriptionId must NOT grant a paid tier
//   - non-ACTIVE/TRIALING subs must fall back to FREE
//   - only verified webhook events can flip the tier
//   - monthly usage rolls over (last month's record does not count toward this month)

import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Stripe + Prisma mocks ───────────────────────────────────────────────
// Importing billing.service.js will instantiate Stripe; we stub it so no
// real network happens. Prisma is fully mocked so no DB is needed.

const stripeCustomersCreate = vi.fn();
const stripeCheckoutCreate = vi.fn();
const stripeSubscriptionsRetrieve = vi.fn();

vi.mock("stripe", () => {
  const Stripe = vi.fn().mockImplementation(() => ({
    customers: { create: stripeCustomersCreate },
    checkout: { sessions: { create: stripeCheckoutCreate } },
    subscriptions: { retrieve: stripeSubscriptionsRetrieve, update: vi.fn() },
    billingPortal: { sessions: { create: vi.fn() } },
    webhooks: { constructEvent: vi.fn() },
    prices: { retrieve: vi.fn() },
  }));
  return { default: Stripe };
});

// Force a non-empty STRIPE_SECRET_KEY so the service initialises Stripe.
// The mock is what actually runs.
vi.mock("../config/env.js", () => ({
  env: {
    STRIPE_SECRET_KEY: "sk_test_dummy",
    STRIPE_STARTER_PRICE_ID: "price_starter",
    STRIPE_PRO_PRICE_ID: "price_pro",
    STRIPE_GROWTH_PRICE_ID: "price_growth",
    STRIPE_AGENCY_PRICE_ID: "price_agency",
  },
}));

// In-memory subscription store the prisma mock reads/writes against.
const subStore = new Map();
const usageStore = new Map(); // key = `${userId}|${periodStartISO}`

const prismaMock = {
  subscription: {
    findUnique: vi.fn(async ({ where }) => {
      if (where.userId) return subStore.get(where.userId) ?? null;
      if (where.stripeSubscriptionId) {
        for (const v of subStore.values()) {
          if (v.stripeSubscriptionId === where.stripeSubscriptionId) return v;
        }
      }
      return null;
    }),
    upsert: vi.fn(async ({ where, create, update }) => {
      const existing = subStore.get(where.userId);
      const next = existing ? { ...existing, ...update } : { ...create };
      // Schema-level defaults — replicate them so tests accurately model
      // what Postgres will store. (`tier: STARTER`, `status: ACTIVE`.)
      if (!existing) {
        next.tier = next.tier ?? "STARTER";
        next.status = next.status ?? "ACTIVE";
        next.stripeSubscriptionId = next.stripeSubscriptionId ?? null;
      }
      subStore.set(where.userId, next);
      return next;
    }),
    update: vi.fn(async ({ where, data }) => {
      const existing = subStore.get(where.userId) ?? null;
      const next = existing ? { ...existing, ...data } : null;
      if (next) subStore.set(where.userId, next);
      return next;
    }),
    updateMany: vi.fn(async () => ({ count: 0 })),
  },
  usageRecord: {
    findUnique: vi.fn(async ({ where }) => {
      const key = `${where.userId_periodStart.userId}|${where.userId_periodStart.periodStart.toISOString()}`;
      return usageStore.get(key) ?? null;
    }),
    upsert: vi.fn(async ({ where, create, update }) => {
      const key = `${where.userId_periodStart.userId}|${where.userId_periodStart.periodStart.toISOString()}`;
      const existing = usageStore.get(key);
      const next = existing
        ? {
            ...existing,
            ...Object.fromEntries(
              Object.entries(update).map(([k, v]) =>
                v && typeof v === "object" && "increment" in v
                  ? [k, (existing[k] ?? 0) + v.increment]
                  : [k, v]
              )
            ),
          }
        : { ...create };
      usageStore.set(key, next);
      return next;
    }),
  },
  user: {
    findUnique: vi.fn(async () => ({ auth0Sub: "auth0|test" })),
  },
  client: {
    count: vi.fn(async () => 0),
  },
  mediaAsset: {
    aggregate: vi.fn(async () => ({ _sum: { bytes: 0 } })),
  },
};

vi.mock("../prisma.js", () => ({ prisma: prismaMock }));

const billing = await import("../domains/billing/billing.service.js");

beforeEach(() => {
  subStore.clear();
  usageStore.clear();
  stripeCustomersCreate.mockReset();
  stripeCheckoutCreate.mockReset();
  stripeSubscriptionsRetrieve.mockReset();
});

// ── getEffectiveTier — single source of truth ───────────────────────────

describe("getEffectiveTier — refuses paid tier without a real subscription", () => {
  const { getEffectiveTier } = billing;

  it("returns FREE when subscription is null", () => {
    expect(getEffectiveTier(null)).toBe("FREE");
    expect(getEffectiveTier(undefined)).toBe("FREE");
  });

  it("returns FREE when stripeSubscriptionId is missing (pre-checkout customer row)", () => {
    expect(
      getEffectiveTier({
        stripeCustomerId: "cus_x",
        stripeSubscriptionId: null,
        tier: "STARTER",
        status: "ACTIVE", // schema default — looks paid but isn't
      })
    ).toBe("FREE");
  });

  it("returns FREE when status is CANCELED or PAST_DUE", () => {
    for (const status of ["CANCELED", "PAST_DUE"]) {
      expect(
        getEffectiveTier({
          stripeSubscriptionId: "sub_x",
          tier: "PRO",
          status,
        })
      ).toBe("FREE");
    }
  });

  it("returns the tier when status is ACTIVE and stripeSubscriptionId is set", () => {
    expect(
      getEffectiveTier({
        stripeSubscriptionId: "sub_x",
        tier: "PRO",
        status: "ACTIVE",
      })
    ).toBe("PRO");
  });

  it("returns the tier during TRIALING", () => {
    expect(
      getEffectiveTier({
        stripeSubscriptionId: "sub_x",
        tier: "STARTER",
        status: "TRIALING",
      })
    ).toBe("STARTER");
  });

  it("returns FREE when tier is FREE-marked or unknown even with active sub", () => {
    expect(
      getEffectiveTier({ stripeSubscriptionId: "sub_x", tier: "FREE", status: "ACTIVE" })
    ).toBe("FREE");
    expect(
      getEffectiveTier({ stripeSubscriptionId: "sub_x", tier: "BOGUS", status: "ACTIVE" })
    ).toBe("FREE");
  });
});

// ── Abandoned checkout regression guard ─────────────────────────────────

describe("Abandoned checkout does not grant paid-tier limits", () => {
  it("getOrCreateCustomer creates a sub row but tier remains effectively FREE", async () => {
    stripeCustomersCreate.mockResolvedValue({ id: "cus_test" });

    await billing.getOrCreateCustomer("user-1", "u@example.com");

    const stored = subStore.get("user-1");
    expect(stored).toBeTruthy();
    expect(stored.stripeCustomerId).toBe("cus_test");
    // The contract: stripeSubscriptionId is null until checkout completes.
    expect(stored.stripeSubscriptionId ?? null).toBeNull();

    // Effective tier MUST be FREE — even though the row exists.
    expect(billing.getEffectiveTier(stored)).toBe("FREE");

    // And the live usage view should show FREE limits, not Solo limits.
    const usage = await billing.getUsage("user-1");
    expect(usage.tier).toBe("FREE");
    expect(usage.limits.posts).toBe(5); // FREE limit
  });

  it("createCheckoutSession does not flip the user to a paid tier", async () => {
    stripeCustomersCreate.mockResolvedValue({ id: "cus_test" });
    stripeCheckoutCreate.mockResolvedValue({ url: "https://stripe.test/session" });

    await billing.createCheckoutSession({
      userId: "user-1",
      email: "u@example.com",
      tier: "PRO",
      successUrl: "https://app/success",
      cancelUrl: "https://app/cancel",
    });

    const stored = subStore.get("user-1");
    expect(stored.stripeSubscriptionId ?? null).toBeNull();

    const usage = await billing.getUsage("user-1");
    expect(usage.tier).toBe("FREE");
  });
});

// ── Webhook activation (only this path may grant a paid tier) ──────────

describe("Stripe webhook is the only thing that grants a paid tier", () => {
  it("checkout.session.completed flips the row to ACTIVE + tier from metadata", async () => {
    // Pre-state: customer exists, no subscription yet.
    subStore.set("user-1", {
      userId: "user-1",
      stripeCustomerId: "cus_test",
      stripeSubscriptionId: null,
      tier: "STARTER",
      status: "ACTIVE",
    });

    stripeSubscriptionsRetrieve.mockResolvedValue({
      id: "sub_live",
      current_period_end: 1_800_000_000,
    });

    await billing.handleWebhookEvent({
      type: "checkout.session.completed",
      data: {
        object: {
          customer: "cus_test",
          subscription: "sub_live",
          metadata: { userId: "user-1", tier: "PRO" },
        },
      },
    });

    const after = subStore.get("user-1");
    expect(after.stripeSubscriptionId).toBe("sub_live");
    expect(after.tier).toBe("PRO");
    expect(after.status).toBe("ACTIVE");

    expect(billing.getEffectiveTier(after)).toBe("PRO");

    const usage = await billing.getUsage("user-1");
    expect(usage.tier).toBe("PRO");
    expect(usage.limits.posts).toBe(150); // PRO limit
  });
});

// ── Non-ACTIVE statuses fall back to FREE ──────────────────────────────

describe("Non-ACTIVE subscription falls back to FREE for limits", () => {
  it("PAST_DUE subscriber sees FREE limits", async () => {
    subStore.set("user-1", {
      userId: "user-1",
      stripeCustomerId: "cus_x",
      stripeSubscriptionId: "sub_x",
      tier: "PRO",
      status: "PAST_DUE",
    });
    const usage = await billing.getUsage("user-1");
    expect(usage.tier).toBe("FREE");
    expect(usage.limits.posts).toBe(5);
  });

  it("CANCELED subscriber sees FREE limits", async () => {
    subStore.set("user-1", {
      userId: "user-1",
      stripeCustomerId: "cus_x",
      stripeSubscriptionId: "sub_x",
      tier: "GROWTH",
      status: "CANCELED",
    });
    const usage = await billing.getUsage("user-1");
    expect(usage.tier).toBe("FREE");
    expect(usage.limits.posts).toBe(5);
  });
});

// ── Monthly usage does not carry into the next month ──────────────────

describe("Monthly usage period rollover", () => {
  it("a usage record from the previous month does not count against the current month", async () => {
    const now = new Date();
    const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 1);

    // Seed last month's UsageRecord at the cap.
    const key = `user-1|${lastMonthStart.toISOString()}`;
    usageStore.set(key, {
      userId: "user-1",
      periodStart: lastMonthStart,
      periodEnd: lastMonthEnd,
      posts: 999, // way over any cap
      images: 999,
      videos: 999,
      imageGenerations: 999,
      videoGenerations: 999,
      enhancementRuns: 999,
    });

    const usage = await billing.getUsage("user-1");

    // Current-month usage is empty — last month's row is in store but
    // not keyed to this period.
    expect(usage.usage.posts).toBe(0);
    expect(usage.usage.images).toBe(0);

    // checkUsageLimit must allow new actions even though last month was maxed.
    const allowed = await billing.checkUsageLimit("user-1", "posts");
    expect(allowed).toBe(true);
  });

  it("incrementUsage creates a new record for the current month", async () => {
    await billing.incrementUsage("user-1", "posts");
    const now = new Date();
    const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const key = `user-1|${periodStart.toISOString()}`;
    expect(usageStore.get(key)?.posts).toBe(1);
  });
});
