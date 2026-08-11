import { sendError } from "../lib/apiErrors.js";
import { getEffectiveEntitlement } from "../domains/billing/billing.service.js";
import { getTierRank } from "../domains/billing/billing.constants.js";

/**
 * Middleware factory that enforces a minimum plan tier.
 * No subscription, abandoned-checkout sub, or non-active sub → treated as
 * FREE (rank 0). Uses `getEffectiveTier` so a Stripe-customer-only row
 * (created during checkout setup but not yet paid) cannot grant a paid tier.
 *
 * Usage: requireTier('PRO')
 */
export function requireTier(minimumTier) {
  const minRank = getTierRank(minimumTier);

  return async (req, res, next) => {
    try {
      const clientId = req.params.clientId ?? req.body?.clientId ?? req.query?.clientId;
      const { tier: currentTier } = await getEffectiveEntitlement(req.user.id, clientId);
      const currentRank = getTierRank(currentTier);

      if (currentRank < minRank) {
        return sendError(
          res,
          403,
          "TIER_REQUIRED",
          `This feature requires a ${minimumTier} plan or higher.`,
          { requiredTier: minimumTier, currentTier },
        );
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
