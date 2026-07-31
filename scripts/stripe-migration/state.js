import { createHash } from "node:crypto";

export const RESET_CONFIRMATION = "RESET-OLD-STRIPE-BILLING";

function countBy(rows, key) {
  return Object.fromEntries(
    [...new Set(rows.map((row) => row[key]))]
      .sort()
      .map((value) => [value, rows.filter((row) => row[key] === value).length]),
  );
}

function safeUserRef(userId) {
  return createHash("sha256").update(String(userId)).digest("hex").slice(0, 12);
}

export function summarizeStripeMigrationState(subscriptions, intents) {
  const affectedUsers = [...new Set([
    ...subscriptions.map((row) => row.userId),
    ...intents.map((row) => row.userId),
  ])].sort();

  return {
    subscription: {
      total: subscriptions.length,
      tierCounts: countBy(subscriptions, "tier"),
      statusCounts: countBy(subscriptions, "status"),
      withStripeCustomer: subscriptions.filter((row) => row.stripeCustomerId).length,
      withStripeSubscription: subscriptions.filter((row) => row.stripeSubscriptionId).length,
      withEventGuard: subscriptions.filter(
        (row) => row.lastStripeEventId || row.lastStripeEventCreated != null,
      ).length,
    },
    signupPlanIntent: {
      total: intents.length,
      statusCounts: countBy(intents, "status"),
      withCheckoutSession: intents.filter((row) => row.stripeCheckoutSessionId).length,
    },
    affectedUsers: {
      total: affectedUsers.length,
      anonymousRefs: affectedUsers.map(safeUserRef),
    },
  };
}

export function parseResetAuthorization(args) {
  const values = Object.fromEntries(
    args
      .filter((arg) => arg.startsWith("--") && arg.includes("="))
      .map((arg) => arg.slice(2).split(/=(.*)/s, 2)),
  );
  const errors = [];
  if (!args.includes("--execute")) errors.push("--execute is required");
  if (!args.includes("--backup-confirmed")) errors.push("--backup-confirmed is required");
  if (!args.includes("--no-real-customers-confirmed")) {
    errors.push("--no-real-customers-confirmed is required");
  }
  if (values.confirm !== RESET_CONFIRMATION) errors.push("confirmation phrase mismatch");
  const expectedSubscriptions = Number(values["expect-subscriptions"]);
  const expectedIntents = Number(values["expect-intents"]);
  if (!Number.isSafeInteger(expectedSubscriptions) || expectedSubscriptions < 0) {
    errors.push("--expect-subscriptions must be a non-negative integer");
  }
  if (!Number.isSafeInteger(expectedIntents) || expectedIntents < 0) {
    errors.push("--expect-intents must be a non-negative integer");
  }
  return { errors, expectedSubscriptions, expectedIntents };
}
