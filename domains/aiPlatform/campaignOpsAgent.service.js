import { z } from "zod";
import crypto from "node:crypto";

import { env } from "../../config/env.js";
import { prisma } from "../../prisma.js";
import {
  getEffectiveTier,
  getSubscription,
} from "../billing/billing.service.js";
import { evaluateFlag } from "../internal/config.service.js";
import { assertCanActorPerformWorkspaceScope } from "../authorization/workspaceAuthorization.service.js";
import {
  callPythonCampaignOpsPlan,
  AI_PLATFORM_ERROR_CODES,
} from "./pythonAiPlatform.client.js";
import {
  emitAiExecution,
  hostedProvenance,
  pythonDomainPayload,
} from "./executionProvenance.js";
import { createAuthorizedAiServiceEnvelope } from "./serviceEnvelope.js";
import { queryWorkspaceRetrieval } from "./retrievalQuery.service.js";

export const CAMPAIGN_OPS_AGENT_ALLOWED_SCOPES = Object.freeze([
  "campaign-plan:read",
]);
export const CAMPAIGN_OPS_AGENT_MIN_TIERS = Object.freeze([
  "PRO",
  "GROWTH",
  "AGENCY",
]);

export const CAMPAIGN_OPS_AGENT_ERROR_CODES = Object.freeze({
  AUTH_REQUIRED: "AUTH_REQUIRED",
  FEATURE_DISABLED: "FEATURE_DISABLED",
  TIER_LIMIT: "TIER_LIMIT",
  WRITE_SCOPE_DENIED: "WRITE_SCOPE_DENIED",
  PROVIDER_TIMEOUT: AI_PLATFORM_ERROR_CODES.TIMEOUT,
  PROVIDER_UNAVAILABLE: AI_PLATFORM_ERROR_CODES.UNAVAILABLE,
  PROVIDER_INVALID_JSON: AI_PLATFORM_ERROR_CODES.INVALID_JSON,
  SCHEMA_INVALID: AI_PLATFORM_ERROR_CODES.SCHEMA_INVALID,
});

const citationSchema = z.object({
  sourceType: z.string().min(1),
  sourceId: z.string().min(1),
  workspaceId: z.string().min(1),
  contentHash: z.string().min(1),
  trust: z.string().min(1),
});

const requiredFactSchema = z.object({
  name: z.string().min(1),
  status: z.enum(["available", "missing", "unavailable"]),
  sourceId: z.string().min(1).nullable().optional(),
});

const postProposalSchema = z
  .object({
    day: z.number().int().min(1).max(14),
    channel: z.string().min(1),
    suggestedTime: z.string().datetime(),
    contentBrief: z.string().min(1),
    requiredFacts: z.array(requiredFactSchema),
    citations: z.array(citationSchema),
    mediaRecommendations: z.array(z.string()),
    risks: z.array(z.string()),
    approvalRequirements: z.array(z.string()).min(1),
  })
  .strict();

export const campaignOpsPlanResponseSchema = z
  .object({
    schemaVersion: z.literal("campaign-ops-plan.v1"),
    planId: z.string().min(1),
    objective: z.string().min(1),
    strategy: z.string().min(1),
    proposedPosts: z.array(postProposalSchema).min(1),
    citations: z.array(citationSchema),
    mediaRecommendations: z.array(z.string()),
    risks: z.array(z.string()),
    validationStatus: z.object({
      valid: z.boolean(),
      warnings: z.array(z.string()),
      missingFacts: z.array(z.string()),
      calendarConflicts: z.array(z.string()),
    }),
    approvalRequirements: z.array(z.string()).min(1),
    modelMetadata: z.object({
      implementation: z.literal("python"),
      model: z.string().min(1),
      promptVersion: z.string().min(1),
    }),
    traceId: z.string().min(1),
    expiresAt: z.string().datetime(),
    proposalOnly: z.literal(true),
  })
  .strict()
  .superRefine((value, ctx) => {
    for (const citation of value.citations) {
      if (citation.workspaceId !== value.citations[0]?.workspaceId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["citations"],
          message: "citations must use one workspace",
        });
      }
    }
  });

function actorId(actor) {
  return actor?.auth0Sub ?? actor?.sub ?? actor?.id ?? null;
}

function typedError(code, message, status = 400, details = {}) {
  const err = new Error(message);
  err.code = code;
  err.status = status;
  Object.assign(err, details);
  return err;
}

function assertReadOnlyScopes(scopes) {
  const requested = scopes ?? CAMPAIGN_OPS_AGENT_ALLOWED_SCOPES;
  const invalid = requested.filter(
    (scope) => !CAMPAIGN_OPS_AGENT_ALLOWED_SCOPES.includes(scope),
  );
  if (invalid.length > 0) {
    throw typedError(
      CAMPAIGN_OPS_AGENT_ERROR_CODES.WRITE_SCOPE_DENIED,
      "Campaign ops agent is read-only",
      403,
      { invalidScopes: invalid },
    );
  }
  return requested;
}

