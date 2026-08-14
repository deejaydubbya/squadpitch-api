import { z } from "zod";

export const FeedbackType = z.enum(["bug", "feature_request", "ux_issue", "general"]);
export const FeedbackStatus = z.enum(["new", "reviewing", "planned", "resolved", "closed"]);
export const FeedbackPriority = z.enum(["low", "normal", "high", "urgent"]);

export const SubmitFeedbackSchema = z.object({
  type: FeedbackType,
  message: z.string().trim().min(1).max(5000),
  clientId: z.string().min(1).max(80).nullable().optional(),
  route: z.string().max(500).nullable().optional(),
  releaseVersion: z.string().max(100).nullable().optional(),
  deviceClass: z.enum(["mobile", "tablet", "desktop"]).nullable().optional(),
  viewport: z.object({ width: z.number().int().min(1).max(10000), height: z.number().int().min(1).max(10000) }).optional(),
  idempotencyKey: z.string().uuid(),
});

export const UpdateFeedbackSchema = z.object({
  status: FeedbackStatus.optional(),
  priority: FeedbackPriority.optional(),
  adminNote: z.string().max(4000).nullable().optional(),
}).refine((value) => Object.keys(value).length > 0);

export function safeFeedbackRoute(value) {
  if (typeof value !== "string") return null;
  const path = value.split(/[?#]/, 1)[0];
  return path.startsWith("/") && path.length <= 500 ? path : null;
}
