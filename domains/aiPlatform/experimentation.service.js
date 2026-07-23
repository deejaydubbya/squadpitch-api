import crypto from "node:crypto";
import { z } from "zod";

import { env } from "../../config/env.js";
import { assertCanActorPerformWorkspaceScope } from "../authorization/workspaceAuthorization.service.js";
import { evaluateFlag } from "../internal/config.service.js";
import {
  AI_PLATFORM_ERROR_CODES,
  callPythonExperimentAnalysis,
} from "./pythonAiPlatform.client.js";
import { createAuthorizedAiServiceEnvelope } from "./serviceEnvelope.js";

export const EXPERIMENT_ANALYSIS_SCHEMA_VERSION = "experiment-analysis.v1";

export const EXPERIMENT_ERROR_CODES = Object.freeze({
  AUTH_REQUIRED: "AUTH_REQUIRED",
  FEATURE_DISABLED: "FEATURE_DISABLED",
  DUPLICATE_EXPOSURE: "DUPLICATE_EXPOSURE",
  TENANT_LEAKAGE: "TENANT_LEAKAGE",
  EXPERIMENT_ROLLED_BACK: "EXPERIMENT_ROLLED_BACK",
  PROVIDER_UNAVAILABLE: AI_PLATFORM_ERROR_CODES.UNAVAILABLE,
});

const variantSchema = z
  .object({
    key: z.string().min(1),
    label: z.string().min(1),
    allocation: z.number().min(0).max(1),
    isControl: z.boolean().default(false),
  })
  .strict();

export const experimentDefinitionSchema = z
  .object({
    experimentId: z.string().min(1),
    workspaceId: z.string().min(1),
    name: z.string().min(1),
    hypothesis: z.string().min(1),
    primaryMetric: z.string().min(1),
    metricType: z.enum(["proportion", "mean"]),
    guardrailMetrics: z.array(z.string()).default([]),
    eligibilityRules: z.record(z.unknown()).default({}),
    variants: z.array(variantSchema).min(2),
    attributionWindowHours: z.number().int().min(1),
    sampleSizeGuidance: z.record(z.unknown()),
    stoppingRules: z.array(z.string()).min(1),
    analysisPlan: z.string().min(1),
    segments: z.array(z.string()).default([]),
    status: z
      .enum(["draft", "running", "paused", "rolled_back", "completed"])
      .default("draft"),
    rollback: z
      .object({
        reason: z.string().min(1),
        rolledBackAt: z.string().datetime(),
      })
      .optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.variants.filter((variant) => variant.isControl).length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["variants"],
        message: "exactly one control variant is required",
      });
    }
    const allocation = value.variants.reduce(
      (total, variant) => total + variant.allocation,
      0,
    );
    if (Math.round(allocation * 1_000_000) / 1_000_000 !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["variants"],
        message: "variant allocations must sum to 1",
      });
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

function hashBucket(seed) {
  const digest = crypto.createHash("sha256").update(seed).digest("hex");
  return Number.parseInt(digest.slice(0, 12), 16) / 0xffffffffffff;
}

export function assignExperimentVariant({
  definition,
  subjectId,
  salt = "squadpitch-experiment-v1",
}) {
  const parsed = experimentDefinitionSchema.parse(definition);
  if (parsed.status === "rolled_back") {
    throw typedError(
      EXPERIMENT_ERROR_CODES.EXPERIMENT_ROLLED_BACK,
      "Experiment has been rolled back",
      409,
    );
  }
  const bucket = hashBucket(
    `${salt}:${parsed.workspaceId}:${parsed.experimentId}:${subjectId}`,
  );
  let cumulative = 0;
  for (const variant of parsed.variants) {
    cumulative += variant.allocation;
    if (bucket < cumulative) return variant;
  }
  return parsed.variants.at(-1);
}

export function createExposure({
  definition,
  subjectId,
  entityType,
  entityId,
  segments = {},
  now = new Date(),
  existingExposures = [],
}) {
  const parsed = experimentDefinitionSchema.parse(definition);
  const duplicate = existingExposures.find(
    (exposure) =>
      exposure.experimentId === parsed.experimentId &&
      exposure.workspaceId === parsed.workspaceId &&
      exposure.subjectId === subjectId &&
      exposure.entityType === entityType &&
      exposure.entityId === entityId,
  );
  if (duplicate) {
    throw typedError(
      EXPERIMENT_ERROR_CODES.DUPLICATE_EXPOSURE,
      "Exposure already exists",
      409,
      {
        exposureId: duplicate.exposureId,
      },
    );
  }
  const variant = assignExperimentVariant({ definition: parsed, subjectId });
  return {
    exposureId: crypto.randomUUID(),
    experimentId: parsed.experimentId,
    workspaceId: parsed.workspaceId,
    subjectId,
    variantKey: variant.key,
    exposedAt: now.toISOString(),
    entityType,
    entityId,
    segments,
  };
}

