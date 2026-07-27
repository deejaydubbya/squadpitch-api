import { z } from "zod";

import { env } from "../../config/env.js";
import { assertCanActorPerformWorkspaceScope } from "../authorization/workspaceAuthorization.service.js";
import { evaluateFlag } from "../internal/config.service.js";
import {
  AI_PLATFORM_ERROR_CODES,
  callPythonBrandQualityScore,
} from "./pythonAiPlatform.client.js";
import {
  MODEL_REGISTRY_ERROR_CODES,
  buildDefaultModelRegistry,
  requireCompatibleModel,
} from "./modelRegistry.service.js";
import { createAuthorizedAiServiceEnvelope } from "./serviceEnvelope.js";
import {
  emitAiExecution,
  localProvenance,
  pythonDomainPayload,
  shadowProvenance,
} from "./executionProvenance.js";

export const BRAND_QUALITY_SCHEMA_VERSION = "brand-content-quality.v1";
export const BRAND_QUALITY_MODEL_VERSION = "brand-quality-neural-shadow.v1";

export const BRAND_QUALITY_ERROR_CODES = Object.freeze({
  AUTH_REQUIRED: "AUTH_REQUIRED",
  FEATURE_DISABLED: "FEATURE_DISABLED",
  MODEL_VERSION_MISMATCH: "MODEL_VERSION_MISMATCH",
  MODEL_NOT_FOUND: MODEL_REGISTRY_ERROR_CODES.MODEL_NOT_FOUND,
  RAW_TEXT_REJECTED: "RAW_TEXT_REJECTED",
  CROSS_WORKSPACE_REFERENCE: "TENANT_LEAKAGE",
  PROVIDER_UNAVAILABLE: AI_PLATFORM_ERROR_CODES.UNAVAILABLE,
  SCHEMA_INVALID: AI_PLATFORM_ERROR_CODES.SCHEMA_INVALID,
});

const requestSchema = z
  .object({
    workspaceId: z.string().min(1),
    contentId: z.string().min(1),
    sanitizedText: z.string().min(1).max(12000),
    channel: z.string().min(1),
    industry: z.string().min(1).default("real_estate"),
    brandConstraints: z.array(z.string().min(1)).default([]),
    bannedPhrases: z.array(z.string().min(1)).default([]),
    language: z.string().min(2).max(16).default("en"),
    modelVersion: z
      .literal(BRAND_QUALITY_MODEL_VERSION)
      .default(BRAND_QUALITY_MODEL_VERSION),
  })
  .strict();

const scoreSchema = z
  .object({
    label: z.string().min(1),
    score: z.number().min(0).max(1),
    risk: z.enum(["low", "medium", "high"]),
    explanation: z.string().min(1),
  })
  .strict();

