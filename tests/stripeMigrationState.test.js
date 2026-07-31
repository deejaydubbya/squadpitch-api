import { describe, expect, it } from "vitest";

import {
  RESET_CONFIRMATION,
  parseResetAuthorization,
  summarizeStripeMigrationState,
} from "../scripts/stripe-migration/state.js";

describe("Stripe migration state tooling", () => {
  it("summarizes state without exposing user or Stripe identifiers", () => {
    const report = summarizeStripeMigrationState(
      [{
        userId: "auth0|sensitive-user",
        tier: "PRO",
        status: "CANCELED",
        stripeCustomerId: "cus_sensitive",
        stripeSubscriptionId: "sub_sensitive",
        lastStripeEventId: "evt_sensitive",
        lastStripeEventCreated: 123,
      }],
      [{
        userId: "auth0|sensitive-user",
        status: "CHECKOUT_CREATED",
        stripeCheckoutSessionId: "cs_sensitive",
      }],
    );
    const serialized = JSON.stringify(report);
    expect(report.subscription.total).toBe(1);
    expect(report.signupPlanIntent.total).toBe(1);
    expect(report.affectedUsers.total).toBe(1);
    expect(serialized).not.toContain("sensitive-user");
    expect(serialized).not.toContain("cus_sensitive");
    expect(serialized).not.toContain("sub_sensitive");
    expect(serialized).not.toContain("cs_sensitive");
  });

  it("refuses reset unless every safeguard is explicit", () => {
    expect(parseResetAuthorization([]).errors.length).toBeGreaterThan(0);
    expect(
      parseResetAuthorization([
        "--execute",
        "--backup-confirmed",
        "--no-real-customers-confirmed",
        `--confirm=${RESET_CONFIRMATION}`,
        "--expect-subscriptions=2",
        "--expect-intents=1",
      ]),
    ).toEqual({ errors: [], expectedSubscriptions: 2, expectedIntents: 1 });
  });
});
