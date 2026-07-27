import crypto from "node:crypto";
import { z } from "zod";

import { env } from "../../config/env.js";
import { prisma } from "../../prisma.js";
import {
  getEffectiveTier,
  getSubscription,
} from "../billing/billing.service.js";
import { evaluateFlag } from "../internal/config.service.js";
import { assertCanActorPerformWorkspaceScope } from "../authorization/workspaceAuthorization.service.js";
import { buildCampaignOpsSnapshot } from "./campaignOpsAgent.service.js";
import {
  callPythonDraftContentProposal,
  AI_PLATFORM_ERROR_CODES,
} from "./pythonAiPlatform.client.js";
import {
  emitAiExecution,
  hostedProvenance,
  pythonDomainPayload,
} from "./executionProvenance.js";
import { createAuthorizedAiServiceEnvelope } from "./serviceEnvelope.js";

export const AI_ACTION_PROPOSAL_ERROR_CODES = Object.freeze({
  AUTH_REQUIRED: "AUTH_REQUIRED",
  FEATURE_DISABLED: "FEATURE_DISABLED",
  TIER_LIMIT: "TIER_LIMIT",
  DUPLICATE_IDEMPOTENCY_KEY: "DUPLICATE_IDEMPOTENCY_KEY",
  REPLAYED_APPROVAL: "REPLAYED_APPROVAL",
  EXPIRED_PROPOSAL: "EXPIRED_PROPOSAL",
  CONTENT_HASH_MISMATCH: "CONTENT_HASH_MISMATCH",
  CROSS_WORKSPACE_REFERENCE: "CROSS_WORKSPACE_REFERENCE",
  INVALID_FACT: "INVALID_FACT",
  UNSUPPORTED_CHANNEL: "UNSUPPORTED_CHANNEL",
  FAIR_HOUSING_POLICY: "FAIR_HOUSING_POLICY",
  SCHEDULE_CONFLICT: "SCHEDULE_CONFLICT",
  SCHEMA_INVALID: AI_PLATFORM_ERROR_CODES.SCHEMA_INVALID,
  PROVIDER_UNAVAILABLE: AI_PLATFORM_ERROR_CODES.UNAVAILABLE,
});

const ALLOWED_CHANNELS = new Set([
  "INSTAGRAM",
  "TIKTOK",
  "X",
  "LINKEDIN",
  "LINKEDIN_ORGANIZATION_PAGE",
  "FACEBOOK",
  "YOUTUBE",
  "PINTEREST",
  "THREADS",
  "GOOGLE_BUSINESS_PROFILE",
]);
const MIN_TIERS = new Set(["PRO", "GROWTH", "AGENCY"]);
const DRAFT_PROPOSAL_SCHEMA_VERSION = "draft-content-proposal.v1";
const FAIR_HOUSING_PATTERNS = [
  /\bperfect for families\b/i,
  /\bsafe neighborhood\b/i,
  /\bexclusive community\b/i,
  /\bno children\b/i,
];

const citationSchema = z
  .object({
    sourceType: z.string().min(1),
    sourceId: z.string().min(1),
    workspaceId: z.string().min(1),
    contentHash: z.string().min(1),
    trust: z.string().min(1),
  })
  .strict();

const requiredFactSchema = z
  .object({
    name: z.string().min(1),
    status: z.enum(["available", "missing", "unavailable"]),
    sourceId: z.string().min(1).nullable().optional(),
  })
  .strict();

const proposedDraftSchema = z
  .object({
    channel: z.string().min(1),
    body: z.string().min(1),
    cta: z.string().nullable().optional(),
    hashtags: z.array(z.string()),
    scheduledFor: z.string().datetime().nullable().optional(),
    mediaAssetIds: z.array(z.string()),
    dataItemIds: z.array(z.string()),
    requiredFacts: z.array(requiredFactSchema),
    citations: z.array(citationSchema),
    validationHints: z.array(z.string()),
  })
  .strict();

