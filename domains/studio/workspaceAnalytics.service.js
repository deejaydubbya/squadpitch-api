// Workspace analytics service.
//
// Pre-computes aggregates for fast dashboard reads and creates daily snapshots
// for time-series charts.

import { prisma } from '../../prisma.js';

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
        select: { performanceScore: true, contentType: true, mediaType: true },
      },
    },
  });

  const totalPosts = await prisma.draft.count({ where: { clientId } });
  const totalPublishedPosts = drafts.length;

  const scores = drafts.map((d) => d.postInsight?.performanceScore).filter((s) => s != null);
  const rates = drafts.map((d) => d.normalizedMetric?.engagementRate).filter((r) => r != null);
  const reaches = drafts.map((d) => d.normalizedMetric?.reach ?? 0);
  const engagements = drafts.map((d) => d.normalizedMetric?.engagements ?? 0);

  const avg = (arr) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

  // Best platform by avg score
  const byChannel = {};
  for (const d of drafts) {
    const score = d.postInsight?.performanceScore;
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

  // Best content type by count
  const contentCounts = {};
  for (const d of drafts) {
    const ct = d.postInsight?.contentType;
    if (ct) contentCounts[ct] = (contentCounts[ct] || 0) + 1;
  }
  const bestContentType = Object.entries(contentCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  // Best media type by count
  const mediaCounts = {};
  for (const d of drafts) {
    const mt = d.postInsight?.mediaType;
    if (mt) mediaCounts[mt] = (mediaCounts[mt] || 0) + 1;
  }
  const bestMediaType = Object.entries(mediaCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  const data = {
    avgEngagementRate: avg(rates),
    avgPerformanceScore: avg(scores),
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
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);

  const drafts = await prisma.draft.findMany({
    where: { clientId, status: 'PUBLISHED' },
    select: {
      normalizedMetric: {
        select: { engagementRate: true, reach: true, engagements: true },
      },
      postInsight: {
        select: { performanceScore: true },
      },
    },
  });

  const scores = drafts.map((d) => d.postInsight?.performanceScore).filter((s) => s != null);
  const rates = drafts.map((d) => d.normalizedMetric?.engagementRate).filter((r) => r != null);
  const reaches = drafts.map((d) => d.normalizedMetric?.reach ?? 0);
  const engagements = drafts.map((d) => d.normalizedMetric?.engagements ?? 0);

  const avg = (arr) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

  const data = {
    avgPerformanceScore: avg(scores),
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
