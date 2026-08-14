import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

const db = { subscription: { findUnique: vi.fn(), upsert: vi.fn(), updateMany: vi.fn(), update: vi.fn() }, trialConsumption: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() } };
vi.mock("../prisma.js", () => ({ prisma: db }));
const billing = await import("../domains/billing/billing.service.js");

describe("14-day free trial", () => {
  beforeEach(() => vi.clearAllMocks());

  it("uses an additive legacy-safe migration", () => {
    const sql = readFileSync("prisma/migrations/20260814080000_subscription_free_trial/migration.sql", "utf8");
    expect(sql).not.toMatch(/DROP|DELETE FROM|TRUNCATE/i);
    expect(sql).toContain('ADD COLUMN "trialConsumedAt"');
  });

  it("creates a native no-card 14-day Pro trial once", async () => {
    const start = 2_000_000_000;
    const stripe = {
      customers: { create: vi.fn().mockResolvedValue({ id: "cus_trial" }) },
      subscriptions: {
        list: vi.fn().mockResolvedValue({ data: [] }),
        create: vi.fn().mockResolvedValue({ id: "sub_trial", trial_start: start, trial_end: start + 14 * 86400 }),
      },
    };
    db.subscription.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ userId: "new", stripeCustomerId: "cus_trial", stripeSubscriptionId: null, trialConsumedAt: null });
    db.trialConsumption.findUnique.mockResolvedValue(null);
    db.trialConsumption.create.mockResolvedValue({ id: "trial-ledger-1", userId: "new", state: "INITIATING" });
    db.trialConsumption.update.mockResolvedValue({});
    db.subscription.upsert.mockResolvedValue({});
    db.subscription.updateMany.mockResolvedValue({ count: 1 });
    db.subscription.update.mockResolvedValue({ status: "TRIALING", trialState: "ACTIVE" });
    await expect(billing.startFreeTrial({ userId: "new", email: "new@example.com", stripeClient: stripe, trialPriceId: "price_pro", now: new Date("2026-01-01") })).resolves.toMatchObject({ status: "TRIALING" });
    expect(stripe.subscriptions.create).toHaveBeenCalledWith(expect.objectContaining({
      trial_period_days: 14,
      trial_settings: { end_behavior: { missing_payment_method: "cancel" } },
      payment_settings: { save_default_payment_method: "on_subscription" },
      metadata: { userId: "new", tier: "PRO", squadpitchTrial: "true" },
    }), { idempotencyKey: "free-trial:new" });
  });

  it("rejects paid, consumed, and synthetic accounts", async () => {
    await expect(billing.startFreeTrial({ userId: "e2e", email: "e2e-user@squadpitch.com", stripeClient: {} })).rejects.toMatchObject({ code: "TRIAL_ACCOUNT_EXCLUDED" });
    db.trialConsumption.findUnique.mockResolvedValue(null);
    db.trialConsumption.create.mockResolvedValue({ id: "trial-ledger-paid", userId: "paid", state: "INITIATING" });
    db.subscription.findUnique.mockResolvedValue({ stripeCustomerId: "cus", stripeSubscriptionId: "sub_paid", trialConsumedAt: null });
    await expect(billing.startFreeTrial({ userId: "paid", email: "paid@example.com", stripeClient: { subscriptions: {} } })).rejects.toMatchObject({ code: "TRIAL_ALREADY_CONSUMED" });
    db.trialConsumption.findUnique.mockResolvedValue({ id: "old", userId: "deleted-account", state: "EXPIRED" });
    await expect(billing.startFreeTrial({ userId: "recreated-account", email: "same@example.com", stripeClient: {} })).rejects.toMatchObject({ code: "TRIAL_ALREADY_CONSUMED" });
  });

  it("expires trial entitlement locally even before a webhook arrives", () => {
    const sub = { stripeSubscriptionId: "sub_trial", status: "TRIALING", tier: "PRO", trialConsumedAt: new Date("2026-01-01"), trialEnd: new Date("2026-01-15") };
    expect(billing.getEffectiveTier(sub, null, new Date("2026-01-14"))).toBe("PRO");
    expect(billing.getEffectiveTier(sub, null, new Date("2026-01-15"))).toBe("FREE");
  });
});
