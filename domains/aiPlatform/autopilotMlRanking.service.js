import { z } from "zod";

import { env } from "../../config/env.js";
import { evaluateFlag } from "../internal/config.service.js";
import { assertCanActorPerformWorkspaceScope } from "../authorization/workspaceAuthorization.service.js";
import { createAuthorizedAiServiceEnvelope } from "./serviceEnvelope.js";
import {
  callPythonAutopilotRank,
  AI_PLATFORM_ERROR_CODES,
} from "./pythonAiPlatform.client.js";
import {
  emitAiExecution,
  hostedProvenance,
  localProvenance,
  pythonDomainPayload,
  shadowProvenance,
} from "./executionProvenance.js";

export const AUTOPILOT_ML_RANKING_SCHEMA_VERSION =
  "autopilot-opportunity-ranking.v1";
export const AUTOPILOT_ML_MODEL_VERSION = "autopilot-logistic-ranker.v1";

export const AUTOPILOT_ML_RANKING_ERROR_CODES = Object.freeze({
  AUTH_REQUIRED: "AUTH_REQUIRED",
  FEATURE_DISABLED: "FEATURE_DISABLED",
  MODEL_VERSION_MISMATCH: "MODEL_VERSION_MISMATCH",
  CROSS_WORKSPACE_REFERENCE: "TENANT_LEAKAGE",
  PROVIDER_UNAVAILABLE: AI_PLATFORM_ERROR_CODES.UNAVAILABLE,
  SCHEMA_INVALID: AI_PLATFORM_ERROR_CODES.SCHEMA_INVALID,
});

const candidateSchema = z
  .object({
    candidateId: z.string().min(1),
    workspaceId: z.string().min(1),
    triggerType: z.string().min(1),
    industry: z.string().default("real_estate"),
    channel: z.string().nullable().optional(),
    heuristicScore: z.number().finite().default(0),
    listingAgeDays: z.number().finite().nullable().optional(),
    priceChangePercent: z.number().finite().nullable().optional(),
    daysSinceLastPost: z.number().finite().nullable().optional(),
    mediaAvailable: z.boolean().default(false),
    historicalApprovalRate: z.number().finite().nullable().optional(),
    historicalEngagementRate: z.number().finite().nullable().optional(),
    hourOfDay: z.number().int().min(0).max(23).nullable().optional(),
    dayOfWeek: z.number().int().min(0).max(6).nullable().optional(),
    contentType: z.string().nullable().optional(),
    recentAudienceEngagement: z.number().finite().nullable().optional(),
    detectedAt: z.string().datetime(),
  })
  .strict();

