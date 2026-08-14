import Stripe from "stripe";
import { env } from "../../config/env.js";
import { prisma } from "../../prisma.js";
import {
  getLimitsForTier,
  getTierRank,
  PAID_TIERS,
  SELF_SERVICE_TIERS,
} from "./billing.constants.js";
import { logEvent } from "../../lib/logger.js";
import {
  allowlistedBillingUrl,
  STRIPE_API_VERSION,
  stripeSubscriptionStatus,
} from "./stripeSafety.js";
import { handleReferralStripeEvent } from "../referrals/referral.service.js";

const stripe = env.STRIPE_SECRET_KEY
  ? new Stripe(env.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION })
  : null;

function requireStripe() {
  if (!stripe)
    throw Object.assign(new Error("Stripe not configured"), { status: 503 });
  return stripe;
}

const TIER_PRICE_MAP = {
  STARTER: env.STRIPE_STARTER_PRICE_ID,
  PRO: env.STRIPE_PRO_PRICE_ID,
  GROWTH: env.STRIPE_GROWTH_PRICE_ID,
  AGENCY: env.STRIPE_AGENCY_PRICE_ID,
};

// ── Effective tier — single source of truth ─────────────────────────────
//
// Why this exists: a Subscription row can exist *before* checkout completes
// (we create one to track the Stripe customer ID — see `getOrCreateCustomer`).
// Such a pre-checkout row has no `stripeSubscriptionId` and must NEVER
// confer paid-tier limits, even though `tier` defaults to STARTER and
// `status` defaults to ACTIVE at the schema level.
//
// All usage limits, workspace limits, feature gates, and billing UI MUST
// route their tier decision through this function. Never read `sub.tier`
// directly.
//
// Returns "FREE" unless ALL of the following hold:
//   - subscription row exists
//   - it has a real `stripeSubscriptionId`
//   - status is ACTIVE or TRIALING (live billing states)
//   - tier is one of STARTER / PRO / GROWTH / AGENCY
const ACTIVE_STATUSES = new Set(["ACTIVE", "TRIALING"]);
const NON_DUPLICABLE_STATUSES = new Set(["ACTIVE", "TRIALING", "PAST_DUE"]);

function hasExistingBillableSubscription(sub) {
  return Boolean(
    sub?.stripeSubscriptionId && NON_DUPLICABLE_STATUSES.has(sub.status),
  );
}

export function getEffectiveTier(sub, internalEntitlement = null) {
  if (
    internalEntitlement?.active === true &&
    PAID_TIERS.includes(internalEntitlement.tier)
  ) {
    return internalEntitlement.tier;
  }
  if (!sub) return "FREE";
  if (!sub.stripeSubscriptionId) return "FREE";
  if (!ACTIVE_STATUSES.has(sub.status)) return "FREE";
  if (!PAID_TIERS.includes(sub.tier)) return "FREE";
  return sub.tier;
}

export function getHighestInternalEntitlement(entitlements = []) {
  return entitlements
    .filter((entitlement) => entitlement?.active === true && PAID_TIERS.includes(entitlement.tier))
    .sort((left, right) => getTierRank(right.tier) - getTierRank(left.tier))[0] ?? null;
}

async function getAccountInternalEntitlement(userId) {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { auth0Sub: true } });
  if (!user) return null;
  const entitlements = await prisma.internalEntitlement.findMany({
    where: { active: true, client: { createdBy: user.auth0Sub, status: { not: "ARCHIVED" } } },
    select: { tier: true, active: true, grantedAt: true },
  });
  return getHighestInternalEntitlement(entitlements);
}

