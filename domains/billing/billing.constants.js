export const PLAN_TIERS = {
  STARTER: {
    label: "Starter",
    priceMonthly: 2900, // cents
    limits: {
      clients: 3,
      generations: 100,
      publishes: 100,
      mediaGens: 10,
    },
  },
  GROWTH: {
    label: "Growth",
    priceMonthly: 7900,
    limits: {
      clients: 10,
      generations: 500,
      publishes: 200,
      mediaGens: 50,
    },
  },
  PRO: {
    label: "Pro",
    priceMonthly: 19900,
    limits: {
      clients: Infinity,
      generations: Infinity,
      publishes: Infinity,
      mediaGens: Infinity,
    },
  },
};

export function getLimitsForTier(tier) {
  return PLAN_TIERS[tier]?.limits ?? PLAN_TIERS.STARTER.limits;
}
