import Stripe from "stripe";
import { env } from "../../config/env.js";
import { prisma } from "../../prisma.js";
import { getLimitsForTier, getTierRank } from "./billing.constants.js";

const stripe = env.STRIPE_SECRET_KEY
  ? new Stripe(env.STRIPE_SECRET_KEY)
  : null;

function requireStripe() {
  if (!stripe) throw Object.assign(new Error("Stripe not configured"), { status: 503 });
  return stripe;
}

const TIER_PRICE_MAP = {
  STARTER: env.STRIPE_STARTER_PRICE_ID,
  PRO: env.STRIPE_PRO_PRICE_ID,
  GROWTH: env.STRIPE_GROWTH_PRICE_ID,
  AGENCY: env.STRIPE_AGENCY_PRICE_ID,
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
  const tier = sub?.tier ?? "FREE";
  const limits = getLimitsForTier(tier);

  // Compute storage across all user's workspaces
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { auth0Sub: true },
  });
  let totalBytes = 0;
  let videoBytes = 0;
  if (user) {
    const [totalAgg, videoAgg] = await Promise.all([
      prisma.mediaAsset.aggregate({
        where: {
          client: { createdBy: user.auth0Sub },
          status: { not: "FAILED" },
        },
        _sum: { bytes: true },
      }),
      prisma.mediaAsset.aggregate({
        where: {
          client: { createdBy: user.auth0Sub },
          status: { not: "FAILED" },
          assetType: "video",
        },
        _sum: { bytes: true },
      }),
    ]);
    totalBytes = totalAgg._sum.bytes ?? 0;
    videoBytes = videoAgg._sum.bytes ?? 0;
  }

  return {
    period: { start: periodStart, end: periodEnd },
    usage: {
      posts: record?.posts ?? 0,
      images: record?.images ?? 0,
      videos: record?.videos ?? 0,
      imageGenerations: record?.imageGenerations ?? 0,
      videoGenerations: record?.videoGenerations ?? 0,
      enhancementRuns: record?.enhancementRuns ?? 0,
    },
    storage: { totalBytes, videoBytes },
    limits,
    tier,
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
 * Check usage threshold for a field.
 * Returns { nearing: true, status, metric, used, limit, tier } or null.
 * status: "warning" (70%), "urgent" (90%), "exceeded" (100%)
 */
export async function checkUsageNearing(userId, field) {
  const { usage, limits, tier } = await getUsage(userId);
  const current = usage[field] ?? 0;
  const limit = limits[field] ?? Infinity;
  if (limit === Infinity) return null;
  const pct = current / limit;
  if (pct >= 1) {
    return { nearing: true, status: "exceeded", metric: field, used: current, limit, tier };
  }
  if (pct >= 0.9) {
    return { nearing: true, status: "urgent", metric: field, used: current, limit, tier };
  }
  if (pct >= 0.7) {
    return { nearing: true, status: "warning", metric: field, used: current, limit, tier };
  }
  return null;
}

/**
 * Check if the user can create another client within their plan limit.
 * Uses the Prisma user ID (Subscription.userId), NOT the Auth0 sub.
 */
export async function checkClientLimit(userId) {
  const sub = await prisma.subscription.findUnique({ where: { userId } });
  const tier = sub?.tier ?? "FREE";
  const limit = getLimitsForTier(tier).workspaces;
  if (limit === Infinity) return true;
  // Client.createdBy stores auth0Sub, so look up the user's sub
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { auth0Sub: true },
  });
  if (!user) return false;
  const count = await prisma.client.count({
    where: { createdBy: user.auth0Sub, status: { not: "ARCHIVED" } },
  });
  return count < limit;
}

export async function checkUsageLimit(userId, field) {
  const { usage, limits } = await getUsage(userId);
  const current = usage[field] ?? 0;
  const limit = limits[field] ?? Infinity;
  if (limit === Infinity) return true;
  return current < limit;
}

/**
 * Like checkUsageLimit but returns quota error details on failure.
 * Returns null if allowed, or a quota error object if limit exceeded.
 */
export async function enforceUsageLimit(userId, field) {
  const { usage, limits, tier } = await getUsage(userId);
  const current = usage[field] ?? 0;
  const limit = limits[field] ?? Infinity;
  if (limit === Infinity) return null;
  if (current < limit) return null;
  return buildQuotaError(field, current, limit, tier);
}

/**
 * Check if adding `additionalBytes` would exceed storage limits.
 * Returns { allowed, reason?, current?, limit? }
 */
export async function checkStorageLimit(userId, additionalBytes, isVideo = false) {
  const { storage, limits } = await getUsage(userId);
  const newTotal = storage.totalBytes + additionalBytes;
  if (newTotal > limits.totalStorageBytes && limits.totalStorageBytes !== Infinity) {
    return {
      allowed: false,
      reason: "Total storage limit reached. Delete unused assets or upgrade your plan.",
      current: storage.totalBytes,
      limit: limits.totalStorageBytes,
    };
  }
  if (isVideo) {
    const newVideoTotal = storage.videoBytes + additionalBytes;
    if (newVideoTotal > limits.videoStorageBytes && limits.videoStorageBytes !== Infinity) {
      return {
        allowed: false,
        reason: "Video storage limit reached. Delete unused videos or upgrade your plan.",
        current: storage.videoBytes,
        limit: limits.videoStorageBytes,
      };
    }
  }
  return { allowed: true };
}

/**
 * Build a structured quota error object for route responses.
 */