const rankingResponseSchema = z
  .object({
    schemaVersion: z.literal(AUTOPILOT_ML_RANKING_SCHEMA_VERSION),
    workspaceId: z.string().min(1),
    rankedCandidates: z.array(
      z
        .object({
          candidateId: z.string().min(1),
          workspaceId: z.string().min(1),
          baselineRank: z.number().int().min(1),
          mlRank: z.number().int().min(1),
          heuristicScore: z.number().finite(),
          predictedUsefulness: z.number().min(0).max(1),
          missingFeatures: z.array(z.string()),
          modelVersion: z.literal(AUTOPILOT_ML_MODEL_VERSION),
        })
        .strict(),
    ),
    modelMetadata: z.record(z.unknown()),
    traceId: z.string().min(1),
    shadowMode: z.boolean(),
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

export function heuristicRankCandidates(candidates) {
  return [...candidates].sort((left, right) => {
    if (right.heuristicScore !== left.heuristicScore)
      return right.heuristicScore - left.heuristicScore;
    return Date.parse(left.detectedAt) - Date.parse(right.detectedAt);
  });
}

export async function rankAutopilotOpportunities({
  actor,
  workspaceId,
  traceId,
  candidates,
  shadowMode = true,
  modelVersion = AUTOPILOT_ML_MODEL_VERSION,
  featureEnabled = env.AI_AUTOPILOT_ML_RANKING_ENABLED,
  pythonBaseUrl = env.AI_PLATFORM_INTERNAL_BASE_URL,
  timeoutMs = env.AI_PLATFORM_HEALTH_TIMEOUT_MS,
  serviceAuthKeyId = env.AI_PLATFORM_SERVICE_AUTH_KEY_ID,
  serviceAuthSecret = env.AI_PLATFORM_SERVICE_AUTH_SECRET,
  authorizationService = assertCanActorPerformWorkspaceScope,
  featureFlagEvaluator = evaluateFlag,
  pythonClient = callPythonAutopilotRank,
} = {}) {
  const startedAt = Date.now();
  const actorUserId = actorId(actor);
  if (!actorUserId) {
    throw typedError(
      AUTOPILOT_ML_RANKING_ERROR_CODES.AUTH_REQUIRED,
      "Authentication required",
      401,
    );
  }
  if (modelVersion !== AUTOPILOT_ML_MODEL_VERSION) {
    throw typedError(
      AUTOPILOT_ML_RANKING_ERROR_CODES.MODEL_VERSION_MISMATCH,
      "Unsupported autopilot ranking model version",
      422,
      { expected: AUTOPILOT_ML_MODEL_VERSION, received: modelVersion },
    );
  }
  const parsedCandidates = z.array(candidateSchema).parse(candidates ?? []);
  if (
    parsedCandidates.some((candidate) => candidate.workspaceId !== workspaceId)
  ) {
    throw typedError(
      AUTOPILOT_ML_RANKING_ERROR_CODES.CROSS_WORKSPACE_REFERENCE,
      "Candidate workspace mismatch",
      403,
    );
  }
  await authorizationService({
    actor,
    workspaceId,
    scope: "autopilot-rank:read",
    allowAdmin: false,
  });

  const heuristicOrder = heuristicRankCandidates(parsedCandidates);
  const flagEnabled =
    featureEnabled === true ||
    (await featureFlagEvaluator("ai_autopilot_ml_ranking_enabled", {
      workspaceId,
      userId: actorUserId,
    }));
  if (!flagEnabled) {
    const provenance = localProvenance({
      operation: "autopilot_rank",
      startedAt,
      implementation: "heuristic_autopilot_ranker_v1",
      featureFlag: false,
    });
    emitAiExecution(provenance, { workspaceId, actorUserId });
    return {
      mode: "heuristic_fallback",
      rankedCandidates: heuristicOrder,
      mlRankings: null,
      oldNodePathUnaffected: true,
      reason: AUTOPILOT_ML_RANKING_ERROR_CODES.FEATURE_DISABLED,
      provenance,
    };
  }

  const envelope = await createAuthorizedAiServiceEnvelope({
    actor,
    workspaceId,
    scopes: ["autopilot-rank:read"],
    payload: {
      schemaVersion: AUTOPILOT_ML_RANKING_SCHEMA_VERSION,
      workspaceId,
      candidates: parsedCandidates,
      modelVersion,
      shadowMode,
    },
    keyId: serviceAuthKeyId,
    secret: serviceAuthSecret,
    authorizationService,
    ...(traceId ? { requestId: traceId, traceId } : {}),
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
    const provenance = localProvenance({
      operation: "autopilot_rank",
      envelope,
      startedAt,
      implementation: "heuristic_autopilot_ranker_v1",
      reason: result.errorCode,
      attemptedHosted: true,
      serviceLatencyMs,
      featureFlag: true,
    });
    emitAiExecution(provenance, { workspaceId, actorUserId });
    return {
      mode: "heuristic_fallback",
      rankedCandidates: heuristicOrder,
      mlRankings: null,
      oldNodePathUnaffected: true,
      reason:
        result.errorCode ??
        AUTOPILOT_ML_RANKING_ERROR_CODES.PROVIDER_UNAVAILABLE,
      provenance,
    };
  }
  const parsedResult = rankingResponseSchema.safeParse(
    pythonDomainPayload(result),
  );
  if (!parsedResult.success) {
    const provenance = localProvenance({
      operation: "autopilot_rank",
      envelope,
      startedAt,
      implementation: "heuristic_autopilot_ranker_v1",
      reason: AI_PLATFORM_ERROR_CODES.SCHEMA_INVALID,
      attemptedHosted: true,
      serviceLatencyMs,
      featureFlag: true,
    });
    emitAiExecution(provenance, { workspaceId, actorUserId });
    return {
      mode: "heuristic_fallback",
      rankedCandidates: heuristicOrder,
      mlRankings: null,
      oldNodePathUnaffected: true,
      reason: AI_PLATFORM_ERROR_CODES.SCHEMA_INVALID,
      provenance,
    };
  }
  const parsed = parsedResult.data;
  if (parsed.workspaceId !== workspaceId) {
    throw typedError(
      AUTOPILOT_ML_RANKING_ERROR_CODES.CROSS_WORKSPACE_REFERENCE,
      "Ranking response workspace mismatch",
      403,
    );
  }
  const mlOrder = parsed.rankedCandidates
    .map((ranked) =>
      parsedCandidates.find(
        (candidate) => candidate.candidateId === ranked.candidateId,
      ),
    )
    .filter(Boolean);
  const provenance = shadowMode
    ? shadowProvenance({
        operation: "autopilot_rank",
        envelope,
        pythonResult: result,
        startedAt,
        serviceLatencyMs,
        implementation: "heuristic_autopilot_ranker_v1",
        featureFlag: true,
      })
    : hostedProvenance({
        operation: "autopilot_rank",
        envelope,
        pythonResult: result,
        startedAt,
        serviceLatencyMs,
        featureFlag: true,
      });
  emitAiExecution(provenance, { workspaceId, actorUserId });
  return {
    mode: shadowMode ? "shadow" : "ml_ranked",
    rankedCandidates: shadowMode ? heuristicOrder : mlOrder,
    mlRankings: parsed,
    oldNodePathUnaffected: shadowMode,
    provenance,
  };
}
