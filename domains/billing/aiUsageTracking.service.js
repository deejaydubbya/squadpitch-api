// AI Usage Tracking Service — granular per-call audit log for AI operations.

import { prisma } from "../../prisma.js";
import { estimateCostCents } from "./aiModelRouter.js";

export const AI_USAGE_ACTIONS = Object.freeze([
  "GENERATE_POST",
  "REGENERATE",
  "REMIX_CONTENT",
  "GENERATE_CAMPAIGN",
  "REGENERATE_POST",
  "PARSE",
  "EXTRACT_IMAGE",
  "IMAGE",
  "VIDEO",
  "IDEAS",
  "ONBOARDING",
]);

const AI_USAGE_ACTION_SET = new Set(AI_USAGE_ACTIONS);

const DEFAULT_TASK_BY_ACTION = {
  GENERATE_POST: "content_draft_generation",
  REGENERATE: "content_regeneration",
  REMIX_CONTENT: "content_remix",
  GENERATE_CAMPAIGN: "campaign_generation",
  REGENERATE_POST: "campaign_post_regeneration",
  PARSE: "data_extraction",
  EXTRACT_IMAGE: "vision_auto_tag_or_image_extraction",
  IMAGE: "image_generation",
  VIDEO: "video_generation",
  IDEAS: "content_ideas",
  ONBOARDING: "onboarding_analysis",
};

const BILLING_ACTION_BY_TASK = {
  content_draft_generation: "GENERATE_POST",
  autopilot_draft_generation: "GENERATE_POST",
  content_regeneration: "REGENERATE",
  content_remix: "REMIX_CONTENT",
  campaign_generation: "GENERATE_CAMPAIGN",
  campaign_post_regeneration: "REGENERATE_POST",
  sites_generation: "GENERATE_POST",
  sites_translation: "GENERATE_POST",
  inbox_reply_suggestion: "GENERATE_POST",
  ads_generation: "GENERATE_POST",
  content_ideas: "IDEAS",
  inline_rewrite: "REGENERATE",
  inline_improve: "REGENERATE",
  inline_tone: "REGENERATE",
  inline_expand: "REGENERATE",
  inline_variations: "REGENERATE",
  vision_auto_tag: "EXTRACT_IMAGE",
  image_extraction: "EXTRACT_IMAGE",
  image_generation: "IMAGE",
  video_generation: "VIDEO",
  onboarding_analysis: "ONBOARDING",
  data_extraction: "PARSE",
  review_analysis: "PARSE",
};

const TAXONOMY_BY_PROVIDER_CODE = {
  OPENAI_NOT_CONFIGURED: "PROVIDER_NOT_CONFIGURED",
  OPENAI_TIMEOUT: "PROVIDER_TIMEOUT",
  OPENAI_REQUEST_FAILED: "PROVIDER_UNAVAILABLE",
  OPENAI_EMPTY_BODY: "PROVIDER_EMPTY_BODY",
  OPENAI_INVALID_JSON: "PROVIDER_INVALID_JSON",
};

function metadataEnabled() {
  return String(process.env.AI_BASELINE_METADATA_ENABLED ?? "false").toLowerCase() === "true";
}

function isDisallowedMetadataKey(key) {
  return /(prompt|output|response|body|raw|transcript|message|content)/i.test(key);
}

function sanitizeMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return {};
  return Object.fromEntries(
    Object.entries(metadata).filter(([key]) => !isDisallowedMetadataKey(key)),
  );
}

export function mapProviderErrorToTaxonomyCode(code) {
  return TAXONOMY_BY_PROVIDER_CODE[code] ?? null;
}

export function isValidAiUsageAction(actionType) {
  return AI_USAGE_ACTION_SET.has(actionType);
}

export function billingActionForTask(taskName, fallback = "GENERATE_POST") {
  return BILLING_ACTION_BY_TASK[taskName] ?? fallback;
}