export async function getEffectiveEntitlement(userId, clientId) {
  const sub = await prisma.subscription.findUnique({ where: { userId } });
  if (!clientId) {
    const internal = await getAccountInternalEntitlement(userId);
    return {
      tier: getEffectiveTier(sub, internal),
      source: internal ? "INTERNAL" : sub ? "STRIPE" : "FREE",
      subscription: sub,
      internalEntitlement: internal ? { tier: internal.tier, status: "COMPED", grantedAt: internal.grantedAt } : null,
    };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { auth0Sub: true },
  });
  const client = user
    ? await prisma.client.findFirst({
        where: { id: clientId, createdBy: user.auth0Sub },
        select: { internalEntitlement: true },
      })
    : null;
  if (!client) {
    throw Object.assign(new Error("Workspace not found"), { status: 404 });
  }

  const internal = client.internalEntitlement;
  const tier = getEffectiveTier(sub, internal);
  return {
    tier,
    source: internal?.active ? "INTERNAL" : sub ? "STRIPE" : "FREE",
    subscription: sub,
    internalEntitlement: internal?.active
      ? { tier: internal.tier, status: "COMPED", grantedAt: internal.grantedAt }
      : null,
  };
}

// ── Plans (fetch prices from Stripe) ─────────────────────────────────────

let _plansCache = null;
let _plansCacheAt = 0;
const PLANS_CACHE_TTL = 300_000; // 5 minutes

export async function getPlans() {
  // Return cached if fresh
  if (_plansCache && Date.now() - _plansCacheAt < PLANS_CACHE_TTL)
    return _plansCache;

  const s = requireStripe();
  const tiers = SELF_SERVICE_TIERS;
  const plans = [
    {
      tier: "FREE",
      priceId: null,
      amount: 0,
      currency: "usd",
      interval: "month",
    },
  ];

  for (const tier of tiers) {
    const priceId = TIER_PRICE_MAP[tier];
    if (!priceId) continue;
    try {
      const price = await s.prices.retrieve(priceId);
      plans.push({
        tier,
        priceId,
        amount: price.unit_amount ?? 0, // cents
        currency: price.currency ?? "usd",
        interval: price.recurring?.interval ?? "month",
      });
    } catch (err) {
      console.error(
        `[BILLING] Failed to fetch price for ${tier}:`,
        err.message,
      );
    }
  }

  _plansCache = plans;
  _plansCacheAt = Date.now();
  return plans;
}

// ── Customer management ──────────────────────────────────────────────────

export async function getOrCreateCustomer(userId, email) {
  const s = requireStripe();
  const existing = await prisma.subscription.findUnique({ where: { userId } });
  if (existing?.stripeCustomerId) return existing.stripeCustomerId;

  const customer = await s.customers.create({
    email,
    metadata: { userId },
  });

  // Persist the Stripe customer ID without claiming any paid-tier state.
  // The schema-level defaults (`tier: STARTER`, `status: ACTIVE`) still
  // apply, BUT `stripeSubscriptionId` stays null until checkout completes
  // and the webhook fires. `getEffectiveTier()` keys off
  // `stripeSubscriptionId`, so this row is treated as FREE for limits
  // until `checkout.session.completed` lands. Do NOT set `tier` or
  // `status` explicitly here — both are misleading pre-checkout.
  await prisma.subscription.upsert({
    where: { userId },
    create: {
      userId,
      stripeCustomerId: customer.id,
    },
    update: { stripeCustomerId: customer.id },
  });

  return customer.id;
}

// ── Checkout ─────────────────────────────────────────────────────────────

