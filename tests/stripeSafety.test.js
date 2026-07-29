import { describe, expect, it } from "vitest";
import {
  allowlistedBillingUrl,
  stripeKeyMode,
  stripeSubscriptionStatus,
  validateStripeMode,
} from "../domains/billing/stripeSafety.js";

describe("Stripe live-mode safety", () => {
  it("detects secret-key mode without exposing the key", () => {
    expect(stripeKeyMode("sk_live_example")).toBe("live");
    expect(stripeKeyMode("sk_test_example")).toBe("test");
    expect(stripeKeyMode("rk_live_example")).toBeNull();
  });

  it("rejects test/live production mismatches", () => {
    expect(
      validateStripeMode({
        NODE_ENV: "production",
        STRIPE_EXPECTED_MODE: "live",
        STRIPE_SECRET_KEY: "sk_test_example",
      }),
    ).toContain(
      "STRIPE_SECRET_KEY mode (test) does not match STRIPE_EXPECTED_MODE (live)",
    );
  });

  it("allows only same-origin HTTPS billing returns", () => {
    expect(
      allowlistedBillingUrl(
        "https://app.squadpitch.com/settings/billing?done=1",
        "https://app.squadpitch.com",
      ),
    ).toBe("https://app.squadpitch.com/settings/billing?done=1");
    expect(() =>
      allowlistedBillingUrl(
        "https://evil.example/checkout",
        "https://app.squadpitch.com",
      ),
    ).toThrow(/not allowed/);
    expect(() =>
      allowlistedBillingUrl(
        "http://app.squadpitch.com/checkout",
        "https://app.squadpitch.com",
      ),
    ).toThrow(/not allowed/);
  });

  it("maps every Stripe subscription state conservatively", () => {
    expect(stripeSubscriptionStatus("active")).toBe("ACTIVE");
    expect(stripeSubscriptionStatus("trialing")).toBe("TRIALING");
    expect(stripeSubscriptionStatus("past_due")).toBe("PAST_DUE");
    expect(stripeSubscriptionStatus("unpaid")).toBe("PAST_DUE");
    expect(stripeSubscriptionStatus("incomplete")).toBe("CANCELED");
    expect(stripeSubscriptionStatus("paused")).toBe("CANCELED");
  });
});
