import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

vi.mock("../prisma.js", () => ({ prisma: {} }));

const tokens = await import("../domains/referrals/referral.tokens.js");
const service = await import("../domains/referrals/referral.service.js");

describe("agent referral persistence contract", () => {
  it("uses an additive migration with exactly-once constraints", () => {
    const sql = readFileSync("prisma/migrations/20260814050000_agent_referrals/migration.sql", "utf8");
    expect(sql).not.toMatch(/\b(DROP\s+(TABLE|TYPE)|DELETE\s+FROM|TRUNCATE\s+TABLE)\b/i);
    expect(sql).toContain('CREATE UNIQUE INDEX "referrals_referredUserId_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "referral_rewards_idempotencyKey_key"');
    expect(sql).toContain('CREATE UNIQUE INDEX "referral_rewards_stripeBalanceTransactionId_key"');
  });

  it("keeps every new table empty-compatible with legacy production rows", () => {
    const sql = readFileSync("prisma/migrations/20260814050000_agent_referrals/migration.sql", "utf8");
    expect(sql).not.toMatch(/ALTER TABLE\s+"(?:User|Client|Subscription)"/i);
    expect(sql).not.toMatch(/INSERT\s+INTO/i);
    expect((sql.match(/CREATE TABLE/g) ?? [])).toHaveLength(4);
  });

  it("mounts public capture before auth and private routes after auth", () => {
    const server = readFileSync("server.js", "utf8");
    expect(server.indexOf("app.use(referralPublicRouter)")).toBeLessThan(server.indexOf('app.use("/api"'));
    expect(server.indexOf("app.use(referralRouter)")).toBeGreaterThan(server.indexOf('app.use("/api"'));
  });
});