export function buildQuotaError(limitType, current, allowed, tier) {
  const NEXT_TIER = { FREE: "STARTER", STARTER: "PRO", PRO: "GROWTH", GROWTH: "AGENCY" };
  const nextTier = NEXT_TIER[tier];
  const nextLimits = nextTier ? getLimitsForTier(nextTier) : null;
  const nextValue = nextLimits?.[limitType];
  const upgradeMessage = nextTier
    ? `Upgrade to ${nextTier} for ${nextValue === Infinity ? "unlimited" : nextValue} ${limitType}/mo`
    : null;
  return {
    code: limitType.includes("Storage") ? "STORAGE_LIMIT" : "USAGE_LIMIT",
    limitType,
    current,
    allowed,
    tier,
    upgradeMessage,
  };
}

/**
 * Get remaining usage for all fields.
 */
export async function getRemainingUsage(userId) {
  const { usage, limits, tier, period, storage } = await getUsage(userId);
  const rem = (field) => Math.max(0, (limits[field] ?? Infinity) - (usage[field] ?? 0));
  return {
    period,
    tier,
    remaining: {
      posts: rem("posts"),
      images: rem("images"),
      videos: rem("videos"),
      imageGenerations: rem("imageGenerations"),
      videoGenerations: rem("videoGenerations"),
      enhancementRuns: rem("enhancementRuns"),
    },
    usage,
    storage,
    limits,
  };
}

// ── Job Priority ────────────────────────────────────────────────────────

/**
 * Get BullMQ job priority for a user based on their tier.
 * Onboarding (0 clients) = 1, Paid = 5, Free = 10.
 * Fail-open: returns 5 on any error.
 */
export async function getJobPriorityForUser(userId) {
  try {
    const sub = await prisma.subscription.findUnique({ where: { userId } });
    const tier = sub?.tier ?? "FREE";

    // Paid users get priority 5
    if (tier !== "FREE") return 5;

    // Check if onboarding (0 active clients)
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { auth0Sub: true },
    });
    if (user) {
      const clientCount = await prisma.client.count({
        where: { createdBy: user.auth0Sub, status: { not: "ARCHIVED" } },
      });
      if (clientCount === 0) return 1;
    }

    // Free user with clients
    return 10;
  } catch (err) {
    console.error("[BILLING] getJobPriorityForUser failed:", err.message);
    return 5; // Fail-open
  }
}

// ── Plan Change (Upgrade / Downgrade) ───────────────────────────────────

/**
 * Change an existing subscription to a new tier via Stripe proration.
 * NEVER creates a new subscription — always updates the existing one.
 */
export async function changePlan({ userId, newTier }) {
  const s = requireStripe();

  const sub = await prisma.subscription.findUnique({ where: { userId } });
  if (!sub?.stripeSubscriptionId) {
    throw Object.assign(new Error("No active subscription to change. Use checkout to subscribe first."), { status: 400 });
  }

  const newPriceId = TIER_PRICE_MAP[newTier];
  if (!newPriceId) {
    throw Object.assign(new Error(`No price configured for tier: ${newTier}`), { status: 400 });
  }

  // Prevent changing to the same tier
  if (sub.tier === newTier) {
    throw Object.assign(new Error("Already on this plan"), { status: 400 });
  }

  // Get the Stripe subscription to find the subscription item ID
  const stripeSub = await s.subscriptions.retrieve(sub.stripeSubscriptionId);
  const subscriptionItemId = stripeSub.items?.data?.[0]?.id;
  if (!subscriptionItemId) {
    throw Object.assign(new Error("Could not find subscription item"), { status: 500 });
  }

  const isUpgrade = getTierRank(newTier) > getTierRank(sub.tier);

  // Update the existing subscription with proration
  const updated = await s.subscriptions.update(sub.stripeSubscriptionId, {
    items: [{
      id: subscriptionItemId,
      price: newPriceId,
    }],
    proration_behavior: "create_prorations",
    metadata: { tier: newTier },
  });

  const periodEnd = updated.current_period_end
    ?? updated.items?.data?.[0]?.current_period_end;

  // Update local DB immediately for upgrades (downgrades confirmed via webhook)
  await prisma.subscription.update({
    where: { userId },
    data: {
      tier: newTier,
      ...(periodEnd && { currentPeriodEnd: new Date(periodEnd * 1000) }),
    },
  });

  return {
    tier: newTier,
    previousTier: sub.tier,
    isUpgrade,
    currentPeriodEnd: periodEnd ? new Date(periodEnd * 1000) : null,
  };
}

// ── Webhook ──────────────────────────────────────────────────────────────

// Reverse-lookup: Stripe price ID → tier name
const PRICE_TO_TIER = Object.fromEntries(
  Object.entries(TIER_PRICE_MAP)
    .filter(([, v]) => v)
    .map(([k, v]) => [v, k])
);

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

      // Sync tier from Stripe price ID (handles plan changes via Stripe dashboard or API)
      const currentPriceId = sub.items?.data?.[0]?.price?.id;
      const syncedTier = currentPriceId ? PRICE_TO_TIER[currentPriceId] : null;

      await prisma.subscription.update({
        where: { stripeSubscriptionId: sub.id },
        data: {
          status,
          ...(syncedTier && { tier: syncedTier }),
          ...(sub.metadata?.tier && !syncedTier && { tier: sub.metadata.tier }),
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

    case "invoice.paid": {
      // Successful payment — ensure subscription is marked ACTIVE
      const invoice = event.data.object;
      const subId = invoice.subscription;
      if (!subId) break;

      await prisma.subscription.updateMany({
        where: { stripeSubscriptionId: subId },
        data: { status: "ACTIVE" },
      });
      break;
    }

    case "invoice.payment_failed": {
      // Payment failed — mark subscription as PAST_DUE
      const invoice = event.data.object;
      const subId = invoice.subscription;
      if (!subId) break;

      await prisma.subscription.updateMany({
        where: { stripeSubscriptionId: subId },
        data: { status: "PAST_DUE" },
      });
      break;
    }
  }
}
