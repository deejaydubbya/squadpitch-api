export const PLAN_TIERS = {
  FREE: {
    label: "Free",
    priceMonthly: 0,
    limits: {
      clients: 1,
      posts: 10,
      images: 5,
      videos: 0,
    },
  },
  STARTER: {
    label: "Starter",
    priceMonthly: 2900, // cents
    limits: {
      clients: 1,
      posts: 50,
      images: 20,
      videos: 0,
    },
  },
  GROWTH: {
    label: "Growth",
    priceMonthly: 7900,
    limits: {
      clients: 3,
      posts: 200,
      images: 100,
      videos: 20,
    },
  },
  PRO: {
    label: "Pro",
    priceMonthly: 19900,
    limits: {
      clients: Infinity,
      posts: 1000,
      images: 500,
      videos: 100,
    },
  },
};

export function getLimitsForTier(tier) {
  return PLAN_TIERS[tier]?.limits ?? PLAN_TIERS.FREE.limits;
}
