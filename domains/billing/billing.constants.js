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
    label: "Starter",
    // TODO: Update STRIPE_STARTER_PRICE_ID env var to match $19/mo Stripe price
    priceMonthly: 1900, // cents ($19/mo)
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
    // TODO: Update STRIPE_PRO_PRICE_ID env var to match $39/mo Stripe price (was $49)
    priceMonthly: 3900, // cents ($39/mo)
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
    label: "Growth",
    // TODO: Update STRIPE_GROWTH_PRICE_ID env var to match $79/mo Stripe price (was $99)
    priceMonthly: 7900, // cents ($79/mo)
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
    // TODO: Update STRIPE_AGENCY_PRICE_ID env var to match $159/mo Stripe price (was $199)
    priceMonthly: 15900, // cents ($159/mo)
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

export function getLimitsForTier(tier) {
  return PLAN_TIERS[tier]?.limits ?? PLAN_TIERS.FREE.limits;
}

/** Returns tier rank (0 = FREE, 4 = AGENCY). */
export function getTierRank(tier) {
  const idx = TIER_ORDER.indexOf(tier);
  return idx >= 0 ? idx : 0;
}
