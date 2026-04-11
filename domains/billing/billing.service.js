import Stripe from "stripe";
import { env } from "../../config/env.js";
import { prisma } from "../../prisma.js";
import { getLimitsForTier } from "./billing.constants.js";

const stripe = env.STRIPE_SECRET_KEY
  ? new Stripe(env.STRIPE_SECRET_KEY)
  : null;

function requireStripe() {
  if (!stripe) throw Object.assign(new Error("Stripe not configured"), { status: 503 });
  return stripe;
}

const TIER_PRICE_MAP = {
  STARTER: env.STRIPE_STARTER_PRICE_ID,
  GROWTH: env.STRIPE_GROWTH_PRICE_ID,
  PRO: env.STRIPE_PRO_PRICE_ID,
};

// ── Customer management ──────────────────────────────────────────────────

export async function getOrCreateCustomer(userId, email) {
  const s = requireStripe();
  const existing = await prisma.subscription.findUnique({ where: { userId } });
  if (existing?.stripeCustomerId) return existing.stripeCustomerId;

  const customer = await s.customers.create({
    email,
    metadata: { userId },
  });

  await prisma.subscription.upsert({
    where: { userId },
    create: {
      userId,
      stripeCustomerId: customer.id,
      tier: "STARTER",
      status: "TRIALING",
    },
    update: { stripeCustomerId: customer.id },
  });

  return customer.id;
}

// ── Checkout ─────────────────────────────────────────────────────────────

export async function createCheckoutSession({ userId, email, tier, successUrl, cancelUrl }) {
  const s = requireStripe();
  const customerId = await getOrCreateCustomer(userId, email);
  const priceId = TIER_PRICE_MAP[tier];
  if (!priceId) throw Object.assign(new Error(`No price configured for tier: ${tier}`), { status: 400 });

  const session = await s.checkout.sessions.create({
    customer: customerId,
    mode: "subscription",
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: successUrl,
    cancel_url: cancelUrl,
    metadata: { userId, tier },
  });

  return { url: session.url };
}

// ── Portal ───────────────────────────────────────────────────────────────

export async function createPortalSession({ userId, returnUrl }) {
  const s = requireStripe();
  const sub = await prisma.subscription.findUnique({ where: { userId } });
  if (!sub?.stripeCustomerId) {
    throw Object.assign(new Error("No subscription found"), { status: 404 });
  }

  const session = await s.billingPortal.sessions.create({
    customer: sub.stripeCustomerId,
    return_url: returnUrl,
  });

  return { url: session.url };
}

// ── Subscription ─────────────────────────────────────────────────────────

export async function getSubscription(userId) {
  return prisma.subscription.findUnique({ where: { userId } });
}

// ── Usage ────────────────────────────────────────────────────────────────

export async function getUsage(userId) {
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const record = await prisma.usageRecord.findUnique({
    where: { userId_periodStart: { userId, periodStart } },
  });

  const sub = await prisma.subscription.findUnique({ where: { userId } });
  const limits = getLimitsForTier(sub?.tier ?? "STARTER");

  return {
    period: { start: periodStart, end: periodEnd },
    usage: {
      posts: record?.posts ?? 0,
      images: record?.images ?? 0,
      videos: record?.videos ?? 0,
    },
    limits,
    tier: sub?.tier ?? "STARTER",
  };
}

export async function incrementUsage(userId, field) {
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  await prisma.usageRecord.upsert({
    where: { userId_periodStart: { userId, periodStart } },
    create: { userId, periodStart, periodEnd, [field]: 1 },
    update: { [field]: { increment: 1 } },
  });
}

/**
 * Check if usage just crossed the 80% threshold for a field.
 * Returns { nearing: true, field, current, limit, tier } or null.
 */
export async function checkUsageNearing(userId, field) {
  const { usage, limits, tier } = await getUsage(userId);
  const current = usage[field] ?? 0;
  const limit = limits[field] ?? Infinity;
  if (limit === Infinity) return null;
  const pct = current / limit;
  // Fire at exactly 80% or 90% thresholds
  if (pct >= 0.8) {
    return { nearing: true, field, current, limit, tier };
  }
  return null;
}

export async function checkUsageLimit(userId, field) {
  const { usage, limits } = await getUsage(userId);
  const current = usage[field] ?? 0;
  const limit = limits[field] ?? Infinity;
  if (limit === Infinity) return true;
  return current < limit;
}

// ── Webhook ──────────────────────────────────────────────────────────────

export async function handleWebhookEvent(event) {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const { userId, tier } = session.metadata;
      if (!userId) break;

      const subscriptionId = session.subscription;
      const s = requireStripe();
      const sub = await s.subscriptions.retrieve(subscriptionId);

      // current_period_end moved to items in newer Stripe API versions
      const periodEnd = sub.current_period_end
        ?? sub.items?.data?.[0]?.current_period_end;

      await prisma.subscription.upsert({
        where: { userId },
        create: {
          userId,
          stripeCustomerId: session.customer,
          stripeSubscriptionId: subscriptionId,
          tier: tier || "STARTER",
          status: "ACTIVE",
          ...(periodEnd && { currentPeriodEnd: new Date(periodEnd * 1000) }),
        },
        update: {
          stripeSubscriptionId: subscriptionId,
          tier: tier || "STARTER",
          status: "ACTIVE",
          ...(periodEnd && { currentPeriodEnd: new Date(periodEnd * 1000) }),
        },
      });
      break;
    }

    case "customer.subscription.updated": {
      const sub = event.data.object;
      const dbSub = await prisma.subscription.findUnique({
        where: { stripeSubscriptionId: sub.id },
      });
      if (!dbSub) break;

      const status = sub.status === "active" ? "ACTIVE"
        : sub.status === "past_due" ? "PAST_DUE"
        : sub.status === "canceled" ? "CANCELED"
        : "ACTIVE";

      const periodEnd = sub.current_period_end
        ?? sub.items?.data?.[0]?.current_period_end;

      await prisma.subscription.update({
        where: { stripeSubscriptionId: sub.id },
        data: {
          status,
          ...(periodEnd && { currentPeriodEnd: new Date(periodEnd * 1000) }),
          cancelAtPeriodEnd: sub.cancel_at_period_end,
        },
      });
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object;
      await prisma.subscription.updateMany({
        where: { stripeSubscriptionId: sub.id },
        data: { status: "CANCELED" },
      });
      break;
    }
  }
}
