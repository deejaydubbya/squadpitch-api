import { z } from "zod";

export const CreateCheckoutSchema = z.object({
  tier: z.enum(["STARTER", "PRO", "GROWTH", "AGENCY"]),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

export const CreatePortalSchema = z.object({
  returnUrl: z.string().url(),
});

export const ChangePlanSchema = z.object({
  tier: z.enum(["STARTER", "PRO", "GROWTH", "AGENCY"]),
});
