// Squadpitch post metrics — analytics foundation.
//
// Provides read access to PostMetrics rows.
// syncMetrics is STUBBED — actual platform API integration (Instagram Insights,
// etc.) will be implemented when connection refresh tokens are available.

import { prisma } from "../../prisma.js";

export async function getMetrics(draftId) {
  return prisma.postMetrics.findUnique({
    where: { draftId },
  });
}

export async function getClientMetricsSummary({
  clientId,
  channel,
  since,
  until,
}) {
  const where = { clientId };
  if (channel) where.channel = channel;

  const dateFilter = {};
  if (since) dateFilter.gte = new Date(since);
  if (until) dateFilter.lte = new Date(until);
  if (Object.keys(dateFilter).length > 0) {
    where.createdAt = dateFilter;
  }

  const rows = await prisma.postMetrics.findMany({
    where,
    orderBy: { createdAt: "desc" },
  });

  if (rows.length === 0) {
    return { totalPosts: 0, totals: null, averages: null, byChannel: {} };
  }

  // Aggregate totals.
  const totals = {
    impressions: 0,
    reach: 0,
    engagement: 0,
    clicks: 0,
    saves: 0,
    shares: 0,
    comments: 0,
    likes: 0,
  };

  const byChannel = {};

  for (const row of rows) {
    for (const key of Object.keys(totals)) {
      totals[key] += row[key];
    }

    if (!byChannel[row.channel]) {
      byChannel[row.channel] = { count: 0, impressions: 0, engagement: 0 };
    }
    byChannel[row.channel].count += 1;
    byChannel[row.channel].impressions += row.impressions;
    byChannel[row.channel].engagement += row.engagement;
  }

  const count = rows.length;
  const averages = {};
  for (const key of Object.keys(totals)) {
    averages[key] = Math.round(totals[key] / count);
  }

  return { totalPosts: count, totals, averages, byChannel };
}

/**
 * Stub — will integrate with platform APIs (Instagram Insights, etc.)
 * once connection refresh + token rotation is implemented.
 */
export async function syncMetrics(draftId) {
  return { synced: false, reason: "not_implemented" };
}

export function formatMetrics(metrics) {
  if (!metrics) return null;
  return {
    id: metrics.id,
    draftId: metrics.draftId,
    clientId: metrics.clientId,
    channel: metrics.channel,
    impressions: metrics.impressions,
    reach: metrics.reach,
    engagement: metrics.engagement,
    clicks: metrics.clicks,
    saves: metrics.saves,
    shares: metrics.shares,
    comments: metrics.comments,
    likes: metrics.likes,
    engagementRate: metrics.engagementRate,
    lastSyncedAt: metrics.lastSyncedAt,
    createdAt: metrics.createdAt,
    updatedAt: metrics.updatedAt,
  };
}