export function buildAiUsageMetadata({
  actionType,
  model,
  metadata,
  requestId,
  traceId,
  taskName,
  taskVersion = "node-current",
  schemaName,
  promptVersion,
  provider,
  latencyMs,
  providerStatus,
  taxonomyCode,
  systemInitiated,
  source,
  artifactIds,
} = {}) {
  const base = sanitizeMetadata(metadata);

  const normalizedTaskName =
    taskName ?? base.taskName ?? DEFAULT_TASK_BY_ACTION[actionType] ?? "unknown_ai_task";
  const normalizedProvider =
    provider ?? base.provider ?? (typeof model === "string" && model.startsWith("fal-ai/") ? "fal" : "openai");

  const alwaysSafe = {
    ...base,
    source: source ?? base.source ?? normalizedTaskName,
    taskName: normalizedTaskName,
    provider: normalizedProvider,
    model: model ?? base.model ?? null,
    systemInitiated: systemInitiated ?? base.systemInitiated ?? false,
  };

  if (!metadataEnabled()) return alwaysSafe;

  return {
    ...alwaysSafe,
    requestId: requestId ?? base.requestId ?? null,
    traceId: traceId ?? base.traceId ?? requestId ?? null,
    taskVersion: taskVersion ?? base.taskVersion ?? "node-current",
    schemaName: schemaName ?? base.schemaName ?? null,
    promptVersion: promptVersion ?? base.promptVersion ?? null,
    latencyMs: Number.isFinite(latencyMs) ? latencyMs : (base.latencyMs ?? null),
    providerStatus: providerStatus ?? base.providerStatus ?? "success",
    taxonomyCode: taxonomyCode ?? base.taxonomyCode ?? null,
    artifactIds: artifactIds ?? base.artifactIds ?? undefined,
  };
}

/**
 * Fire-and-forget: append a row to the AiUsageLog table.
 *
 * @param {object} params
 * @param {string} params.userId
 * @param {string} [params.clientId]
 * @param {string} params.actionType — AiActionType enum value
 * @param {string} params.model — e.g. "gpt-4o-mini", "fal-ai/flux/dev"
 * @param {number} [params.promptTokens=0]
 * @param {number} [params.completionTokens=0]
 * @param {object} [params.metadata]
 */
export function trackAiUsage({
  userId,
  clientId,
  actionType,
  model,
  promptTokens = 0,
  completionTokens = 0,
  metadata,
  requestId,
  traceId,
  taskName,
  taskVersion,
  schemaName,
  promptVersion,
  provider,
  latencyMs,
  providerStatus,
  taxonomyCode,
  systemInitiated,
  source,
  artifactIds,
}) {
  if (!isValidAiUsageAction(actionType)) {
    console.error("[AI_USAGE_TRACKING] Invalid action type:", actionType);
    return;
  }
  if (!userId) {
    console.error("[AI_USAGE_TRACKING] Missing userId for action:", actionType);
    return;
  }
  const cost = estimateCostCents(model, promptTokens, completionTokens);
  const normalizedMetadata = buildAiUsageMetadata({
    actionType,
    model,
    metadata,
    requestId,
    traceId,
    taskName,
    taskVersion,
    schemaName,
    promptVersion,
    provider,
    latencyMs,
    providerStatus,
    taxonomyCode,
    systemInitiated,
    source,
    artifactIds,
  });

  prisma.aiUsageLog
    .create({
      data: {
        userId,
        clientId: clientId ?? null,
        actionType,
        model,
        promptTokens,
        completionTokens,
        estimatedCostCents: cost,
        metadata: normalizedMetadata,
      },
    })
    .catch((err) => {
      console.error("[AI_USAGE_TRACKING] Failed to log:", err.message);
    });
}

/**
 * Aggregated usage by action type for a user within a period.
 *
 * @param {string} userId
 * @param {Date} from
 * @param {Date} to
 * @returns {Promise<Array<{ actionType: string, count: number, totalPromptTokens: number, totalCompletionTokens: number, totalCostCents: number }>>}
 */
export async function getUsageForPeriod(userId, from, to) {
  const rows = await prisma.aiUsageLog.groupBy({
    by: ["actionType"],
    where: {
      userId,
      createdAt: { gte: from, lt: to },
    },
    _count: true,
    _sum: {
      promptTokens: true,
      completionTokens: true,
      estimatedCostCents: true,
    },
  });

  return rows.map((r) => ({
    actionType: r.actionType,
    count: r._count,
    totalPromptTokens: r._sum.promptTokens ?? 0,
    totalCompletionTokens: r._sum.completionTokens ?? 0,
    totalCostCents: r._sum.estimatedCostCents ?? 0,
  }));
}

/**
 * Cost breakdown by model for a user within a period.
 *
 * @param {string} userId
 * @param {Date} from
 * @param {Date} to
 * @returns {Promise<Array<{ model: string, count: number, totalPromptTokens: number, totalCompletionTokens: number, totalCostCents: number }>>}
 */
export async function getAiCostBreakdown(userId, from, to) {
  const rows = await prisma.aiUsageLog.groupBy({
    by: ["model"],
    where: {
      userId,
      createdAt: { gte: from, lt: to },
    },
    _count: true,
    _sum: {
      promptTokens: true,
      completionTokens: true,
      estimatedCostCents: true,
    },
  });

  return rows.map((r) => ({
    model: r.model,
    count: r._count,
    totalPromptTokens: r._sum.promptTokens ?? 0,
    totalCompletionTokens: r._sum.completionTokens ?? 0,
    totalCostCents: r._sum.estimatedCostCents ?? 0,
  }));
}