export const draftContentProposalResponseSchema = z
  .object({
    schemaVersion: z.literal(DRAFT_PROPOSAL_SCHEMA_VERSION),
    proposalType: z.literal("draft_content"),
    proposalVersion: z.literal("draft-proposal.v1"),
    workspaceId: z.string().min(1),
    objective: z.string().min(1),
    proposedDrafts: z.array(proposedDraftSchema).min(1),
    citations: z.array(citationSchema),
    validationStatus: z
      .object({
        valid: z.boolean(),
        warnings: z.array(z.string()),
        missingFacts: z.array(z.string()),
        calendarConflicts: z.array(z.string()),
      })
      .strict(),
    modelMetadata: z
      .object({
        implementation: z.literal("python"),
        model: z.string().min(1),
        promptVersion: z.string().min(1),
      })
      .strict(),
    traceId: z.string().min(1),
    expiresAt: z.string().datetime(),
    contentHash: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    proposalOnly: z.literal(true),
  })
  .strict();

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

export function contentHashForProposalPayload(payload) {
  const normalized = JSON.stringify(sortJson(payload));
  return `sha256:${crypto.createHash("sha256").update(normalized).digest("hex")}`;
}

function sortJson(value) {
  if (Array.isArray(value)) {
    return value.map(sortJson);
  }
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, raw]) => [key, sortJson(raw)]),
    );
  }
  return value;
}

function normalizeProposalPayload(proposal) {
  return {
    schemaVersion: proposal.schemaVersion,
    proposalType: proposal.proposalType,
    proposalVersion: proposal.proposalVersion,
    workspaceId: proposal.workspaceId,
    objective: proposal.objective,
    proposedDrafts: proposal.proposedDrafts,
    citations: proposal.citations,
    validationStatus: proposal.validationStatus,
    modelMetadata: proposal.modelMetadata,
    traceId: proposal.traceId,
    expiresAt: proposal.expiresAt,
    contentHash: proposal.contentHash,
    proposalOnly: true,
  };
}

async function assertFeatureAndTier({
  actorUserId,
  workspaceId,
  featureEnabled,
  featureFlagEvaluator,
  subscriptionFetcher,
  effectiveTierResolver,
}) {
  const flagEnabled =
    featureEnabled === true ||
    (await featureFlagEvaluator("ai_action_proposals_enabled", {
      workspaceId,
      userId: actorUserId,
    }));
  if (!flagEnabled) {
    throw typedError(
      AI_ACTION_PROPOSAL_ERROR_CODES.FEATURE_DISABLED,
      "AI action proposals are disabled",
      404,
      { fallback: "aiGenerationService.js" },
    );
  }
  const subscription = await subscriptionFetcher(actorUserId);
  const tier = effectiveTierResolver(subscription);
  if (!MIN_TIERS.has(tier)) {
    throw typedError(
      AI_ACTION_PROPOSAL_ERROR_CODES.TIER_LIMIT,
      "AI action proposals require a paid plan",
      402,
      { tier },
    );
  }
}

