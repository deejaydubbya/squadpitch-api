// Zod schemas for the authenticated SquadInbox API.

import { z } from "zod";

export const ConversationStatusEnum = z.enum([
  "OPEN",
  "PENDING",
  "CLOSED",
  "SNOOZED",
]);

export const ListConversationsQuerySchema = z.object({
  status: ConversationStatusEnum.optional(),
  spam: z
    .union([z.literal("true"), z.literal("false")])
    .transform((v) => v === "true")
    .optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  cursor: z.string().max(64).optional(),
});

export const UpdateConversationSchema = z
  .object({
    status: ConversationStatusEnum.optional(),
    spam: z.boolean().optional(),
    assignedUserId: z.string().max(120).nullable().optional(),
    markRead: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
  });

export const CreateNoteSchema = z.object({
  body: z.string().min(1).max(4000),
});

// Manual outbound message — MVP has no email/SMS providers, so
// this just records that the workspace user replied externally.
export const ManualMessageSchema = z.object({
  body: z.string().min(1).max(4000),
  channel: z
    .enum(["MANUAL_LOG", "EMAIL", "SMS"])
    .optional()
    .default("MANUAL_LOG"),
  fromSuggestionId: z.string().max(64).optional(),
});

export const AiReplyRequestSchema = z.object({
  tone: z.enum(["professional", "friendly", "concise"]).optional().default("professional"),
});