export async function buildCampaignOpsSnapshot({
  workspaceId,
  objective,
  sourceId,
  prismaClient = prisma,
}) {
  const [
    client,
    brand,
    voice,
    contentPreferences,
    property,
    media,
    approvedDrafts,
    scheduledDrafts,
  ] = await Promise.all([
    prismaClient.client.findUnique({
      where: { id: workspaceId },
      select: {
        id: true,
        name: true,
        industryKey: true,
        defaultLanguage: true,
      },
    }),
    prismaClient.brandProfile?.findUnique?.({
      where: { clientId: workspaceId },
    }) ?? null,
    prismaClient.voiceProfile?.findUnique?.({
      where: { clientId: workspaceId },
    }) ?? null,
    prismaClient.contentPreferences?.findUnique?.({
      where: { clientId: workspaceId },
    }) ?? null,
    sourceId
      ? prismaClient.workspaceDataItem.findFirst({
          where: { id: sourceId, clientId: workspaceId, status: "ACTIVE" },
        })
      : prismaClient.workspaceDataItem.findFirst({
          where: { clientId: workspaceId, status: "ACTIVE" },
          orderBy: { updatedAt: "desc" },
        }),
    prismaClient.mediaAsset.findMany({
      where: { clientId: workspaceId, status: { not: "FAILED" } },
      take: 10,
      orderBy: { createdAt: "desc" },
    }),
    prismaClient.draft.findMany({
      where: {
        clientId: workspaceId,
        status: { in: ["APPROVED", "PUBLISHED"] },
      },
      take: 10,
      orderBy: { updatedAt: "desc" },
    }),
    prismaClient.draft.findMany({
      where: { clientId: workspaceId, status: "SCHEDULED" },
      take: 14,
      orderBy: { scheduledAt: "asc" },
    }),
  ]);

  const items = [
    client &&
      snapshotItem(
        "campaign",
        "workspace",
        `Workspace: ${client.name}`,
        client,
      ),
    brand && snapshotItem("brand_profile", "brand", "Brand profile", brand),
    voice && snapshotItem("voice_profile", "voice", "Voice profile", voice),
    contentPreferences &&
      snapshotItem(
        "content_preferences",
        "content-preferences",
        "Content preferences",
        contentPreferences,
      ),
    property &&
      snapshotItem(
        "property_listing",
        property.id,
        "Property/listing facts",
        property,
      ),
    ...approvedDrafts.map((draft) =>
      snapshotItem("draft", draft.id, draft.title || "Approved example", draft),
    ),
  ].filter(Boolean);

  return {
    workspaceId,
    objective,
    items,
    media: media.map((asset) => ({
      assetId: asset.id,
      label: asset.altText || asset.filename || asset.id,
      mediaType: asset.assetType || "image",
      tags: asset.tags || [],
    })),
    calendar: scheduledDrafts.map((draft) => ({
      channel: draft.channel,
      scheduledFor: (
        draft.scheduledAt ||
        draft.createdAt ||
        new Date()
      ).toISOString(),
      title: draft.title || draft.campaignName || "Scheduled draft",
    })),
    approvalPolicy: {
      requiresHumanApproval: true,
      notes:
        "Proposal only. Human approval required before creating drafts or scheduling.",
    },
    allowedChannels: [
      "INSTAGRAM",
      "FACEBOOK",
      "LINKEDIN",
      "GOOGLE_BUSINESS_PROFILE",
    ],
  };
}

function snapshotItem(sourceType, sourceId, title, value) {
  const text = JSON.stringify(value, (_key, raw) => {
    if (raw instanceof Date) return raw.toISOString();
    return raw;
  });
  const digest = crypto.createHash("sha256").update(text).digest("hex");
  return {
    sourceType,
    sourceId,
    title,
    text,
    contentHash: `sha256:${digest}`,
    trust: sourceType === "property_listing" ? "authoritative" : "approved",
    language: value.defaultLanguage || "en",
  };
}

