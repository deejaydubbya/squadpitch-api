import { prisma } from '../../prisma.js';
import { backfillClientInsights } from './normalization.service.js';
import { getMetricsSyncStatus } from './metricsSyncService.js';
import { generateInsights } from './insights.service.js';
import { generateRecommendations } from './recommendations.service.js';
import {
  getClientChannelBenchmarks,
  getPostingConsistencyScore,
  explainPerformanceScoreBreakdown,
} from './performanceScoring.service.js';

// ── Range Helpers ─────────────────────────────────────────────────────

function getRangeDate(range) {
  if (range === 'all') return null;
  const days = { '7d': 7, '30d': 30, '90d': 90 };
  const d = new Date();
  d.setDate(d.getDate() - (days[range] || 30));
  return d;
}

function getDateFilter(range) {
  const since = getRangeDate(range);
  return since ? { publishedAt: { gte: since } } : {};
}

// ── Main Overview ─────────────────────────────────────────────────────

export async function getAnalyticsOverview({ clientId, range = '30d' }) {
  const dateFilter = getDateFilter(range);

  // Lazy backfill: create insights if none exist
  const insightCount = await prisma.postInsight.count({ where: { clientId } });
  if (insightCount === 0) {
    await backfillClientInsights(clientId);
  }

  // Get published drafts in range
  const drafts = await prisma.draft.findMany({
    where: { clientId, status: 'PUBLISHED', ...dateFilter },
    select: {
      id: true,
      body: true,
      channel: true,
      publishedAt: true,
      mediaType: true,
      normalizedMetric: {
        select: { impressions: true, reach: true, engagements: true, engagementRate: true },
      },
      postInsight: {
        select: { performanceScore: true, contentType: true, mediaType: true, hookType: true, sentiment: true, recommendationTags: true, lengthBucket: true, postingTimeBucket: true },
      },
    },
    orderBy: { publishedAt: 'desc' },
  });

  const postsPublished = drafts.length;

  // Data coverage
  const withEngagement = drafts.filter((d) => d.normalizedMetric != null).length;
  const withInternalOnly = drafts.filter((d) => d.normalizedMetric == null && d.postInsight != null).length;
  const coveragePercent = postsPublished > 0 ? Math.round((withEngagement / postsPublished) * 100) : 0;

  let dataCoverageLabel = 'internal_only';
  if (withEngagement === postsPublished && postsPublished > 0) dataCoverageLabel = 'full';
  else if (withEngagement > 0) dataCoverageLabel = 'partial';

  // Summary
  const scores = drafts.map((d) => d.postInsight?.performanceScore).filter((s) => s != null);
  const engRates = drafts.map((d) => d.normalizedMetric?.engagementRate).filter((r) => r != null);
  const reachValues = drafts.map((d) => d.normalizedMetric?.reach).filter((r) => r != null);

  const summary = {
    performanceScore: scores.length > 0 ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
    engagementRate: engRates.length > 0 ? engRates.reduce((a, b) => a + b, 0) / engRates.length : null,
    totalReach: reachValues.length > 0 ? reachValues.reduce((a, b) => a + b, 0) : null,
    postsPublished,
    dataCoverage: dataCoverageLabel,
  };

  // KPIs
  const channelStats = buildPlatformBreakdown(drafts);
  const bestChannel = channelStats.sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0))[0];
  const contentTypes = groupBy(drafts, (d) => d.postInsight?.contentType);
  const mediaTypes = groupBy(drafts, (d) => d.postInsight?.mediaType);

  const kpis = {
    topPlatform: bestChannel?.channel ?? null,
    bestContentType: getBestGroup(contentTypes),
    bestMediaType: getBestGroup(mediaTypes),
  };

  // Top & worst posts
  const scoredDrafts = drafts
    .filter((d) => d.postInsight?.performanceScore != null)
    .map((d) => ({
      id: d.id,
      body: d.body?.slice(0, 200) || '',
      channel: d.channel,
      publishedAt: d.publishedAt?.toISOString() || null,
      mediaType: d.mediaType,
      performanceScore: d.postInsight.performanceScore,
      engagementRate: d.normalizedMetric?.engagementRate ?? null,
      impressions: d.normalizedMetric?.impressions ?? null,
      contentType: d.postInsight.contentType ?? null,
      hookType: d.postInsight.hookType ?? null,
      sentiment: d.postInsight.sentiment ?? null,
    }));

  const topPosts = [...scoredDrafts].sort((a, b) => b.performanceScore - a.performanceScore).slice(0, 5);
  const worstPosts = [...scoredDrafts].sort((a, b) => a.performanceScore - b.performanceScore).slice(0, 5);

  // Publishing trend
  const publishingTrend = buildPublishingTrend(drafts, range);

  // Sync status + insights + recommendations in parallel
  const [syncStatus, insights, recResult] = await Promise.all([
    getMetricsSyncStatus(clientId),
    generateInsights({ clientId, range }).catch(() => []),
    generateRecommendations({ clientId, range }).catch(() => ({ recommendations: [] })),
  ]);

  // Content type breakdown
  const contentTypeBreakdown = Object.entries(contentTypes).map(([contentType, items]) => {
    const scores = items.map((d) => d.postInsight?.performanceScore).filter((s) => s != null);
    return {
      contentType,
      postCount: items.length,
      avgScore: scores.length > 0 ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
    };
  });

  return {
    summary,
    kpis,
    topPosts,
    worstPosts,
    platformBreakdown: channelStats,
    publishingTrend,
    dataCoverage: {
      totalPublished: postsPublished,
      withEngagementData: withEngagement,
      withInternalOnly,
      coveragePercent,
    },
    syncStatus: {
      lastSyncedAt: syncStatus.lastSyncedAt?.toISOString() ?? null,
      syncedPostCount: syncStatus.syncedPostCount,
      pendingSyncCount: syncStatus.pendingSyncCount,
    },
    insights,
    recommendations: recResult.recommendations,
    contentTypeBreakdown,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

function buildPlatformBreakdown(drafts) {
  const byChannel = {};
  for (const d of drafts) {
    if (!byChannel[d.channel]) byChannel[d.channel] = { posts: [], rates: [], scores: [], reaches: [] };
    byChannel[d.channel].posts.push(d);
    if (d.normalizedMetric?.engagementRate != null) byChannel[d.channel].rates.push(d.normalizedMetric.engagementRate);
    if (d.postInsight?.performanceScore != null) byChannel[d.channel].scores.push(d.postInsight.performanceScore);
    if (d.normalizedMetric?.reach != null) byChannel[d.channel].reaches.push(d.normalizedMetric.reach);
  }

  return Object.entries(byChannel).map(([channel, data]) => ({
    channel,
    postCount: data.posts.length,
    avgEngagementRate: data.rates.length > 0 ? data.rates.reduce((a, b) => a + b, 0) / data.rates.length : null,
    avgScore: data.scores.length > 0 ? Math.round((data.scores.reduce((a, b) => a + b, 0) / data.scores.length) * 10) / 10 : null,
    totalReach: data.reaches.length > 0 ? data.reaches.reduce((a, b) => a + b, 0) : null,
  }));
}

function buildPublishingTrend(drafts, range) {
  const bucketByDay = {};
  for (const d of drafts) {
    if (!d.publishedAt) continue;
    const day = d.publishedAt.toISOString().slice(0, 10);
    if (!bucketByDay[day]) bucketByDay[day] = { count: 0, scores: [] };
    bucketByDay[day].count++;
    if (d.postInsight?.performanceScore != null) bucketByDay[day].scores.push(d.postInsight.performanceScore);
  }

  return Object.entries(bucketByDay)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, data]) => ({
      date,
      count: data.count,
      avgScore: data.scores.length > 0 ? Math.round((data.scores.reduce((a, b) => a + b, 0) / data.scores.length) * 10) / 10 : null,
    }));
}