export async function createCheckoutSession({
  userId,
  email,
  tier,
  successUrl,
  cancelUrl,
  idempotencyKey,
}) {
  const s = requireStripe();
  if (!SELF_SERVICE_TIERS.includes(tier)) {
    throw Object.assign(new Error("Plan is not available for self-service purchase"), {
      status: 400,
    });
  }
  const existingSubscription = await prisma.subscription.findUnique({
    where: { userId },
  });
  if (hasExistingBillableSubscription(existingSubscription)) {
    throw Object.assign(
      new Error(
        "An active subscription already exists; change the current plan instead",
      ),
      { status: 409 },
    );
  }
  const customerId = await getOrCreateCustomer(userId, email);
  const priceId = TIER_PRICE_MAP[tier];
  if (!priceId)
    throw Object.assign(new Error(`No price configured for tier: ${tier}`), {
      status: 400,
    });

  const session = await s.checkout.sessions.create(
    {
      customer: customerId,
      client_reference_id: userId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: allowlistedBillingUrl(successUrl, env.APP_URL),
      cancel_url: allowlistedBillingUrl(cancelUrl, env.APP_URL),
      metadata: { userId, tier },
      subscription_data: { metadata: { userId, tier } },
    },
    idempotencyKey
      ? { idempotencyKey: `checkout:${userId}:${idempotencyKey}` }
      : undefined,
  );

  logEvent("billing.checkout.session_created", {
    userId,
    tier,
    stripeCustomerId: customerId,
    stripeSessionId: session.id,
  });

  return { url: session.url };
}

export async function selectSignupPlan({ userId, tier }) {
  if (!SELF_SERVICE_TIERS.includes(tier)) {
    throw Object.assign(new Error("Unknown paid plan"), { status: 400 });
  }

  const current = await prisma.subscription.findUnique({ where: { userId } });
  const effectiveTier = getEffectiveTier(current);
  if (effectiveTier !== "FREE") {
    return { status: "ACTIVATED", desiredTier: effectiveTier, effectiveTier };
  }
  if (hasExistingBillableSubscription(current)) {
    throw Object.assign(
      new Error(
        "An existing subscription needs recovery in the Customer Portal",
      ),
      { status: 409 },
    );
  }

  const intent = await prisma.signupPlanIntent.upsert({
    where: { userId },
    create: { userId, desiredTier: tier },
    update: {
      desiredTier: tier,
      status: "SELECTED",
      stripeCheckoutSessionId: null,
      checkoutUrl: null,
      checkoutAttempt: { increment: 1 },
      activatedAt: null,
    },
  });
  logEvent("signup.plan.selected", { userId, tier });
  return { ...intent, effectiveTier: "FREE" };
}

export async function getSignupPlanIntent(userId) {
  const [intent, subscription] = await Promise.all([
    prisma.signupPlanIntent.findUnique({ where: { userId } }),
    prisma.subscription.findUnique({ where: { userId } }),
  ]);
  const effectiveTier = getEffectiveTier(subscription);
  if (intent && effectiveTier !== "FREE" && intent.status !== "ACTIVATED") {
    const activated = await prisma.signupPlanIntent.update({
      where: { userId },
      data: { status: "ACTIVATED", activatedAt: new Date() },
    });
    return { ...activated, effectiveTier };
  }
  return { intent, effectiveTier };
}