describe("referral identity and capture", () => {
  beforeEach(() => { process.env.OAUTH_STATE_SECRET = "test-referral-secret-with-sufficient-entropy"; });

  it("generates stable-format non-identity-derived codes", () => {
    const code = service.generateReferralCode(Buffer.from(Array.from({ length: 12 }, (_, index) => index)));
    expect(code).toMatch(/^[A-HJ-NP-Z2-9]{12}$/);
    expect(code).toHaveLength(12);
  });

  it("signs capture time and rejects tampering or expiry", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const token = tokens.issueReferralCapture("code-1", now);
    expect(tokens.verifyReferralCapture(token, new Date("2026-01-02T00:00:00Z"))).toMatchObject({ codeId: "code-1", capturedAt: now });
    expect(tokens.verifyReferralCapture(`${token}x`, now)).toBeNull();
    expect(tokens.verifyReferralCapture(token, new Date("2026-02-01T00:00:00Z"))).toBeNull();
  });

  it("attaches first-touch attribution once", async () => {
    const now = new Date("2026-01-02T00:00:00Z");
    const captureToken = tokens.issueReferralCapture("code-1", new Date("2026-01-01T23:59:00Z"));
    const create = vi.fn().mockResolvedValue({ id: "ref-1" });
    const db = { referral: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null), create }, referralCode: { findFirst: vi.fn().mockResolvedValue({ id: "code-1", ownerUserId: "owner-1", active: true }) }, user: { findUnique: vi.fn().mockResolvedValue({ email: "owner@example.com" }) }, subscription: { findUnique: vi.fn().mockResolvedValue(null) } };
    await expect(service.attachReferralAttribution({ captureToken, user: { id: "new-user", email: "new@example.com", createdAt: now }, now, prismaClient: db })).resolves.toEqual({ attached: true, idempotent: false });
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ referrerUserId: "owner-1", referredUserId: "new-user" }) });
  });

  it("rejects an inactive code and treats an attribution race as idempotent", async () => {
    const now = new Date("2026-01-02T00:00:00Z");
    const captureToken = tokens.issueReferralCapture("code-1", now);
    const db = { referral: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() }, referralCode: { findFirst: vi.fn().mockResolvedValue(null) }, user: { findUnique: vi.fn().mockResolvedValue({ email: "owner@example.com" }) }, subscription: { findUnique: vi.fn() } };
    await expect(service.attachReferralAttribution({ captureToken, user: { id: "new", email: "new@example.com", createdAt: now }, now, prismaClient: db })).rejects.toMatchObject({ code: "REFERRAL_CODE_INACTIVE" });
    db.referralCode.findFirst.mockResolvedValue({ id: "code-1", ownerUserId: "owner", active: true });
    db.subscription.findUnique.mockResolvedValue(null);
    db.referral.create.mockRejectedValue({ code: "P2002" });
    await expect(service.attachReferralAttribution({ captureToken, user: { id: "new", email: "new@example.com", createdAt: now }, now, prismaClient: db })).resolves.toEqual({ attached: true, idempotent: true });
  });

  it("blocks paid and synthetic accounts", async () => {
    const now = new Date("2026-01-02T00:00:00Z");
    const captureToken = tokens.issueReferralCapture("code-1", now);
    const db = { referral: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null) }, referralCode: { findFirst: vi.fn().mockResolvedValue({ id: "code-1", ownerUserId: "owner", active: true }) }, user: { findUnique: vi.fn().mockResolvedValue({ email: "owner@example.com" }) }, subscription: { findUnique: vi.fn().mockResolvedValue({ stripeSubscriptionId: "sub_paid" }) } };
    await expect(service.attachReferralAttribution({ captureToken, user: { id: "new", email: "new@example.com", createdAt: now }, now, prismaClient: db })).rejects.toMatchObject({ code: "REFERRAL_EXISTING_CUSTOMER" });
    await expect(service.attachReferralAttribution({ captureToken, user: { id: "new", email: "production-canary@squadpitch.com", createdAt: now }, now, prismaClient: db })).rejects.toMatchObject({ code: "REFERRAL_ACCOUNT_EXCLUDED" });
  });

  it("blocks self referrals and retroactive existing-account attribution", async () => {
    const now = new Date("2026-01-02T00:00:00Z");
    const captureToken = tokens.issueReferralCapture("code-1", now);
    const base = { referral: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null) }, referralCode: { findFirst: vi.fn().mockResolvedValue({ id: "code-1", ownerUserId: "same", active: true }) }, user: { findUnique: vi.fn().mockResolvedValue({ email: "owner@example.com" }) }, subscription: { findUnique: vi.fn() } };
    await expect(service.attachReferralAttribution({ captureToken, user: { id: "same", email: "person@example.com", createdAt: now }, now, prismaClient: base })).rejects.toMatchObject({ code: "SELF_REFERRAL" });
    base.referralCode.findFirst.mockResolvedValue({ id: "code-1", ownerUserId: "owner", active: true });
    await expect(service.attachReferralAttribution({ captureToken, user: { id: "old", email: "old@example.com", createdAt: new Date("2025-12-01") }, now, prismaClient: base })).rejects.toMatchObject({ code: "REFERRAL_EXISTING_ACCOUNT" });
  });

  it("allows only the dedicated E2E user to own a code without synthetic attribution", async () => {
    const referralCode = { findUnique: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({ code: "ABCDEFGH2345" }) };
    await expect(service.getOrCreateReferralCode({ id: "e2e", email: "e2e-user@squadpitch.com" }, { referralCode })).resolves.toMatchObject({ code: "ABCDEFGH2345" });
    await expect(service.getOrCreateReferralCode({ id: "admin", email: "e2e-admin@squadpitch.com" }, { referralCode })).rejects.toMatchObject({ code: "REFERRAL_ACCOUNT_EXCLUDED" });

    const now = new Date("2026-01-02T00:00:00Z");
    const captureToken = tokens.issueReferralCapture("code-e2e", now);
    const db = { referral: { findUnique: vi.fn().mockResolvedValue(null) }, referralCode: { findFirst: vi.fn().mockResolvedValue({ id: "code-e2e", ownerUserId: "e2e", active: true }) }, user: { findUnique: vi.fn().mockResolvedValue({ email: "e2e-user@squadpitch.com" }) } };
    await expect(service.attachReferralAttribution({ captureToken, user: { id: "real-user", email: "real@example.com", createdAt: now }, now, prismaClient: db })).rejects.toMatchObject({ code: "REFERRAL_OWNER_EXCLUDED" });
  });
});