function groupBy(items, keyFn) {
  const groups = {};
  for (const item of items) {
    const key = keyFn(item);
    if (!key) continue;
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }
  return groups;
}

function getBestGroup(groups) {
  let best = null;
  let bestCount = 0;
  for (const [key, items] of Object.entries(groups)) {
    if (items.length > bestCount) { best = key; bestCount = items.length; }
  }
  return best;
}

// ── Post Detail ─────────────────────────────────────────────────────

export async function getPostDetail(clientId, postId) {
  const draft = await prisma.draft.findUnique({
    where: { id: postId },
    select: {
      id: true,
      clientId: true,
      body: true,
      channel: true,
      status: true,
      publishedAt: true,
      mediaType: true,
      mediaUrl: true,
      externalPostUrl: true,
      hooks: true,
      hashtags: true,
      cta: true,
      normalizedMetric: {
        select: { impressions: true, reach: true, engagements: true, clicks: true, engagementRate: true },
      },
      postInsight: {
        select: {
          performanceScore: true, contentType: true, hookType: true, sentiment: true,
          lengthBucket: true, mediaType: true, postingTimeBucket: true, recommendationTags: true,
        },
      },
      metrics: {
        select: {
          impressions: true, reach: true, engagement: true, clicks: true,
          saves: true, shares: true, comments: true, likes: true, engagementRate: true,
        },
      },
    },
  });

  if (!draft) return null;
  if (draft.clientId !== clientId) return null;
  if (draft.status !== 'PUBLISHED') return null;

  // Get benchmarks + consistency for score breakdown
  const [benchmarks, consistencyScore] = await Promise.all([
    getClientChannelBenchmarks(clientId, draft.channel),
    getPostingConsistencyScore(clientId),
  ]);

  const scoreBreakdown = explainPerformanceScoreBreakdown(
    draft, draft.normalizedMetric, benchmarks, consistencyScore
  );

  return {
    id: draft.id,
    body: draft.body,
    channel: draft.channel,
    publishedAt: draft.publishedAt?.toISOString() ?? null,
    mediaType: draft.mediaType,
    mediaUrl: draft.mediaUrl,
    externalPostUrl: draft.externalPostUrl,
    metrics: draft.metrics
      ? {
          impressions: draft.metrics.impressions,
          reach: draft.metrics.reach,
          engagements: draft.metrics.engagement,
          clicks: draft.metrics.clicks,
          saves: draft.metrics.saves,
          shares: draft.metrics.shares,
          comments: draft.metrics.comments,
          likes: draft.metrics.likes,
          engagementRate: draft.metrics.engagementRate,
        }
      : null,
    insight: draft.postInsight
      ? {
          performanceScore: draft.postInsight.performanceScore,
          contentType: draft.postInsight.contentType,
          hookType: draft.postInsight.hookType,
          sentiment: draft.postInsight.sentiment,
          lengthBucket: draft.postInsight.lengthBucket,
          mediaType: draft.postInsight.mediaType,
          postingTimeBucket: draft.postInsight.postingTimeBucket,
          recommendationTags: draft.postInsight.recommendationTags,
        }
      : null,
    scoreBreakdown,
  };
}