export function assertNoCrossWorkspace(definition, exposures, outcomes = []) {
  const leakedExposure = exposures.find(
    (exposure) =>
      exposure.workspaceId !== definition.workspaceId ||
      exposure.experimentId !== definition.experimentId,
  );
  const leakedOutcome = outcomes.find(
    (outcome) =>
      outcome.workspaceId !== definition.workspaceId ||
      outcome.experimentId !== definition.experimentId,
  );
  if (leakedExposure || leakedOutcome) {
    throw typedError(
      EXPERIMENT_ERROR_CODES.TENANT_LEAKAGE,
      "Experiment data crossed workspace boundaries",
      403,
    );
  }
}

export function attributeOutcomes({ definition, exposures, outcomes }) {
  const parsed = experimentDefinitionSchema.parse(definition);
  assertNoCrossWorkspace(parsed, exposures, outcomes);
  const windowMs = parsed.attributionWindowHours * 60 * 60 * 1000;
  return exposures.map((exposure) => ({
    exposure,
    outcomes: outcomes.filter((outcome) => {
      const delta =
        Date.parse(outcome.observedAt) - Date.parse(exposure.exposedAt);
      return (
        outcome.workspaceId === exposure.workspaceId &&
        outcome.experimentId === exposure.experimentId &&
        outcome.entityType === exposure.entityType &&
        outcome.entityId === exposure.entityId &&
        delta >= 0 &&
        delta <= windowMs
      );
    }),
  }));
}

export function rollbackExperiment(definition, reason, now = new Date()) {
  return {
    ...definition,
    status: "rolled_back",
    rollback: {
      reason,
      rolledBackAt: now.toISOString(),
    },
  };
}

export function buildExperimentReportInterface({
  definition,
  exposures = [],
  outcomes = [],
  enabled = true,
}) {
  const attributed = attributeOutcomes({ definition, exposures, outcomes });
  return {
    enabled,
    schemaVersion: EXPERIMENT_ANALYSIS_SCHEMA_VERSION,
    experiment: definition,
    summary: {
      exposures: exposures.length,
      outcomes: outcomes.length,
      attributedOutcomes: attributed.reduce(
        (total, row) => total + row.outcomes.length,
        0,
      ),
      variants: Object.fromEntries(
        definition.variants.map((variant) => [
          variant.key,
          exposures.filter((exposure) => exposure.variantKey === variant.key)
            .length,
        ]),
      ),
    },
    cautions: [
      "Do not infer causation from ordinary observational analytics.",
      "Avoid stopping early outside predeclared stopping rules.",
      "Segment reports are exploratory unless predeclared.",
    ],
  };
}

export async function getExperimentReport({
  actor,
  definition,
  exposures = [],
  outcomes = [],
  featureEnabled = env.AI_EXPERIMENTATION_ENABLED,
  featureFlagEvaluator = evaluateFlag,
  authorizationService = assertCanActorPerformWorkspaceScope,
  pythonClient = callPythonExperimentAnalysis,
  pythonBaseUrl = env.AI_PLATFORM_INTERNAL_BASE_URL,
  timeoutMs = env.AI_PLATFORM_HEALTH_TIMEOUT_MS,
  serviceAuthKeyId = env.AI_PLATFORM_SERVICE_AUTH_KEY_ID,
  serviceAuthSecret = env.AI_PLATFORM_SERVICE_AUTH_SECRET,
} = {}) {
  const actorUserId = actorId(actor);
  if (!actorUserId)
    throw typedError(
      EXPERIMENT_ERROR_CODES.AUTH_REQUIRED,
      "Authentication required",
      401,
    );
  const parsed = experimentDefinitionSchema.parse(definition);
  await authorizationService({
    actor,
    workspaceId: parsed.workspaceId,
    scope: "eval:run",
    allowAdmin: true,
  });
  const flagEnabled =
    featureEnabled === true ||
    (await featureFlagEvaluator("ai_experimentation_enabled", {
      workspaceId: parsed.workspaceId,
      userId: actorUserId,
    }));
  if (!flagEnabled) {
    return buildExperimentReportInterface({
      definition: parsed,
      exposures,
      outcomes,
      enabled: false,
    });
  }
  assertNoCrossWorkspace(parsed, exposures, outcomes);
  const envelope = await createAuthorizedAiServiceEnvelope({
    actor,
    workspaceId: parsed.workspaceId,
    scopes: ["eval:run"],
    payload: {
      schemaVersion: EXPERIMENT_ANALYSIS_SCHEMA_VERSION,
      definition: parsed,
      exposures,
      outcomes,
    },
    keyId: serviceAuthKeyId,
    secret: serviceAuthSecret,
    authorizationService,
    allowAdmin: true,
  });
  const result = await pythonClient({
    enabled: true,
    baseUrl: pythonBaseUrl,
    timeoutMs,
    envelope,
  });
  if (!result.ok) {
    return {
      ...buildExperimentReportInterface({
        definition: parsed,
        exposures,
        outcomes,
        enabled: true,
      }),
      analysis: null,
      status: "analysis_unavailable",
      reason: result.errorCode ?? EXPERIMENT_ERROR_CODES.PROVIDER_UNAVAILABLE,
    };
  }
  return {
    ...buildExperimentReportInterface({
      definition: parsed,
      exposures,
      outcomes,
      enabled: true,
    }),
    analysis: result.body,
    status: "ok",
  };
}
