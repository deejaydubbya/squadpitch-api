export const PLAN_TIERS = {
  FREE: {
    label: "Free",
    priceMonthly: 0,
    limits: {
      clients: 1,
      posts: 10,
      generations: 10,
      images: 5,
      videos: 0,
    },
  },
  STARTER: {
    label: "Starter",
    priceMonthly: 1900, // cents
    limits: {
      clients: 3,
      posts: 50,
      generations: 50,
      images: 10,
      videos: 0,
    },
  },
  PRO: {
    label: "Pro",
    priceMonthly: 4900,
    limits: {
      clients: 5,
      posts: 200,
      generations: 200,
      images: 50,
      videos: 5,
    },
  },
  GROWTH: {
    label: "Growth",
    priceMonthly: 9900,
    limits: {
      clients: 10,
      posts: 500,
      generations: 500,
      images: 150,
      videos: 20,
    },
  },
  AGENCY: {
    label: "Agency",
    priceMonthly: 19900,
    limits: {
      clients: Infinity,
      posts: 1000,
      generations: 1000,
      images: 500,
      videos: 100,
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