export async function validateDraftContentProposal({
  proposal,
  workspaceId,
  prismaClient = prisma,
  now = new Date(),
  skipReferenceChecks = false,
}) {
  const parsed = draftContentProposalResponseSchema.parse(proposal);
  if (parsed.workspaceId !== workspaceId) {
    throw typedError(
      AI_ACTION_PROPOSAL_ERROR_CODES.CROSS_WORKSPACE_REFERENCE,
      "Proposal workspace mismatch",
      422,
    );
  }
  if (new Date(parsed.expiresAt).getTime() <= now.getTime()) {
    throw typedError(
      AI_ACTION_PROPOSAL_ERROR_CODES.EXPIRED_PROPOSAL,
      "Proposal is expired",
      410,
    );
  }

  const validationErrors = [];
  const mediaIds = new Set();
  const dataItemIds = new Set();
  for (const draft of parsed.proposedDrafts) {
    if (!ALLOWED_CHANNELS.has(draft.channel)) {
      throw typedError(
        AI_ACTION_PROPOSAL_ERROR_CODES.UNSUPPORTED_CHANNEL,
        "Unsupported proposal channel",
        422,
        {
          channel: draft.channel,
        },
      );
    }
    if (draft.requiredFacts.some((fact) => fact.status !== "available")) {
      throw typedError(
        AI_ACTION_PROPOSAL_ERROR_CODES.INVALID_FACT,
        "Proposal includes unavailable or missing facts",
        422,
      );
    }
    if (FAIR_HOUSING_PATTERNS.some((pattern) => pattern.test(draft.body))) {
      throw typedError(
        AI_ACTION_PROPOSAL_ERROR_CODES.FAIR_HOUSING_POLICY,
        "Proposal violates advertising policy",
        422,
      );
    }
    for (const citation of draft.citations) {
      if (citation.workspaceId !== workspaceId) {
        throw typedError(
          AI_ACTION_PROPOSAL_ERROR_CODES.CROSS_WORKSPACE_REFERENCE,
          "Citation workspace mismatch",
          422,
        );
      }
    }
    draft.mediaAssetIds.forEach((id) => mediaIds.add(id));
    draft.dataItemIds.forEach((id) => dataItemIds.add(id));
  }
  for (const citation of parsed.citations) {
    if (citation.workspaceId !== workspaceId) {
      throw typedError(
        AI_ACTION_PROPOSAL_ERROR_CODES.CROSS_WORKSPACE_REFERENCE,
        "Citation workspace mismatch",
        422,
      );
    }
  }

  if (!skipReferenceChecks) {
    if (mediaIds.size > 0) {
      const mediaCount = await prismaClient.mediaAsset.count({
        where: { id: { in: [...mediaIds] }, clientId: workspaceId },
      });
      if (mediaCount !== mediaIds.size) {
        throw typedError(
          AI_ACTION_PROPOSAL_ERROR_CODES.CROSS_WORKSPACE_REFERENCE,
          "Media reference workspace mismatch",
          422,
        );
      }
    }
    if (dataItemIds.size > 0) {
      const itemCount = await prismaClient.workspaceDataItem.count({
        where: {
          id: { in: [...dataItemIds] },
          clientId: workspaceId,
          status: "ACTIVE",
        },
      });
      if (itemCount !== dataItemIds.size) {
        throw typedError(
          AI_ACTION_PROPOSAL_ERROR_CODES.CROSS_WORKSPACE_REFERENCE,
          "Property/data reference workspace mismatch",
          422,
        );
      }
    }
    for (const draft of parsed.proposedDrafts) {
      if (!draft.scheduledFor) continue;
      const conflict = await prismaClient.draft.findFirst({
        where: {
          clientId: workspaceId,
          channel: draft.channel,
          scheduledFor: new Date(draft.scheduledFor),
          status: { in: ["SCHEDULED", "APPROVED", "PENDING_REVIEW"] },
        },
      });
      if (conflict) {
        throw typedError(
          AI_ACTION_PROPOSAL_ERROR_CODES.SCHEDULE_CONFLICT,
          "Proposal conflicts with an existing draft",
          409,
        );
      }
    }
  }

  return {
    valid: validationErrors.length === 0,
    errors: validationErrors,
    checkedAt: now.toISOString(),
    schemaVersion: parsed.schemaVersion,
  };
}

