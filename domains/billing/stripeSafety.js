export const STRIPE_MODES = ["test", "live"];

export function stripeKeyMode(secretKey) {
  if (typeof secretKey !== "string") return null;
  if (secretKey.startsWith("sk_live_")) return "live";
  if (secretKey.startsWith("sk_test_")) return "test";
  return null;
}

export function validateStripeMode(config) {
  const errors = [];
  const expected = config.STRIPE_EXPECTED_MODE;
  const actual = stripeKeyMode(config.STRIPE_SECRET_KEY);
  if (!STRIPE_MODES.includes(expected)) {
    errors.push("STRIPE_EXPECTED_MODE must be test or live");
  }
  if (!actual) {
    errors.push("STRIPE_SECRET_KEY must be a recognized secret key");
  } else if (expected && actual !== expected) {
    errors.push(
      `STRIPE_SECRET_KEY mode (${actual}) does not match STRIPE_EXPECTED_MODE (${expected})`,
    );
  }
  if (config.NODE_ENV === "production" && expected !== "live") {
    errors.push("STRIPE_EXPECTED_MODE must be live in production");
  }
  return errors;
}

export function allowlistedBillingUrl(value, appUrl) {
  let candidate;
  let allowed;
  try {
    candidate = new URL(value);
    allowed = new URL(appUrl);
  } catch {
    throw Object.assign(new Error("Invalid billing return URL"), {
      status: 400,
    });
  }
  if (
    candidate.origin !== allowed.origin ||
    candidate.protocol !== "https:" ||
    candidate.username ||
    candidate.password
  ) {
    throw Object.assign(new Error("Billing return URL is not allowed"), {
      status: 400,
    });
  }
  return candidate.toString();
}

export function stripeSubscriptionStatus(status) {
  if (status === "active") return "ACTIVE";
  if (status === "trialing") return "TRIALING";
  if (status === "past_due" || status === "unpaid") return "PAST_DUE";
  return "CANCELED";
}
