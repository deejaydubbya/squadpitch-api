import { sendError } from "../lib/apiErrors.js";
import { getSubscription } from "../domains/billing/billing.service.js";
import { getTierRank } from "../domains/billing/billing.constants.js";

/**
 * Middleware factory that enforces a minimum plan tier.
 * No subscription record → treated as FREE (rank 0).
 *
 * Usage: requireTier('PRO')
 */
export function requireTier(minimumTier) {
  const minRank = getTierRank(minimumTier);

  return async (req, res, next) => {
    try {
      const sub = await getSubscription(req.user.id);
      const currentTier = sub?.tier ?? "FREE";
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