export async function createDraftContentProposal({
  actor,
  workspaceId,
  objective,
  requestedChannels = [],
  sourceId,
  idempotencyKey,
  featureEnabled = env.AI_ACTION_PROPOSALS_ENABLED,
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
  pythonClient = callPythonDraftContentProposal,
} = {}) {
  const startedAt = Date.now();
  const actorUserId = actorId(actor);
  if (!actorUserId) {
    throw typedError(
      AI_ACTION_PROPOSAL_ERROR_CODES.AUTH_REQUIRED,
      "Authentication required",
      401,
    );
  }
  await authorizationService({
    actor,
    workspaceId,
    scope: "campaign-plan:read",
    allowAdmin: false,
  });
  await assertFeatureAndTier({
    actorUserId,
    workspaceId,
    featureEnabled,
    featureFlagEvaluator,
    subscriptionFetcher,
    effectiveTierResolver,
  });

  const existing = await prismaClient.aiActionProposal.findUnique({
    where: {
      clientId_idempotencyKey: { clientId: workspaceId, idempotencyKey },
    },
  });
  if (existing) {
    throw typedError(
      AI_ACTION_PROPOSAL_ERROR_CODES.DUPLICATE_IDEMPOTENCY_KEY,
      "Duplicate proposal idempotency key",
      409,
      {
        proposalId: existing.id,
      },
    );
  }

  const snapshot = await snapshotBuilder({
    workspaceId,
    objective,
    sourceId,
    prismaClient,
  });
  const envelope = await createAuthorizedAiServiceEnvelope({
    actor,
    workspaceId,
    scopes: ["campaign-plan:read"],
    payload: {
      workspaceId,
      objective,
      requestedChannels,
      idempotencyKey,
      snapshot,
      proposalOnly: true,
    },
    keyId: serviceAuthKeyId,
    secret: serviceAuthSecret,
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
      result.errorCode ?? AI_ACTION_PROPOSAL_ERROR_CODES.PROVIDER_UNAVAILABLE,
      "Draft proposal provider failed",
      503,
    );
  }

  const proposal = draftContentProposalResponseSchema.parse(
    pythonDomainPayload(result),
  );
  const validationResults = await validateDraftContentProposal({
    proposal,
    workspaceId,
    prismaClient,
  });
  const proposalPayload = normalizeProposalPayload(proposal);
  const contentHash = contentHashForProposalPayload(proposalPayload);
  const record = await prismaClient.aiActionProposal.create({
    data: {
      clientId: workspaceId,
      actorUserId,
      proposalType: "DRAFT_CONTENT",
      proposalVersion: proposal.proposalVersion,
      schemaVersion: proposal.schemaVersion,
      status: "PROPOSED",
      idempotencyKey,
      contentHash,
      sourceTraceId: proposal.traceId,
      sourceModelVersion: proposal.modelMetadata.model,
      sourcePromptVersion: proposal.modelMetadata.promptVersion,
      proposalPayload,
      validationResults,
      expiresAt: new Date(proposal.expiresAt),
      auditMetadata: {
        events: [
          {
            type: "created",
            actorUserId,
            at: new Date().toISOString(),
            traceId: proposal.traceId,
          },
        ],
        rawPromptStored: false,
        persistenceGate: "disabled_until_offline_and_shadow_pass",
      },
    },
  });
  const provenance = hostedProvenance({
    operation: "draft_content_proposal",
    envelope,
    pythonResult: result,
    startedAt,
    serviceLatencyMs,
    featureFlag: true,
  });
  emitAiExecution(provenance, { workspaceId, actorUserId });
  return {
    status: "proposed",
    proposal: record,
    oldNodePathUnaffected: true,
    provenance,
  };
}

