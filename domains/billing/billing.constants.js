// Squadpitch plan constants.
//
// `priceMonthly` (in cents) is the *intended* display price; the actual amount
// charged is whatever the Stripe price (`STRIPE_<TIER>_PRICE_ID`) is set to.
// These two must be kept in sync manually — there is intentionally NO
// hardcoded Stripe price ID in code (see env vars below).
//
// User-facing labels:
//   FREE    → "Free"
//   STARTER → "Solo"     (do NOT show "Starter" to users)
//   PRO     → "Pro"
//   GROWTH  → "Team"     (do NOT show "Growth" to users)
//   AGENCY  → "Agency"
//
// Required env vars before this code is useful in production:
//   STRIPE_SECRET_KEY
//   STRIPE_WEBHOOK_SECRET
//   STRIPE_STARTER_PRICE_ID  → Stripe price for Solo  ($29/mo)
//   STRIPE_PRO_PRICE_ID      → Stripe price for Pro   ($59/mo)
//   STRIPE_GROWTH_PRICE_ID   → Stripe price for Team  ($149/mo)
// Agency remains a valid internal entitlement but is not self-service.
// STRIPE_AGENCY_PRICE_ID is optional and reserved for assisted migrations.
//
// `assertStripeEnvConfigured()` below logs a fatal warning at boot if any
// required vars are missing.

const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

export const PLAN_TIERS = {
  FREE: {
    label: "Free",
    priceMonthly: 0,
    limits: {
      workspaces: 1,
      posts: 5,
      images: 10,
      videos: 1,
      totalStorageBytes: 1 * GB,
      videoStorageBytes: 250 * MB,
      imageGenerations: 5,
      videoGenerations: 1,
      enhancementRuns: 3,
      connectedChannels: 1,
    },
  },
  STARTER: {
    // Backend enum value STARTER is displayed to users as "Solo".
    label: "Solo",
    priceMonthly: 2900, // cents — $29/mo
    limits: {
      workspaces: 3,
      posts: 30,
      images: 30,
      videos: 3,
      totalStorageBytes: 5 * GB,
      videoStorageBytes: 2 * GB,
      imageGenerations: 30,
      videoGenerations: 5,
      enhancementRuns: 15,
      connectedChannels: 3,
    },
  },
  PRO: {
    label: "Pro",
    priceMonthly: 5900, // cents — $59/mo
    limits: {
      workspaces: 5,
      posts: 150,
      images: 75,
      videos: 10,
      totalStorageBytes: 10 * GB,
      videoStorageBytes: 4 * GB,
      imageGenerations: 150,
      videoGenerations: 15,
      enhancementRuns: 75,
      connectedChannels: 5,
    },
  },
  GROWTH: {
    // Backend enum value GROWTH is displayed to users as "Team".
    label: "Team",
    priceMonthly: 14900, // cents — $149/mo
    limits: {
      workspaces: 10,
      posts: 500,
      images: 200,
      videos: 30,
      totalStorageBytes: 30 * GB,
      videoStorageBytes: 12 * GB,
      imageGenerations: 500,
      videoGenerations: 40,
      enhancementRuns: 200,
      connectedChannels: 10,
    },
  },
  AGENCY: {
    label: "Agency",
    priceMonthly: 29900, // cents — $299/mo
    limits: {
      workspaces: Infinity,
      posts: 1200,
      images: 500,
      videos: 100,
      totalStorageBytes: 100 * GB,
      videoStorageBytes: 40 * GB,
      imageGenerations: 1000,
      videoGenerations: 100,
      enhancementRuns: 500,
      connectedChannels: Infinity,
    },
  },
};

/** Ordered list of tiers from lowest to highest. */
export const TIER_ORDER = ["FREE", "STARTER", "PRO", "GROWTH", "AGENCY"];

/** All paid tiers (i.e. tiers that require an active Stripe subscription). */
export const PAID_TIERS = ["STARTER", "PRO", "GROWTH", "AGENCY"];

/** Plans a customer may purchase or switch to without staff assistance. */
export const SELF_SERVICE_TIERS = ["STARTER", "PRO", "GROWTH"];

const PUBLIC_TIER_ALIASES = {
  SOLO: "STARTER",
  STARTER: "STARTER",
  PRO: "PRO",
  TEAM: "GROWTH",
  GROWTH: "GROWTH",
};

/** Normalize public plan names to canonical internal self-service tiers. */
export function normalizeSelfServiceTier(value) {
  if (typeof value !== "string") return null;
  return PUBLIC_TIER_ALIASES[value.trim().toUpperCase()] ?? null;
}

export function getLimitsForTier(tier) {
  return PLAN_TIERS[tier]?.limits ?? PLAN_TIERS.FREE.limits;
}

/** Returns tier rank (0 = FREE, 4 = AGENCY). */
export function getTierRank(tier) {
  const idx = TIER_ORDER.indexOf(tier);
  return idx >= 0 ? idx : 0;
}

/**
 * Boot-time assertion that every self-service tier has a Price ID configured.
 * Logs (does not throw) so dev environments without Stripe still boot. In
 * production, missing price IDs mean checkout will reject the requested tier
 * — see `createCheckoutSession()`.
 */
export function assertStripeEnvConfigured(env) {
  const missing = [];
  if (!env.STRIPE_SECRET_KEY) missing.push("STRIPE_SECRET_KEY");
  if (!env.STRIPE_WEBHOOK_SECRET) missing.push("STRIPE_WEBHOOK_SECRET");
  if (!env.STRIPE_STARTER_PRICE_ID) missing.push("STRIPE_STARTER_PRICE_ID");
  if (!env.STRIPE_PRO_PRICE_ID) missing.push("STRIPE_PRO_PRICE_ID");
  if (!env.STRIPE_GROWTH_PRICE_ID) missing.push("STRIPE_GROWTH_PRICE_ID");
  if (missing.length > 0) {
    console.warn(
      `[BILLING] Missing Stripe env vars: ${missing.join(", ")}. ` +
        "Checkout/upgrade for affected tiers will fail until configured."
    );
  }
  return missing;
}
