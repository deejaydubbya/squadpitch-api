import crypto from "node:crypto";
import { z } from "zod";

import { env } from "../../config/env.js";
import { assertCanActorPerformWorkspaceScope } from "../authorization/workspaceAuthorization.service.js";
import { evaluateFlag } from "../internal/config.service.js";
import {
  emitAiExecution,
  hostedProvenance,
  pythonDomainPayload,
} from "./executionProvenance.js";
import {
  AI_RETRIEVAL_INDEXING_EVENT_SCHEMA_VERSION,
  aiRetrievalIndexingEventSchema,
} from "./retrievalIndexingEvent.js";
import { callPythonRetrievalQuery } from "./pythonAiPlatform.client.js";
import { createAuthorizedAiServiceEnvelope } from "./serviceEnvelope.js";

const sourceTypes = [
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
];
const trustTypes = [
  "authoritative",
  "approved",
  "derived",
  "user_supplied",
  "private_sensitive",
  "low_trust",
];

const citationSchema = z
  .object({
    workspaceId: z.string().min(1),
    sourceType: z.enum(sourceTypes),
    sourceId: z.string().min(1),
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    chunkId: z.string().min(1),
    trustClassification: z.enum(trustTypes),
    language: z.string().min(2),
  })
  .strict();

const resultSchema = z
  .object({
    text: z.string(),
    citation: citationSchema,
    score: z.number(),
    keywordScore: z.number(),
    vectorScore: z.number(),
    recencyScore: z.number(),
    trustScore: z.number(),
    metadata: z.record(z.unknown()),
    containsUntrustedInstruction: z.boolean(),
  })
  .strict();

export const retrievalQueryResponseSchema = z
  .object({
    schemaVersion: z.literal("retrieval-query-response.v1"),
    workspaceId: z.string().min(1),
    purpose: z.string().min(1),
    results: z.array(resultSchema),
    resultCount: z.number().int().min(0),
    empty: z.boolean(),
    topK: z.number().int().min(1).max(25),
    traceId: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.resultCount !== value.results.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["resultCount"],
        message: "resultCount must match results",
      });
    }
    if (value.empty !== (value.results.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["empty"],
        message: "empty must match results",
      });
    }
  });

export async function queryWorkspaceRetrieval({
  actor,
  workspaceId,
  query,
  purpose = "campaign_context",
  topK = 5,
  sourceTypes: filters,
  snapshotItems = [],
  traceId,
  platformEnabled,
  retrievalEnabled = env.AI_RETRIEVAL_ENABLED,
  pythonBaseUrl = env.AI_PLATFORM_INTERNAL_BASE_URL,
  timeoutMs = env.AI_PLATFORM_HEALTH_TIMEOUT_MS,
  serviceAuthKeyId = env.AI_PLATFORM_SERVICE_AUTH_KEY_ID,
  serviceAuthSecret = env.AI_PLATFORM_SERVICE_AUTH_SECRET,
  authorizationService = assertCanActorPerformWorkspaceScope,
  featureFlagEvaluator = evaluateFlag,
  pythonClient = callPythonRetrievalQuery,
} = {}) {
  const startedAt = Date.now();
  const actorUserId = actor?.auth0Sub ?? actor?.sub ?? actor?.id;
  if (!actorUserId)
    throw typedError("AUTH_REQUIRED", "Authentication required", 401);
  await authorizationService({
    actor,
    workspaceId,
    scope: "retrieval:query",
    allowAdmin: false,
  });
  const platformFlag =
    platformEnabled === true ||
    (await featureFlagEvaluator("ai_platform_enabled", {
      workspaceId,
      userId: actorUserId,
    }));
  const retrievalFlag =
    retrievalEnabled === true ||
    (await featureFlagEvaluator("ai_retrieval_enabled", {
      workspaceId,
      userId: actorUserId,
    }));
  if (!platformFlag || !retrievalFlag) {
    throw typedError("FEATURE_DISABLED", "Hosted retrieval is disabled", 404);
  }

  const indexingEvents = snapshotItems.map((item, index) =>
    indexingEventForSnapshotItem({ item, index, workspaceId, traceId }),
  );
  const envelope = await createAuthorizedAiServiceEnvelope({
    actor,
    workspaceId,
    scopes: ["retrieval:query"],
    payload: {
      schemaVersion: "retrieval-query.v1",
      workspaceId,
      query,
      purpose,
      topK,
      ...(filters ? { sourceTypes: filters } : {}),
      aclScopes: ["campaign_context"],
      maxContextChars: 4000,
      indexingEvents,
    },
    keyId: serviceAuthKeyId,
    secret: serviceAuthSecret,
    ...(traceId ? { requestId: traceId, traceId } : {}),
    authorizationService,
  });
  const serviceStartedAt = Date.now();
  const pythonResult = await pythonClient({
    enabled: true,
    baseUrl: pythonBaseUrl,
    timeoutMs,
    envelope,
  });
  const serviceLatencyMs = Date.now() - serviceStartedAt;
  if (!pythonResult.ok) {
    throw typedError(
      pythonResult.errorCode ?? "PROVIDER_UNAVAILABLE",
      "Retrieval provider failed",
      pythonResult.status === "timeout" ? 504 : 503,
    );
  }
  const result = retrievalQueryResponseSchema.parse(
    pythonDomainPayload(pythonResult),
  );
  if (
    result.workspaceId !== workspaceId ||
    result.results.some((item) => item.citation.workspaceId !== workspaceId)
  ) {
    throw typedError("TENANT_LEAKAGE", "Retrieval workspace mismatch", 422);
  }
  const provenance = hostedProvenance({
    operation: "retrieval_query",
    envelope,
    pythonResult,
    startedAt,
    serviceLatencyMs,
    featureFlag: true,
  });
  emitAiExecution(provenance, { workspaceId, actorUserId });
  return { ...result, provenance };
}

function indexingEventForSnapshotItem({ item, index, workspaceId, traceId }) {
  const sourceType = sourceTypes.includes(item.sourceType)
    ? item.sourceType
    : "workspace_data_item";
  const sourceId = String(item.sourceId ?? `snapshot-${index}`).slice(0, 128);
  const text = String(item.text ?? "").slice(0, 24_000);
  const contentHash =
    typeof item.contentHash === "string"
      ? item.contentHash
      : `sha256:${crypto.createHash("sha256").update(text).digest("hex")}`;
  const stable = crypto
    .createHash("sha256")
    .update(`${workspaceId}:${sourceType}:${sourceId}:${contentHash}`)
    .digest("hex")
    .slice(0, 32);
  return aiRetrievalIndexingEventSchema.parse({
    schemaVersion: AI_RETRIEVAL_INDEXING_EVENT_SCHEMA_VERSION,
    eventId: `retrieval-${stable}`,
    requestId: traceId ?? `retrieval-${stable}`,
    traceId: traceId ?? `retrieval-${stable}`,
    workspaceId,
    sourceType,
    sourceId,
    operation: "upsert",
    aclScope: "campaign_context",
    language: item.language ?? "en",
    trustClassification: trustTypes.includes(item.trust)
      ? item.trust
      : "approved",
    sourceUpdatedAt: new Date().toISOString(),
    contentHash,
    payload: {
      approvedText: text,
      sourceTitle: item.title ?? sourceId,
      workspaceId,
    },
  });
}

function typedError(code, message, status) {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
}
