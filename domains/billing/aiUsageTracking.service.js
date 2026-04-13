// AI Usage Tracking Service — granular per-call audit log for AI operations.

import { prisma } from "../../prisma.js";
import { estimateCostCents } from "./aiModelRouter.js";

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
}) {
  const cost = estimateCostCents(model, promptTokens, completionTokens);

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
        metadata: metadata ?? undefined,
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
