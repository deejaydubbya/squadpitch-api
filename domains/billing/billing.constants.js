const GB = 1024 * 1024 * 1024;
const MB = 1024 * 1024;

export const PLAN_TIERS = {
  FREE: {
    label: "Free",
    priceMonthly: 0,
    limits: {
      workspaces: 1,
      posts: 10,
      images: 5,
      videos: 1,
      totalStorageBytes: 250 * MB,
      videoStorageBytes: 100 * MB,
      imageGenerations: 10,
      videoGenerations: 1,
      enhancementRuns: 5,
    },
  },
  STARTER: {
    label: "Starter",
    priceMonthly: 1900, // cents
    limits: {
      workspaces: 3,
      posts: 75,
      images: 30,
      videos: 3,
      totalStorageBytes: 3 * GB,
      videoStorageBytes: 1 * GB,
      imageGenerations: 75,
      videoGenerations: 5,
      enhancementRuns: 25,
    },
  },
  PRO: {
    label: "Pro",
    priceMonthly: 4900,
    limits: {
      workspaces: 5,
      posts: 250,
      images: 75,
      videos: 10,
      totalStorageBytes: 10 * GB,
      videoStorageBytes: 4 * GB,
      imageGenerations: 300,
      videoGenerations: 15,
      enhancementRuns: 100,
    },
  },
  GROWTH: {
    label: "Growth",
    priceMonthly: 9900,
    limits: {
      workspaces: 10,
      posts: 600,
      images: 200,
      videos: 30,
      totalStorageBytes: 30 * GB,
      videoStorageBytes: 12 * GB,
      imageGenerations: 800,
      videoGenerations: 40,
      enhancementRuns: 250,
    },
  },
  AGENCY: {
    label: "Agency",
    priceMonthly: 19900,
    limits: {
      workspaces: Infinity,
      posts: 1200,
      images: 500,
      videos: 100,
      totalStorageBytes: 100 * GB,
      videoStorageBytes: 40 * GB,
      imageGenerations: 2000,
      videoGenerations: 100,
      enhancementRuns: 500,
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
