import { z } from "zod";

export const CreateCheckoutSchema = z.object({
  tier: z.enum(["STARTER", "PRO", "GROWTH", "AGENCY"]),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  idempotencyKey: z.string().uuid().optional(),
});

export const CreatePortalSchema = z.object({
  returnUrl: z.string().url(),
});

export const ChangePlanSchema = z.object({
  tier: z.enum(["STARTER", "PRO", "GROWTH", "AGENCY"]),
});

export const SignupPlanSchema = z.object({
  tier: z.enum(["STARTER", "PRO", "GROWTH", "AGENCY"]),
});
