import { z } from "zod";

export const CreateCheckoutSchema = z.object({
  tier: z.enum(["STARTER", "GROWTH", "PRO"]),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
});

export const CreatePortalSchema = z.object({
  returnUrl: z.string().url(),
});