export async function generateCampaignOpsAgentPreview({
  actor,
  workspaceId,
  objective,
  sourceId,
  requestedScopes,
  traceId,
  featureEnabled = env.AI_CAMPAIGN_OPS_AGENT_ENABLED,
  pythonBaseUrl = env.AI_PLATFORM_INTERNAL_BASE_URL,
  timeoutMs = env.AI_PLATFORM_HEALTH_TIMEOUT_MS,
  serviceAuthKeyId = env.AI_PLATFORM_SERVICE_AUTH_KEY_ID,
  serviceAuthSecret = env.AI_PLATFORM_SERVICE_AUTH_SECRET,
  prismaClient = prisma,
  authorizationService = assertCanActorPerformWorkspaceScope,
  featureFlagEvaluator = evaluateFlag,
  subscriptionFetcher = getSubscription,
  effectiveTierResolver = getEffectiveTier,
  snapshotBuilder = buildCampaignOpsSnapshot,
  pythonClient = callPythonCampaignOpsPlan,
  retrievalService = queryWorkspaceRetrieval,
  retrievalPlatformEnabled,
  retrievalFeatureEnabled,
} = {}) {
  const startedAt = Date.now();
  const actorUserId = actorId(actor);
  if (!actorUserId) {
    throw typedError(
      CAMPAIGN_OPS_AGENT_ERROR_CODES.AUTH_REQUIRED,
      "Authentication required",
      401,
    );
  }
  const scopes = assertReadOnlyScopes(requestedScopes);

  await authorizationService({
    actor,
    workspaceId,
    scope: "campaign-plan:read",
    allowAdmin: false,
  });

  const flagEnabled =
    featureEnabled === true ||
    (await featureFlagEvaluator("ai_campaign_ops_agent_enabled", {
      workspaceId,
      userId: actorUserId,
    }));
  if (!flagEnabled) {
    throw typedError(
      CAMPAIGN_OPS_AGENT_ERROR_CODES.FEATURE_DISABLED,
      "Feature disabled",
      404,
    );
  }

  const subscription = await subscriptionFetcher(actorUserId);
  const tier = effectiveTierResolver(subscription);
  if (!CAMPAIGN_OPS_AGENT_MIN_TIERS.includes(tier)) {
    throw typedError(
      CAMPAIGN_OPS_AGENT_ERROR_CODES.TIER_LIMIT,
      "Campaign ops agent requires a paid plan",
      402,
      { tier },
    );
  }

  let snapshot = await snapshotBuilder({
    workspaceId,
    objective,
    sourceId,
    prismaClient,
  });
  let retrievalProvenance = null;
  try {
    const retrieval = await retrievalService({
      actor,
      workspaceId,
      query: objective,
      purpose: "campaign_context",
      topK: 5,
      snapshotItems: snapshot.items,
      traceId: traceId ? `${traceId}:retrieval` : undefined,
      platformEnabled: retrievalPlatformEnabled,
      retrievalEnabled: retrievalFeatureEnabled,
      pythonBaseUrl,
      timeoutMs,
      serviceAuthKeyId,
      serviceAuthSecret,
      authorizationService,
      featureFlagEvaluator,
    });
    retrievalProvenance = retrieval.provenance;
    snapshot = {
      ...snapshot,
      items: [
        ...snapshot.items,
        ...retrieval.results.map((item) => ({
          sourceType: item.citation.sourceType,
          sourceId: item.citation.sourceId,
          title: item.metadata?.sourceTitle ?? item.citation.sourceId,
          text: item.text,
          contentHash: item.citation.contentHash,
          trust: item.citation.trustClassification,
          language: item.citation.language,
        })),
      ],
    };
  } catch {
    // Retrieval is optional context augmentation. Existing campaign planning
    // remains usable when disabled, empty, or unavailable.
  }
  const envelope = await createAuthorizedAiServiceEnvelope({
    actor,
    workspaceId,
    scopes,
    payload: {
      workspaceId,
      objective,
      snapshot,
      proposalOnly: true,
    },
    keyId: serviceAuthKeyId,
    secret: serviceAuthSecret,
    ...(traceId ? { requestId: traceId, traceId } : {}),
    authorizationService,
  });

  const serviceStartedAt = Date.now();
  const result = await pythonClient({
    enabled: true,
    baseUrl: pythonBaseUrl,
    timeoutMs,
    envelope,
  });
  const serviceLatencyMs = Date.now() - serviceStartedAt;
  if (!result.ok) {
    throw typedError(
      result.errorCode ?? CAMPAIGN_OPS_AGENT_ERROR_CODES.PROVIDER_UNAVAILABLE,
      "Campaign ops agent provider failed",
      result.errorCode === AI_PLATFORM_ERROR_CODES.TIMEOUT ? 504 : 503,
      { providerStatus: result.status },
    );
  }

  const parsed = campaignOpsPlanResponseSchema.parse(
    pythonDomainPayload(result),
  );
  const citations = [
    ...parsed.citations,
    ...parsed.proposedPosts.flatMap((post) => post.citations),
  ];
  if (citations.some((citation) => citation.workspaceId !== workspaceId)) {
    throw typedError(
      CAMPAIGN_OPS_AGENT_ERROR_CODES.SCHEMA_INVALID,
      "Citation workspace mismatch",
      422,
    );
  }
  const provenance = hostedProvenance({
    operation: "campaign_ops_plan",
    envelope,
    pythonResult: result,
    startedAt,
    serviceLatencyMs,
    featureFlag: true,
  });
  emitAiExecution(provenance, { workspaceId, actorUserId });
  const response = {
    status: "proposal_only",
    benchmarkAgainst: "node_campaign_generation",
    oldNodePathUnaffected: true,
    proposal: parsed,
    provenance,
  };
  Object.defineProperty(response, "retrievalProvenance", {
    value: retrievalProvenance,
    enumerable: false,
  });
  return response;
}