const scoreResponseSchema = z
  .object({
    schemaVersion: z.literal(BRAND_QUALITY_SCHEMA_VERSION),
    workspaceId: z.string().min(1),
    contentId: z.string().min(1),
    modelVersion: z.literal(BRAND_QUALITY_MODEL_VERSION),
    modelFamily: z.enum(["deterministic_shadow", "pytorch_neural"]),
    scores: z.array(scoreSchema).min(1),
    needsHumanReview: z.boolean(),
    categories: z.array(z.string()),
    calibration: z.record(z.number()),
    explanations: z.array(z.string()),
    traceId: z.string().min(1),
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

function assertSanitizedText(value) {
  const lower = String(value ?? "").toLowerCase();
  if (
    lower.includes("@") ||
    lower.includes("sk-") ||
    lower.includes("authorization: bearer")
  ) {
    throw typedError(
      BRAND_QUALITY_ERROR_CODES.RAW_TEXT_REJECTED,
      "Content must be sanitized before quality scoring",
      422,
    );
  }
}

function risk(label, score, explanation) {
  return {
    label,
    score: Number(score.toFixed(6)),
    risk: score >= 0.66 ? "high" : score >= 0.33 ? "medium" : "low",
    explanation,
  };
}

export function deterministicBrandQualityFallback({
  workspaceId,
  contentId,
  sanitizedText,
  channel,
  brandConstraints = [],
  bannedPhrases = [],
  language = "en",
  traceId = "brand-quality-local",
}) {
  const text = sanitizedText.trim();
  const lower = text.toLowerCase();
  const bannedHits = bannedPhrases.filter((phrase) =>
    lower.includes(phrase.toLowerCase()),
  );
  const brandTerms = brandConstraints
    .map((term) => term.toLowerCase())
    .filter(Boolean);
  const brandMatch = brandTerms.length
    ? brandTerms.filter((term) => lower.includes(term)).length /
      brandTerms.length
    : 0.5;
  const promoTerms = [
    "limited",
    "exclusive",
    "deal",
    "offer",
    "act now",
    "guaranteed",
  ];
  const promoScore = Math.min(
    1,
    promoTerms.filter((term) => lower.includes(term)).length / 3,
  );
  const wordCount = text.split(/\s+/).filter(Boolean).length;
  const verbosityScore = Math.min(1, Math.max(0, wordCount - 80) / 120);
  const channelLimit =
    { X: 280, THREADS: 500, INSTAGRAM: 2200, FACEBOOK: 3000, LINKEDIN: 3000 }[
      channel.toUpperCase()
    ] ?? 2200;
  const channelScore = text.length > channelLimit ? 1 : 0;
  const languageScore = ["en", "es"].includes(language) ? 0 : 1;
  const scores = [
    risk("brand_voice_match", brandMatch, "Brand constraint coverage."),
    risk("excessive_promotion", promoScore, "Promotional language density."),
    risk(
      "excessive_verbosity",
      verbosityScore,
      "Length exceeds concise content target.",
    ),
    risk(
      "prohibited_phrase",
      bannedHits.length ? 1 : 0,
      `Banned phrases: ${bannedHits.join(", ")}`,
    ),
    risk(
      "channel_suitability",
      channelScore,
      `Channel limit ${channelLimit} chars.`,
    ),
    risk("unsupported_language_risk", languageScore, `Language=${language}.`),
  ];
  const reviewScore = Math.max(
    1 - brandMatch,
    promoScore,
    verbosityScore,
    bannedHits.length ? 1 : 0,
    channelScore,
    languageScore,
  );
  scores.push(
    risk("needs_human_review", reviewScore, "Maximum policy/quality risk."),
  );
  const categories = scores
    .filter((score) => score.risk !== "low")
    .map((score) => score.label);
  return {
    schemaVersion: BRAND_QUALITY_SCHEMA_VERSION,
    workspaceId,
    contentId,
    modelVersion: BRAND_QUALITY_MODEL_VERSION,
    modelFamily: "deterministic_shadow",
    scores,
    needsHumanReview: reviewScore >= 0.5,
    categories,
    calibration: { expectedCalibrationError: 0, trainedArtifactAvailable: 0 },
    explanations: scores
      .filter((score) => score.risk !== "low")
      .map((score) => score.explanation),
    traceId,
    proposalOnly: true,
  };
}

export async function scoreBrandContentQuality({
  actor,
  workspaceId,
  contentId,
  sanitizedText,
  channel,
  industry = "real_estate",
  brandConstraints = [],
  bannedPhrases = [],
  language = "en",
  modelVersion = BRAND_QUALITY_MODEL_VERSION,
  featureEnabled = env.AI_BRAND_QUALITY_MODEL_ENABLED,
  pythonBaseUrl = env.AI_PLATFORM_INTERNAL_BASE_URL,
  timeoutMs = env.AI_PLATFORM_HEALTH_TIMEOUT_MS,
  serviceAuthKeyId = env.AI_PLATFORM_SERVICE_AUTH_KEY_ID,
  serviceAuthSecret = env.AI_PLATFORM_SERVICE_AUTH_SECRET,
  authorizationService = assertCanActorPerformWorkspaceScope,
  featureFlagEvaluator = evaluateFlag,
  pythonClient = callPythonBrandQualityScore,
  modelRegistry = buildDefaultModelRegistry(),
} = {}) {
  const startedAt = Date.now();
  const actorUserId = actorId(actor);
  if (!actorUserId) {
    throw typedError(
      BRAND_QUALITY_ERROR_CODES.AUTH_REQUIRED,
      "Authentication required",
      401,
    );
  }
  if (modelVersion !== BRAND_QUALITY_MODEL_VERSION) {
    throw typedError(
      BRAND_QUALITY_ERROR_CODES.MODEL_VERSION_MISMATCH,
      "Unsupported brand quality model version",
      422,
      { expected: BRAND_QUALITY_MODEL_VERSION, received: modelVersion },
    );
  }
  const registryEntry = requireCompatibleModel({
    registry: modelRegistry,
    modelId: "brand-content-quality",
    version: modelVersion,
    schemaVersion: BRAND_QUALITY_SCHEMA_VERSION,
  });
  const parsed = requestSchema.parse({
    workspaceId,
    contentId,
    sanitizedText,
    channel,
    industry,
    brandConstraints,
    bannedPhrases,
    language,
    modelVersion,
  });
  assertSanitizedText(parsed.sanitizedText);
  await authorizationService({
    actor,
    workspaceId,
    scope: "content-score:read",
    allowAdmin: false,
  });

  const localScore = deterministicBrandQualityFallback(parsed);
  const flagEnabled =
    featureEnabled === true ||
    (await featureFlagEvaluator("ai_brand_quality_model_enabled", {
      workspaceId,
      userId: actorUserId,
    }));
  if (!flagEnabled) {
    const provenance = localProvenance({
      operation: "brand_quality_score",
      startedAt,
      implementation: "deterministic_brand_quality_v1",
      reason: BRAND_QUALITY_ERROR_CODES.FEATURE_DISABLED,
      featureFlag: false,
    });
    emitAiExecution(provenance, { workspaceId, actorUserId });
    return {
      mode: "deterministic_fallback",
      qualityScore: localScore,
      modelScore: null,
      oldNodePathUnaffected: true,
      reason: BRAND_QUALITY_ERROR_CODES.FEATURE_DISABLED,
      provenance,
    };
  }

  const envelope = await createAuthorizedAiServiceEnvelope({
    actor,
    workspaceId,
    scopes: ["content-score:read"],
    payload: {
      ...parsed,
      schemaVersion: BRAND_QUALITY_SCHEMA_VERSION,
      proposalOnly: true,
      registrySchemaVersion: registryEntry.registrySchemaVersion,
      deploymentStatus: registryEntry.deploymentStatus,
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
    const provenance = localProvenance({
      operation: "brand_quality_score",
      envelope,
      startedAt,
      implementation: "deterministic_brand_quality_v1",
      reason: result.errorCode,
      attemptedHosted: true,
      serviceLatencyMs,
      featureFlag: true,
    });
    emitAiExecution(provenance, { workspaceId, actorUserId });
    return {
      mode: "deterministic_fallback",
      qualityScore: localScore,
      modelScore: null,
      oldNodePathUnaffected: true,
      reason:
        result.errorCode ?? BRAND_QUALITY_ERROR_CODES.PROVIDER_UNAVAILABLE,
      provenance,
    };
  }
  const parsedResult = scoreResponseSchema.safeParse(
    pythonDomainPayload(result),
  );
  if (!parsedResult.success) {
    const provenance = localProvenance({
      operation: "brand_quality_score",
      envelope,
      startedAt,
      implementation: "deterministic_brand_quality_v1",
      reason: AI_PLATFORM_ERROR_CODES.SCHEMA_INVALID,
      attemptedHosted: true,
      serviceLatencyMs,
      featureFlag: true,
    });
    emitAiExecution(provenance, { workspaceId, actorUserId });
    return {
      mode: "deterministic_fallback",
      qualityScore: localScore,
      modelScore: null,
      oldNodePathUnaffected: true,
      reason: AI_PLATFORM_ERROR_CODES.SCHEMA_INVALID,
      provenance,
    };
  }
  const parsedResponse = parsedResult.data;
  if (parsedResponse.workspaceId !== workspaceId) {
    throw typedError(
      BRAND_QUALITY_ERROR_CODES.CROSS_WORKSPACE_REFERENCE,
      "Brand quality response workspace mismatch",
      403,
    );
  }
  const provenance = shadowProvenance({
    operation: "brand_quality_score",
    envelope,
    pythonResult: result,
    startedAt,
    serviceLatencyMs,
    implementation: "deterministic_brand_quality_v1",
    featureFlag: true,
  });
  emitAiExecution(provenance, { workspaceId, actorUserId });
  return {
    mode: "shadow",
    qualityScore: localScore,
    modelScore: parsedResponse,
    oldNodePathUnaffected: true,
    provenance,
  };
}
