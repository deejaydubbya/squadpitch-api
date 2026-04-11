import { sendError } from "../lib/apiErrors.js";
import { getSubscription } from "../domains/billing/billing.service.js";

/**
 * Middleware that checks the user has an active subscription.
 * If no subscription record exists, the user is treated as on a free trial
 * (STARTER tier) and allowed through.
 */
export async function requireSubscription(req, res, next) {
  try {
    const sub = await getSubscription(req.user.id);

    // No subscription record = free trial / new user — allow through
    if (!sub) {
      return next();
    }

    if (sub.status === "CANCELED") {
      return sendError(res, 403, "SUBSCRIPTION_CANCELED", "Your subscription has been canceled. Please resubscribe to continue.");
    }

    if (sub.status === "PAST_DUE") {
      return sendError(res, 403, "SUBSCRIPTION_PAST_DUE", "Your subscription payment is past due. Please update your payment method.");
    }

    next();
  } catch (err) {
    next(err);
  }
}
