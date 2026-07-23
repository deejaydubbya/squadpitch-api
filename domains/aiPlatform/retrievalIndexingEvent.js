import crypto from "node:crypto";
import { z } from "zod";

import { assertCanActorPerformWorkspaceScope } from "../authorization/workspaceAuthorization.service.js";

export const AI_RETRIEVAL_INDEXING_EVENT_SCHEMA_VERSION = "ai-indexing-event-v1";

export const AI_RETRIEVAL_SOURCE_TYPES = Object.freeze([
  "brand_profile",
  "voice_profile",
  "content_preferences",
  "workspace_data_item",
  "property_listing",
  "draft",
  "campaign",
  "site_page",
  "conversation_knowledge",
  "review_knowledge",
  "media_metadata",
  "publishing_calendar_snapshot",
]);

export const AI_RETRIEVAL_TRUST_CLASSIFICATIONS = Object.freeze([
  "authoritative",
  "approved",
  "derived",
  "user_supplied",
  "private_sensitive",
  "low_trust",
]);

export const AI_RETRIEVAL_ACL_SCOPES = Object.freeze([
  "campaign_context",
  "retrieval_query",
  "internal_eval",
]);

export const AI_RETRIEVAL_INDEXING_OPERATIONS = Object.freeze([
  "upsert",
  "delete",
  "permission_change",
]);

export const aiRetrievalIndexingEventSchema = z
  .object({
    schemaVersion: z.literal(AI_RETRIEVAL_INDEXING_EVENT_SCHEMA_VERSION),
    eventId: z.string().min(1).max(128),
    requestId: z.string().min(1).max(128),
    traceId: z.string().min(1).max(128),
    workspaceId: z.string().min(1).max(128),
    sourceType: z.enum(AI_RETRIEVAL_SOURCE_TYPES),
    sourceId: z.string().min(1).max(128),
    operation: z.enum(AI_RETRIEVAL_INDEXING_OPERATIONS),
    aclScope: z.enum(AI_RETRIEVAL_ACL_SCOPES),
    language: z.string().min(2).max(16).default("en"),
    trustClassification: z.enum(AI_RETRIEVAL_TRUST_CLASSIFICATIONS),
    sourceUpdatedAt: z.string().datetime(),
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    payload: z.record(z.unknown()).default({}),
  })
  .superRefine((value, ctx) => {
    if (value.payload.workspaceId != null && value.payload.workspaceId !== value.workspaceId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["payload", "workspaceId"],
        message: "payload workspaceId must match event workspaceId",
      });
    }
  });

export async function createAuthorizedAiRetrievalIndexingEvent({
  actor,
  workspaceId,
  sourceType,
  sourceId,
  operation = "upsert",
  aclScope = "campaign_context",
  language = "en",
  trustClassification,
  sourceUpdatedAt = new Date(),
  contentHash,
  payload = {},
  requestId = crypto.randomUUID(),
  traceId = requestId,
  eventId = crypto.randomUUID(),
  allowAdmin = false,
  authorizationService = assertCanActorPerformWorkspaceScope,
} = {}) {
  await authorizationService({
    actor,
    workspaceId,
    scope: "retrieval:query",
    allowAdmin,
  });

  return aiRetrievalIndexingEventSchema.parse({
    schemaVersion: AI_RETRIEVAL_INDEXING_EVENT_SCHEMA_VERSION,
    eventId,
    requestId,
    traceId,
    workspaceId,
    sourceType,
    sourceId,
    operation,
    aclScope,
    language,
    trustClassification,
    sourceUpdatedAt: sourceUpdatedAt.toISOString(),
    contentHash,
    payload,
  });
}
