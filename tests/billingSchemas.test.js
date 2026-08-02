import { describe, expect, it } from "vitest";

import {
  ChangePlanSchema,
  CreateCheckoutSchema,
  SignupPlanSchema,
} from "../domains/billing/billing.schemas.js";

describe("billing self-service tier schemas", () => {
  it.each([
    ["SOLO", "STARTER"],
    ["STARTER", "STARTER"],
    ["PRO", "PRO"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(SignupPlanSchema.parse({ tier: input }).tier).toBe(expected);
  });

  it.each(["TEAM", "GROWTH", "AGENCY", "FREE", "price_123", "UNKNOWN"])(
    "rejects non-self-service value %s",
    (tier) => {
      expect(SignupPlanSchema.safeParse({ tier }).success).toBe(false);
      expect(ChangePlanSchema.safeParse({ tier }).success).toBe(false);
      expect(
        CreateCheckoutSchema.safeParse({
          tier,
          successUrl: "https://app.squadpitch.com/billing",
          cancelUrl: "https://app.squadpitch.com/billing",
        }).success,
      ).toBe(false);
    },
  );
});
