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

// channel hints what surface the workspace user is drafting toward.
// "email"          — outbound email; full greeting + sign-off-ready
// "reply"          — logged-external (paste into another tool); brief, no greeting
// "note"           — internal team note about the lead; third-person, no greeting
// "public_comment" — public-surface reply (e.g. Facebook/Instagram
//                    comment). Shorter, safer, no PII; assume the
//                    whole internet can read it.
// "private_dm"     — direct message (FB/IG DM); more conversational
//                    like email but no sign-off — DMs are short.
// "review_reply"   — public response to a Google review (or future
//                    Yelp / FB Recommendation). Appreciative for
//                    positive reviews, calm + solution-oriented for
//                    negative ones, never repeats reviewer PII.
// Defaults to "email" because that's the only real outbound channel
// today; older clients that don't send the field still get sensible
// output.
export const AiReplyRequestSchema = z.object({
  tone: z.enum(["professional", "friendly", "concise"]).optional().default("professional"),
  // Phase 1 multilingual — optional per-request override. Falls
  // back to conversation.defaultReplyLanguage → workspace default
  // when omitted, via resolveLanguage in inbox.service.js.
  language: z.enum(["en", "es"]).optional(),
  channel: z
    .enum(["email", "reply", "note", "public_comment", "private_dm", "review_reply"])
    .optional()
    .default("email"),
});

// Inbox outbound email — first real send channel (Postmark).
// Body required; subject optional (service composes a default).
// fromSuggestionId optional for AI-provenance audit trail.
export const SendEmailSchema = z.object({
  body: z.string().min(1).max(8000),
  subject: z.string().max(300).optional(),
  fromSuggestionId: z.string().max(64).optional(),
});

// CRM-lite contact mutation. Every field is optional; the refine
// catches the no-op { } body. Email is validated as an email when
// non-null, but null is permitted so workspace users can clear a
// stale address (the service-layer still enforces that at least
// one of email/phone remains non-null on the resulting row).
//
// tags is REPLACE semantics — caller sends the full desired set.
// Keeps the API verb simple (one PATCH does it all) and avoids
// races between concurrent add/remove ops on the same row.
export const ContactStatusEnum = z.enum([
  "NEW",
  "ENGAGED",
  "QUALIFIED",
  "CONVERTED",
  "ARCHIVED",
]);

const trimToNull = (v) =>
  typeof v === "string" && v.trim().length === 0 ? null : v;

export const UpdateContactSchema = z
  .object({
    status: ContactStatusEnum.optional(),
    name: z.preprocess(trimToNull, z.string().max(240).nullable()).optional(),
    email: z
      .preprocess(trimToNull, z.string().email().max(320).nullable())
      .optional(),
    phone: z.preprocess(trimToNull, z.string().max(64).nullable()).optional(),
    tags: z.array(z.string().min(1).max(64)).max(24).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field must be provided",
  });