describe("referral billing lifecycle", () => {
  function eventDb() {
    const update = vi.fn().mockResolvedValue({});
    return { subscription: { findUnique: vi.fn().mockResolvedValue({ userId: "referred" }) }, referral: { findUnique: vi.fn().mockResolvedValue({ id: "ref-1", status: "ATTRIBUTED", paidAt: null, qualifyingSince: null, qualifiesAt: null, stripeConversionEventId: null }), update }, referralStripeEvent: {}, $transaction: vi.fn(async (callback) => callback({ referralStripeEvent: { create: vi.fn() }, referral: { update } })) };
  }

  it("starts exactly 14 days from invoice payment truth", async () => {
    const db = eventDb();
    const now = new Date("2026-01-01T00:00:00Z");
    await service.handleReferralStripeEvent({ id: "evt_paid", type: "invoice.paid", created: now.getTime() / 1000, data: { object: { subscription: "sub_1" } } }, { now, prismaClient: db });
    expect(db.referral.update).toHaveBeenCalledWith({ where: { id: "ref-1" }, data: expect.objectContaining({ status: "QUALIFYING", qualifyingSince: now, qualifiesAt: new Date("2026-01-15T00:00:00Z") }) });
  });

  it("deduplicates repeated Stripe webhook delivery", async () => {
    const db = eventDb();
    db.$transaction.mockRejectedValue({ code: "P2002" });
    await expect(service.handleReferralStripeEvent({ id: "evt_same", type: "invoice.paid", data: { object: { subscription: "sub_1" } } }, { prismaClient: db })).resolves.toEqual({ duplicate: true });
  });

  it("resolves disputes through the Stripe charge customer", async () => {
    const db = eventDb();
    const stripe = { charges: { retrieve: vi.fn().mockResolvedValue({ customer: "cus_1" }) } };
    await service.handleReferralStripeEvent({ id: "evt_dispute", type: "charge.dispute.created", data: { object: { charge: "ch_1" } } }, { prismaClient: db, stripe });
    expect(stripe.charges.retrieve).toHaveBeenCalledWith("ch_1");
    expect(db.referral.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "DISQUALIFIED" }) }));
  });

  it.each(["invoice.payment_failed", "customer.subscription.deleted", "charge.refunded", "charge.dispute.created"])("disqualifies on %s before qualification", async (type) => {
    const db = eventDb();
    await service.handleReferralStripeEvent({ id: `evt_${type}`, type, data: { object: type.startsWith("customer.subscription") ? { id: "sub_1", status: "canceled" } : { customer: "cus_1" } } }, { prismaClient: db });
    expect(db.referral.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: "DISQUALIFIED", disqualificationReason: type }) }));
  });

  it("grants a negative 5900-cent Stripe balance transaction exactly once", async () => {
    const stripe = { customers: { createBalanceTransaction: vi.fn().mockResolvedValue({ id: "cbtxn_1" }) } };
    const reward = { id: "reward-1", referralId: "ref-1", status: "PENDING", idempotencyKey: "referral-credit:ref-1", referral: { id: "ref-1", referrerUserId: "owner" } };
    const rewardUpdate = vi.fn().mockResolvedValue({ ...reward, status: "GRANTED" });
    const db = { referralReward: { findUnique: vi.fn().mockResolvedValue(reward), update: rewardUpdate }, referral: { update: vi.fn() }, user: { findUnique: vi.fn().mockResolvedValue({ id: "owner" }) }, subscription: { findUnique: vi.fn().mockResolvedValue({ stripeCustomerId: "cus_owner" }) }, $transaction: vi.fn(async (callback) => callback({ referralReward: { update: rewardUpdate }, referral: { update: vi.fn() } })) };
    await service.grantReferralReward("reward-1", { stripe, prismaClient: db, now: new Date("2026-01-15") });
    expect(stripe.customers.createBalanceTransaction).toHaveBeenCalledWith("cus_owner", expect.objectContaining({ amount: -5900, currency: "usd", metadata: { referralId: "ref-1", rewardId: "reward-1" } }), { idempotencyKey: "referral-credit:ref-1" });
  });

  it("creates a traceable Stripe customer for a free referrer", async () => {
    const stripe = { customers: { create: vi.fn().mockResolvedValue({ id: "cus_new" }), createBalanceTransaction: vi.fn().mockResolvedValue({ id: "cbtxn_1" }) } };
    const reward = { id: "reward-1", referralId: "ref-1", status: "PENDING", idempotencyKey: "referral-credit:ref-1", referral: { referrerUserId: "owner" } };
    const rewardUpdate = vi.fn().mockResolvedValue(reward);
    const db = { referralReward: { findUnique: vi.fn().mockResolvedValue(reward), update: rewardUpdate }, user: { findUnique: vi.fn().mockResolvedValue({ id: "owner", email: "owner@example.com" }) }, subscription: { findUnique: vi.fn().mockResolvedValue(null), upsert: vi.fn().mockResolvedValue({ stripeCustomerId: "cus_new" }) }, $transaction: vi.fn(async (fn) => fn({ referralReward: { update: rewardUpdate }, referral: { update: vi.fn() } })) };
    await service.grantReferralReward("reward-1", { stripe, prismaClient: db });
    expect(stripe.customers.create).toHaveBeenCalledWith(expect.objectContaining({ metadata: { userId: "owner", purpose: "referral-credit" } }), { idempotencyKey: "referral-customer:owner" });
    expect(stripe.customers.createBalanceTransaction).toHaveBeenCalledWith("cus_new", expect.objectContaining({ amount: -5900 }), expect.any(Object));
  });

  it("retries local persistence after Stripe success with the same idempotency key", async () => {
    const stripe = { customers: { createBalanceTransaction: vi.fn().mockResolvedValue({ id: "cbtxn_same" }) } };
    const reward = { id: "reward-1", referralId: "ref-1", status: "FAILED", idempotencyKey: "referral-credit:ref-1", referral: { referrerUserId: "owner" } };
    const db = { referralReward: { findUnique: vi.fn().mockResolvedValue(reward), update: vi.fn().mockResolvedValue(reward) }, user: { findUnique: vi.fn().mockResolvedValue({ id: "owner" }) }, subscription: { findUnique: vi.fn().mockResolvedValue({ stripeCustomerId: "cus_owner" }) }, $transaction: vi.fn().mockRejectedValueOnce(new Error("db unavailable")).mockImplementationOnce(async (fn) => fn({ referralReward: { update: vi.fn() }, referral: { update: vi.fn() } })) };
    await expect(service.grantReferralReward("reward-1", { stripe, prismaClient: db })).rejects.toThrow("db unavailable");
    await expect(service.grantReferralReward("reward-1", { stripe, prismaClient: db })).resolves.toMatchObject({ granted: true });
    expect(stripe.customers.createBalanceTransaction.mock.calls[0][2]).toEqual(stripe.customers.createBalanceTransaction.mock.calls[1][2]);
  });

  it("does not qualify at 13d23h59m and qualifies at exactly 14d", async () => {
    const referral = { id: "ref-1", referredUserId: "referred" };
    const db = { referral: { findMany: vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([referral]) }, subscription: { findUnique: vi.fn().mockResolvedValue({ stripeSubscriptionId: "sub_1", status: "ACTIVE", cancelAtPeriodEnd: false }) }, referralReward: { upsert: vi.fn().mockResolvedValue({ id: "reward-1" }) } };
    await expect(service.processDueReferralRewards({ prismaClient: db, now: new Date("2026-01-14T23:59:00Z") })).resolves.toEqual([]);
    await expect(service.processDueReferralRewards({ prismaClient: db, now: new Date("2026-01-15T00:00:00Z") })).resolves.toEqual([{ referralId: "ref-1", status: "PENDING_MANUAL_ENABLEMENT" }]);
  });

  it("does not call Stripe while production reward enablement is off", async () => {
    delete process.env.REFERRAL_REWARDS_ENABLED;
    const stripe = { customers: { createBalanceTransaction: vi.fn() } };
    const db = { referral: { findMany: vi.fn().mockResolvedValue([{ id: "ref-1", referredUserId: "referred" }]) }, subscription: { findUnique: vi.fn().mockResolvedValue({ stripeSubscriptionId: "sub_1", status: "ACTIVE", cancelAtPeriodEnd: false }) }, referralReward: { upsert: vi.fn().mockResolvedValue({ id: "reward-1" }) } };
    const result = await service.processDueReferralRewards({ prismaClient: db, now: new Date("2026-01-15") });
    expect(result).toEqual([{ referralId: "ref-1", status: "PENDING_MANUAL_ENABLEMENT" }]);
    expect(stripe.customers.createBalanceTransaction).not.toHaveBeenCalled();
  });
});