export async function approveAiActionProposal({
  actor,
  workspaceId,
  proposalId,
  prismaClient = prisma,
  authorizationService = assertCanActorPerformWorkspaceScope,
  now = new Date(),
  draftCreator = defaultDraftCreator,
} = {}) {
  const approverUserId = actorId(actor);
  if (!approverUserId) {
    throw typedError(
      AI_ACTION_PROPOSAL_ERROR_CODES.AUTH_REQUIRED,
      "Authentication required",
      401,
    );
  }
  await authorizationService({
    actor,
    workspaceId,
    scope: "campaign-plan:read",
    allowAdmin: false,
  });
  return prismaClient.$transaction(async (tx) => {
    const proposal = await tx.aiActionProposal.findFirst({
      where: { id: proposalId, clientId: workspaceId },
    });
    if (!proposal) {
      throw typedError(
        AI_ACTION_PROPOSAL_ERROR_CODES.SCHEMA_INVALID,
        "Proposal not found",
        404,
      );
    }
    if (proposal.status !== "PROPOSED") {
      throw typedError(
        AI_ACTION_PROPOSAL_ERROR_CODES.REPLAYED_APPROVAL,
        "Proposal has already been resolved",
        409,
      );
    }
    if (new Date(proposal.expiresAt).getTime() <= now.getTime()) {
      await tx.aiActionProposal.update({
        where: { id: proposal.id },
        data: { status: "EXPIRED" },
      });
      throw typedError(
        AI_ACTION_PROPOSAL_ERROR_CODES.EXPIRED_PROPOSAL,
        "Proposal is expired",
        410,
      );
    }
    const contentHash = contentHashForProposalPayload(proposal.proposalPayload);
    if (contentHash !== proposal.contentHash) {
      throw typedError(
        AI_ACTION_PROPOSAL_ERROR_CODES.CONTENT_HASH_MISMATCH,
        "Proposal payload changed after validation",
        409,
      );
    }
    const validationResults = await validateDraftContentProposal({
      proposal: proposal.proposalPayload,
      workspaceId,
      prismaClient: tx,
      now,
    });
    const draftIds = [];
    for (const draft of proposal.proposalPayload.proposedDrafts) {
      const created = await draftCreator({
        tx,
        draft,
        proposal,
        approverUserId,
      });
      draftIds.push(created.id);
    }
    const auditMetadata = appendAuditEvent(proposal.auditMetadata, {
      type: "approved",
      actorUserId: approverUserId,
      at: now.toISOString(),
      validationResults,
    });
    const updated = await tx.aiActionProposal.update({
      where: { id: proposal.id },
      data: {
        status: "APPROVED",
        approvedAt: now,
        approverUserId,
        resultingDraftIds: draftIds,
        validationResults,
        auditMetadata,
      },
    });
    return {
      status: "approved",
      proposal: updated,
      draftIds,
      published: false,
    };
  });
}

export async function rejectAiActionProposal({
  actor,
  workspaceId,
  proposalId,
  rejectionReason,
  prismaClient = prisma,
  authorizationService = assertCanActorPerformWorkspaceScope,
  now = new Date(),
} = {}) {
  const approverUserId = actorId(actor);
  if (!approverUserId) {
    throw typedError(
      AI_ACTION_PROPOSAL_ERROR_CODES.AUTH_REQUIRED,
      "Authentication required",
      401,
    );
  }
  await authorizationService({
    actor,
    workspaceId,
    scope: "campaign-plan:read",
    allowAdmin: false,
  });
  const proposal = await prismaClient.aiActionProposal.findFirst({
    where: { id: proposalId, clientId: workspaceId },
  });
  if (!proposal || proposal.status !== "PROPOSED") {
    throw typedError(
      AI_ACTION_PROPOSAL_ERROR_CODES.REPLAYED_APPROVAL,
      "Proposal has already been resolved",
      409,
    );
  }
  return prismaClient.aiActionProposal.update({
    where: { id: proposal.id },
    data: {
      status: "REJECTED",
      rejectedAt: now,
      approverUserId,
      rejectionReason: rejectionReason || null,
      auditMetadata: appendAuditEvent(proposal.auditMetadata, {
        type: "rejected",
        actorUserId: approverUserId,
        at: now.toISOString(),
        reason: rejectionReason || null,
      }),
    },
  });
}

async function defaultDraftCreator({ tx, draft, proposal, approverUserId }) {
  return tx.draft.create({
    data: {
      clientId: proposal.clientId,
      kind: "POST",
      status: "PENDING_REVIEW",
      channel: draft.channel,
      generationGuidance: "Created from approved AI action proposal.",
      modelUsed: proposal.sourceModelVersion,
      promptVersion: 1,
      body: draft.body,
      hooks: [],
      hashtags: draft.hashtags,
      cta: draft.cta || null,
      mediaPlan: { mediaAssetIds: draft.mediaAssetIds },
      warnings: ["ai_action_proposal", `proposal:${proposal.id}`],
      language: "en",
      createdBy: proposal.actorUserId,
      approvedBy: approverUserId,
      approvedAt: new Date(),
      scheduledFor: null,
      idempotencyKey: `${proposal.id}:${draft.channel}`,
    },
  });
}

function appendAuditEvent(auditMetadata, event) {
  const existing =
    auditMetadata && typeof auditMetadata === "object" ? auditMetadata : {};
  const events = Array.isArray(existing.events) ? existing.events : [];
  return { ...existing, events: [...events, event], rawPromptStored: false };
}
