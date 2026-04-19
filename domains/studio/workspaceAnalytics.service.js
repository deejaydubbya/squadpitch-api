// Workspace analytics service.
//
// Pre-computes aggregates for fast dashboard reads and creates daily snapshots
// for time-series charts.

import { prisma } from '../../prisma.js';
import { getClientTimezone, getLocalMidnight } from '../../lib/timezone.js';

// ── Recalculate Workspace Analytics ─────────────────────────────────

export async function recalculateWorkspaceAnalytics(clientId) {
  const drafts = await prisma.draft.findMany({
    where: { clientId, status: 'PUBLISHED' },
    select: {
      id: true,
      channel: true,
      normalizedMetric: {
        select: { engagementRate: true, reach: true, engagements: true },
      },
      postInsight: {
        select: { qualityScore: true, observedScore: true, compositeScore: true, contentType: true, mediaType: true },
      },
    },
  });

  const totalPosts = await prisma.draft.count({ where: { clientId } });
  const totalPublishedPosts = drafts.length;

  const qualityScores = drafts.map((d) => d.postInsight?.qualityScore).filter((s) => s != null);
  const observedScores = drafts.map((d) => d.postInsight?.observedScore).filter((s) => s != null);
  const compositeScores = drafts.map((d) => d.postInsight?.compositeScore).filter((s) => s != null);
  const rates = drafts.map((d) => d.normalizedMetric?.engagementRate).filter((r) => r != null);
  const reaches = drafts.map((d) => d.normalizedMetric?.reach).filter((r) => r != null);
  const engagements = drafts.map((d) => d.normalizedMetric?.engagements).filter((r) => r != null);

  const avg = (arr) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

  // Best platform by avg compositeScore
  const byChannel = {};
  for (const d of drafts) {
    const score = d.postInsight?.compositeScore;
    if (score == null) continue;
    if (!byChannel[d.channel]) byChannel[d.channel] = [];
    byChannel[d.channel].push(score);
  }
  let topPlatform = null;
  let topPlatformAvg = -1;
  for (const [channel, channelScores] of Object.entries(byChannel)) {
    const channelAvg = avg(channelScores);
    if (channelAvg != null && channelAvg > topPlatformAvg) {
      topPlatform = channel;
      topPlatformAvg = channelAvg;
    }
  }

  // Best content type by avg compositeScore
  const contentScores = {};
  for (const d of drafts) {
    const ct = d.postInsight?.contentType;
    const score = d.postInsight?.compositeScore;
    if (ct && score != null) {
      if (!contentScores[ct]) contentScores[ct] = [];
      contentScores[ct].push(score);
    }
  }
  const bestContentType = Object.entries(contentScores)
    .map(([k, scores]) => [k, scores.reduce((a, b) => a + b, 0) / scores.length])
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  // Best media type by avg compositeScore
  const mediaScores = {};
  for (const d of drafts) {
    const mt = d.postInsight?.mediaType;
    const score = d.postInsight?.compositeScore;
    if (mt && score != null) {
      if (!mediaScores[mt]) mediaScores[mt] = [];
      mediaScores[mt].push(score);
    }
  }
  const bestMediaType = Object.entries(mediaScores)
    .map(([k, scores]) => [k, scores.reduce((a, b) => a + b, 0) / scores.length])
    .sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const data = {
    avgEngagementRate: avg(rates),
    avgQualityScore: avg(qualityScores),
    avgObservedScore: avg(observedScores),
    avgCompositeScore: avg(compositeScores),
    totalPosts,
    totalPublishedPosts,
    totalReach: reaches.reduce((a, b) => a + b, 0),
    totalEngagements: engagements.reduce((a, b) => a + b, 0),
    topPlatform,
    bestContentType,
    bestMediaType,
    lastCalculatedAt: new Date(),
  };

  return prisma.workspaceAnalytics.upsert({
    where: { clientId },
    create: { clientId, ...data },
    update: data,
  });
}

// ── Daily Snapshot ──────────────────────────────────────────────────

export async function createDailySnapshot(clientId) {
  const timezone = await getClientTimezone(clientId);
  const today = getLocalMidnight(timezone);

  const drafts = await prisma.draft.findMany({
    where: { clientId, status: 'PUBLISHED' },
    select: {
      normalizedMetric: {
        select: { engagementRate: true, reach: true, engagements: true },
      },
      postInsight: {
        select: { qualityScore: true, observedScore: true, compositeScore: true },
      },
    },
  });

  const qualityScores = drafts.map((d) => d.postInsight?.qualityScore).filter((s) => s != null);
  const observedScores = drafts.map((d) => d.postInsight?.observedScore).filter((s) => s != null);
  const compositeScores = drafts.map((d) => d.postInsight?.compositeScore).filter((s) => s != null);
  const rates = drafts.map((d) => d.normalizedMetric?.engagementRate).filter((r) => r != null);
  const reaches = drafts.map((d) => d.normalizedMetric?.reach).filter((r) => r != null);
  const engagements = drafts.map((d) => d.normalizedMetric?.engagements).filter((r) => r != null);

  const avg = (arr) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

  const data = {
    avgQualityScore: avg(qualityScores),
    avgObservedScore: avg(observedScores),
    avgCompositeScore: avg(compositeScores),
    avgEngagementRate: avg(rates),
    totalPosts: drafts.length,
    totalReach: reaches.reduce((a, b) => a + b, 0),
    totalEngagements: engagements.reduce((a, b) => a + b, 0),
  };

  return prisma.analyticsSnapshot.upsert({
    where: { clientId_snapshotDate: { clientId, snapshotDate: today } },
    create: { clientId, snapshotDate: today, ...data },
    update: data,
  });
}

// ── Stale Detection ─────────────────────────────────────────────────

export async function getClientsNeedingRecalculation() {
  const threshold = new Date(Date.now() - 25 * 60 * 1000); // 25 minutes ago

  // Clients with stale or missing WorkspaceAnalytics
  const allClients = await prisma.client.findMany({
    where: { status: 'ACTIVE' },
    select: {
      id: true,
      workspaceAnalytics: { select: { lastCalculatedAt: true } },
    },
  });

  return allClients
    .filter((c) => !c.workspaceAnalytics || c.workspaceAnalytics.lastCalculatedAt < threshold)
    .map((c) => c.id);
}

export async function getClientsNeedingInsightsRefresh() {
  // Clients with 5+ PostInsight rows updated since their last WorkspaceAnalytics calculation
  const allClients = await prisma.client.findMany({
    where: { status: 'ACTIVE' },
    select: {
      id: true,
      workspaceAnalytics: { select: { lastCalculatedAt: true } },
    },
  });

  const result = [];
  for (const client of allClients) {
    const since = client.workspaceAnalytics?.lastCalculatedAt ?? new Date(0);
    const recentInsightCount = await prisma.postInsight.count({
      where: { clientId: client.id, updatedAt: { gt: since } },
    });
    if (recentInsightCount >= 5) {
      result.push(client.id);
    }
  }

  return result;
}
