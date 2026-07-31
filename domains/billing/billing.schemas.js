import { z } from "zod";

import { normalizeSelfServiceTier } from "./billing.constants.js";

const SelfServiceTierSchema = z.string().transform((value, ctx) => {
  const tier = normalizeSelfServiceTier(value);
  if (!tier) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Unknown self-service plan",
    });
    return z.NEVER;
  }
  return tier;
});

export const CreateCheckoutSchema = z.object({
  tier: SelfServiceTierSchema,
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  idempotencyKey: z.string().uuid().optional(),
});

export const CreatePortalSchema = z.object({
  returnUrl: z.string().url(),
});

export const ChangePlanSchema = z.object({
  tier: SelfServiceTierSchema,
});

export const SignupPlanSchema = z.object({
  tier: SelfServiceTierSchema,
});