export async function resumeSignupCheckout({ userId, email }) {
  const state = await getSignupPlanIntent(userId);
  if (state.effectiveTier !== "FREE") {
    return { status: "ACTIVATED", effectiveTier: state.effectiveTier };
  }

  let intent = state.intent;
  if (!intent) {
    throw Object.assign(new Error("Select a plan before starting checkout"), {
      status: 409,
    });
  }
  if (!SELF_SERVICE_TIERS.includes(intent.desiredTier)) {
    throw Object.assign(
      new Error("Selected plan is no longer available for self-service purchase"),
      { status: 400 },
    );
  }

  const s = requireStripe();
  if (intent.stripeCheckoutSessionId) {
    const existing = await s.checkout.sessions.retrieve(
      intent.stripeCheckoutSessionId,
    );
    if (existing.status === "open" && existing.url) {
      logEvent("signup.checkout.resumed", {
        userId,
        tier: intent.desiredTier,
        stripeSessionId: existing.id,
      });
      return { status: "CHECKOUT_CREATED", url: existing.url };
    }
    intent = await prisma.signupPlanIntent.update({
      where: { userId },
      data: {
        checkoutAttempt: { increment: 1 },
        stripeCheckoutSessionId: null,
        checkoutUrl: null,
        status: "SELECTED",
      },
    });
  }

  const customerId = await getOrCreateCustomer(userId, email);
  const priceId = TIER_PRICE_MAP[intent.desiredTier];
  if (!priceId) {
    throw Object.assign(
      new Error(`No price configured for tier: ${intent.desiredTier}`),
      { status: 400 },
    );
  }

  const continuation = `${env.APP_URL}/signup/continue`;
  const session = await s.checkout.sessions.create(
    {
      customer: customerId,
      mode: "subscription",
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${continuation}?checkout=success`,
      cancel_url: `${continuation}?checkout=cancel`,
      metadata: {
        userId,
        tier: intent.desiredTier,
        signupPlanIntentId: intent.id,
      },
      subscription_data: {
        metadata: { userId, tier: intent.desiredTier },
      },
    },
    {
      idempotencyKey: `signup-plan:${intent.id}:${intent.checkoutAttempt}`,
    },
  );

  await prisma.signupPlanIntent.update({
    where: { userId },
    data: {
      status: "CHECKOUT_CREATED",
      stripeCheckoutSessionId: session.id,
      checkoutUrl: session.url,
    },
  });
  logEvent("signup.checkout.started", {
    userId,
    tier: intent.desiredTier,
    stripeSessionId: session.id,
  });
  return { status: "CHECKOUT_CREATED", url: session.url };
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
    return_url: allowlistedBillingUrl(returnUrl, env.APP_URL),
  });

  return { url: session.url };
}

// ── Subscription ─────────────────────────────────────────────────────────

export async function getSubscription(userId) {
  return prisma.subscription.findUnique({ where: { userId } });
}

// ── Usage ────────────────────────────────────────────────────────────────

export async function getUsage(userId, clientId = null) {
  const now = new Date();
  const periodStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const periodEnd = new Date(now.getFullYear(), now.getMonth() + 1, 1);

  const record = await prisma.usageRecord.findUnique({
    where: { userId_periodStart: { userId, periodStart } },
  });

  const entitlement = await getEffectiveEntitlement(userId, clientId);
  const sub = entitlement.subscription;
  const tier = entitlement.tier;
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
    billingSource: entitlement?.source ?? (sub ? "STRIPE" : "FREE"),
  };
}

export async function grantInternalEntitlement({ clientId, tier, reason, actorSub, actorEmail }) {
  if (!PAID_TIERS.includes(tier)) {
    throw Object.assign(new Error("Internal entitlement requires a paid tier"), { status: 400 });
  }
  const client = await prisma.client.findUnique({ where: { id: clientId }, select: { id: true } });
  if (!client) throw Object.assign(new Error("Workspace not found"), { status: 404 });

  return prisma.internalEntitlement.upsert({
    where: { clientId },
    create: { clientId, tier, reason, grantedBySub: actorSub, grantedByEmail: actorEmail },
    update: {
      tier, active: true, reason, grantedBySub: actorSub, grantedByEmail: actorEmail,
      grantedAt: new Date(), revokedBySub: null, revokedByEmail: null,
      revokedReason: null, revokedAt: null,
    },
  });
}

export async function revokeInternalEntitlement({ clientId, reason, actorSub, actorEmail }) {
  const current = await prisma.internalEntitlement.findUnique({ where: { clientId } });
  if (!current || !current.active) return current;
  return prisma.internalEntitlement.update({
    where: { clientId },
    data: {
      active: false, revokedBySub: actorSub, revokedByEmail: actorEmail,
      revokedReason: reason, revokedAt: new Date(),
    },
  });
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
    return {
      nearing: true,
      status: "exceeded",
      metric: field,
      used: current,
      limit,
      tier,
    };
  }
  if (pct >= 0.9) {
    return {
      nearing: true,
      status: "urgent",
      metric: field,
      used: current,
      limit,
      tier,
    };
  }
  if (pct >= 0.7) {
    return {
      nearing: true,
      status: "warning",
      metric: field,
      used: current,
      limit,
      tier,
    };
  }
  return null;
}

/**
 * Check if the user can create another client within their plan limit.
 * Uses the Prisma user ID (Subscription.userId), NOT the Auth0 sub.
 */
export async function checkClientLimit(userId) {
  const { tier } = await getEffectiveEntitlement(userId);
  const limit = getLimitsForTier(tier).workspaces;
  if (limit === Infinity) return true;
  // Client.createdBy stores auth0Sub, so look up the user's sub
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { auth0Sub: true },
  });
  if (!user) return false;
  const count = await prisma.client.count({
    where: {
      createdBy: user.auth0Sub,
      status: { notIn: ["ARCHIVED", "DRAFT"] },
    },
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
export async function checkStorageLimit(
  userId,
  additionalBytes,
  isVideo = false,
) {
  const { storage, limits } = await getUsage(userId);
  const newTotal = storage.totalBytes + additionalBytes;
  if (
    newTotal > limits.totalStorageBytes &&
    limits.totalStorageBytes !== Infinity
  ) {
    return {
      allowed: false,
      reason:
        "Total storage limit reached. Delete unused assets or upgrade your plan.",
      current: storage.totalBytes,
      limit: limits.totalStorageBytes,
    };
  }
  if (isVideo) {
    const newVideoTotal = storage.videoBytes + additionalBytes;
    if (
      newVideoTotal > limits.videoStorageBytes &&
      limits.videoStorageBytes !== Infinity
    ) {
      return {
        allowed: false,
        reason:
          "Video storage limit reached. Delete unused videos or upgrade your plan.",
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
  const NEXT_TIER = {
    FREE: "STARTER",
    STARTER: "PRO",
  };
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
  const rem = (field) =>
    Math.max(0, (limits[field] ?? Infinity) - (usage[field] ?? 0));
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
    const tier = getEffectiveTier(sub);

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
  if (!hasExistingBillableSubscription(sub)) {
    throw Object.assign(
      new Error(
        "No active subscription to change. Use checkout to subscribe first.",
      ),
      { status: 400 },
    );
  }

  if (!SELF_SERVICE_TIERS.includes(newTier)) {
    throw Object.assign(new Error("Plan is not available for self-service purchase"), {
      status: 400,
    });
  }

  const newPriceId = TIER_PRICE_MAP[newTier];
  if (!newPriceId) {
    throw Object.assign(new Error(`No price configured for tier: ${newTier}`), {
      status: 400,
    });
  }

  // Prevent changing to the same tier
  if (sub.tier === newTier) {
    throw Object.assign(new Error("Already on this plan"), { status: 400 });
  }

  // Get the Stripe subscription to find the subscription item ID
  const stripeSub = await s.subscriptions.retrieve(sub.stripeSubscriptionId);
  const subscriptionItemId = stripeSub.items?.data?.[0]?.id;
  if (!subscriptionItemId) {
    throw Object.assign(new Error("Could not find subscription item"), {
      status: 500,
    });
  }

  const isUpgrade = getTierRank(newTier) > getTierRank(sub.tier);

  // Update the existing subscription with proration
  const updated = await s.subscriptions.update(sub.stripeSubscriptionId, {
    items: [
      {
        id: subscriptionItemId,
        price: newPriceId,
      },
    ],
    proration_behavior: "create_prorations",
    metadata: { tier: newTier },
  });

  const periodEnd =
    updated.current_period_end ?? updated.items?.data?.[0]?.current_period_end;

  // Stripe's signed webhook remains authoritative for both upgrades and
  // downgrades. Never grant a higher tier from this response alone.
  logEvent("billing.subscription.change_requested", {
    userId,
    fromTier: sub.tier,
    toTier: newTier,
    isUpgrade,
    stripeSubscriptionId: sub.stripeSubscriptionId,
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
    .map(([k, v]) => [v, k]),
);

// ── Stripe webhook ordering / dedup guard ─────────────────────────────
//
// Stripe occasionally retries events out of order — a delayed
// `customer.subscription.deleted` arriving after a fresh upgrade
// would silently downgrade the user. We track the last processed
// event's `created` timestamp and id per subscription and skip stale
// or duplicate events.
//
// Keys:
//   { userId }                       (when we have it from session.metadata)
//   { stripeSubscriptionId }         (everything else)
//   { stripeCustomerId }             (only as a last resort)
//
// Returns:
//   { allow: boolean, reason?: string, sub: Subscription | null }
//
// Callers MUST call `markEventProcessed(...)` after a successful update
// so the next event with this row's `stripeSubscriptionId` is compared
// against the right baseline.
async function shouldProcessEvent(event, lookup) {
  const sub = await prisma.subscription.findUnique({ where: lookup });
  if (!sub) return { allow: true, sub: null };

  // Duplicate-event guard. Only fires when BOTH ids are present —
  // otherwise undefined === undefined would falsely match for any
  // subscription that pre-dates the ordering guard fields.
  if (event.id && sub.lastStripeEventId && sub.lastStripeEventId === event.id) {
    return { allow: false, reason: "duplicate_event_id", sub };
  }
  if (
    typeof sub.lastStripeEventCreated === "number" &&
    typeof event.created === "number" &&
    event.created < sub.lastStripeEventCreated
  ) {
    return { allow: false, reason: "stale_event", sub };
  }
  return { allow: true, sub };
}

function logSkippedEvent(event, reason, sub) {
  logEvent("stripe.webhook.skipped", {
    stripeEventId: event.id,
    type: event.type,
    reason,
    eventCreated: event.created,
    lastEventCreated: sub?.lastStripeEventCreated ?? null,
    lastEventId: sub?.lastStripeEventId ?? null,
    userId: sub?.userId ?? null,
    stripeSubscriptionId: sub?.stripeSubscriptionId ?? null,
  });
}

export async function handleWebhookEvent(event) {
  switch (event.type) {
    case "checkout.session.completed": {
      const session = event.data.object;
      const { userId, tier } = session.metadata;
      if (!userId) break;

      const guard = await shouldProcessEvent(event, { userId });
      if (!guard.allow) {
        logSkippedEvent(event, guard.reason, guard.sub);
        break;
      }

      const subscriptionId = session.subscription;
      const s = requireStripe();
      const sub = await s.subscriptions.retrieve(subscriptionId);
      const status = stripeSubscriptionStatus(sub.status);

      // current_period_end moved to items in newer Stripe API versions
      const periodEnd =
        sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;

      const before = guard.sub;

      await prisma.subscription.upsert({
        where: { userId },
        create: {
          userId,
          stripeCustomerId: session.customer,
          stripeSubscriptionId: subscriptionId,
          tier: tier || "STARTER",
          status,
          ...(periodEnd && { currentPeriodEnd: new Date(periodEnd * 1000) }),
          lastStripeEventId: event.id,
          lastStripeEventCreated: event.created,
        },
        update: {
          stripeSubscriptionId: subscriptionId,
          tier: tier || "STARTER",
          status,
          ...(periodEnd && { currentPeriodEnd: new Date(periodEnd * 1000) }),
          lastStripeEventId: event.id,
          lastStripeEventCreated: event.created,
        },
      });

      if (prisma.signupPlanIntent) {
        await prisma.signupPlanIntent.updateMany({
          where: { userId },
          data: { status: "ACTIVATED", activatedAt: new Date() },
        });
      }

      logEvent("billing.subscription.activated", {
        userId,
        fromTier: before ? getEffectiveTier(before) : "FREE",
        toTier: tier || "STARTER",
        status,
        stripeSubscriptionId: subscriptionId,
      });
      break;
    }

    case "customer.subscription.updated": {
      const sub = event.data.object;
      const guard = await shouldProcessEvent(event, {
        stripeSubscriptionId: sub.id,
      });
      if (!guard.allow) {
        logSkippedEvent(event, guard.reason, guard.sub);
        break;
      }
      const dbSub = guard.sub;
      if (!dbSub) break;

      const status = stripeSubscriptionStatus(sub.status);

      const periodEnd =
        sub.current_period_end ?? sub.items?.data?.[0]?.current_period_end;

      // Sync tier from Stripe price ID (handles plan changes via Stripe dashboard or API)
      const currentPriceId = sub.items?.data?.[0]?.price?.id;
      const syncedTier = currentPriceId ? PRICE_TO_TIER[currentPriceId] : null;
      const newTier = syncedTier ?? sub.metadata?.tier ?? dbSub.tier;

      await prisma.subscription.update({
        where: { stripeSubscriptionId: sub.id },
        data: {
          status,
          ...(syncedTier && { tier: syncedTier }),
          ...(sub.metadata?.tier && !syncedTier && { tier: sub.metadata.tier }),
          ...(periodEnd && { currentPeriodEnd: new Date(periodEnd * 1000) }),
          cancelAtPeriodEnd: sub.cancel_at_period_end,
          lastStripeEventId: event.id,
          lastStripeEventCreated: event.created,
        },
      });

      // Emit a tier-change event only when the tier actually moved.
      if (newTier !== dbSub.tier) {
        logEvent("billing.subscription.tier_changed", {
          userId: dbSub.userId,
          fromTier: dbSub.tier,
          toTier: newTier,
          status,
          stripeSubscriptionId: sub.id,
        });
      } else if (status !== dbSub.status) {
        logEvent("billing.subscription.status_changed", {
          userId: dbSub.userId,
          tier: newTier,
          fromStatus: dbSub.status,
          toStatus: status,
          stripeSubscriptionId: sub.id,
        });
      }
      break;
    }

    case "customer.subscription.deleted": {
      const sub = event.data.object;
      const guard = await shouldProcessEvent(event, {
        stripeSubscriptionId: sub.id,
      });
      if (!guard.allow) {
        logSkippedEvent(event, guard.reason, guard.sub);
        break;
      }
      await prisma.subscription.updateMany({
        where: { stripeSubscriptionId: sub.id },
        data: {
          status: "CANCELED",
          lastStripeEventId: event.id,
          lastStripeEventCreated: event.created,
        },
      });
      break;
    }

    case "invoice.paid": {
      // Successful payment — ensure subscription is marked ACTIVE
      const invoice = event.data.object;
      const subId = invoice.subscription;
      if (!subId) break;

      const guard = await shouldProcessEvent(event, {
        stripeSubscriptionId: subId,
      });
      if (!guard.allow) {
        logSkippedEvent(event, guard.reason, guard.sub);
        break;
      }
      await prisma.subscription.updateMany({
        where: { stripeSubscriptionId: subId },
        data: {
          status: "ACTIVE",
          lastStripeEventId: event.id,
          lastStripeEventCreated: event.created,
        },
      });
      break;
    }

    case "invoice.payment_failed": {
      // Payment failed — mark subscription as PAST_DUE
      const invoice = event.data.object;
      const subId = invoice.subscription;
      if (!subId) break;

      const guard = await shouldProcessEvent(event, {
        stripeSubscriptionId: subId,
      });
      if (!guard.allow) {
        logSkippedEvent(event, guard.reason, guard.sub);
        break;
      }
      await prisma.subscription.updateMany({
        where: { stripeSubscriptionId: subId },
        data: {
          status: "PAST_DUE",
          lastStripeEventId: event.id,
          lastStripeEventCreated: event.created,
        },
      });
      break;
    }
  }
  await handleReferralStripeEvent(event);
}
