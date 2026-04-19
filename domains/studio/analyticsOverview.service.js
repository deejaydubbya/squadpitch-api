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
import { getPostMetricGrowth } from './postMetricHistory.service.js';
import { getClientTimezone, getLocalDateString } from '../../lib/timezone.js';
import { getConversionsSection } from './conversionAnalytics.service.js';
import { getCampaignsSection } from './campaignAnalytics.service.js';
import { getAutopilotSection } from './autopilotAnalytics.service.js';
import { getBusinessDataSection } from './businessDataAnalytics.service.js';
import { getWorkspaceBenchmarks, compareToBenchmark } from './benchmark.service.js';
import { getAnalyticsDiagnostics } from './analyticsDiagnostics.service.js';

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
  const timezone = await getClientTimezone(clientId);

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
        select: { qualityScore: true, observedScore: true, compositeScore: true, contentType: true, mediaType: true, hookType: true, sentiment: true, recommendationTags: true, lengthBucket: true, postingTimeBucket: true },
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
  const qScores = drafts.map((d) => d.postInsight?.qualityScore).filter((s) => s != null);
  const oScores = drafts.map((d) => d.postInsight?.observedScore).filter((s) => s != null);
  const cScores = drafts.map((d) => d.postInsight?.compositeScore).filter((s) => s != null);
  const engRates = drafts.map((d) => d.normalizedMetric?.engagementRate).filter((r) => r != null);
  const reachValues = drafts.map((d) => d.normalizedMetric?.reach).filter((r) => r != null);
  const impressionValues = drafts.map((d) => d.normalizedMetric?.impressions).filter((r) => r != null);

  const avgRound = (arr) => arr.length > 0 ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10 : null;

  const summary = {
    qualityScore: avgRound(qScores),
    observedScore: avgRound(oScores),
    compositeScore: avgRound(cScores),
    engagementRate: engRates.length > 0 ? engRates.reduce((a, b) => a + b, 0) / engRates.length : null,
    totalReach: reachValues.length > 0 ? reachValues.reduce((a, b) => a + b, 0) : null,
    totalImpressions: impressionValues.length > 0 ? impressionValues.reduce((a, b) => a + b, 0) : null,
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
    .filter((d) => d.postInsight?.compositeScore != null)
    .map((d) => ({
      id: d.id,
      body: d.body?.slice(0, 200) || '',
      channel: d.channel,
      publishedAt: d.publishedAt?.toISOString() || null,
      mediaType: d.mediaType,
      qualityScore: d.postInsight.qualityScore ?? null,
      observedScore: d.postInsight.observedScore ?? null,
      compositeScore: d.postInsight.compositeScore,
      engagementRate: d.normalizedMetric?.engagementRate ?? null,
      impressions: d.normalizedMetric?.impressions ?? null,
      contentType: d.postInsight.contentType ?? null,
      hookType: d.postInsight.hookType ?? null,
      sentiment: d.postInsight.sentiment ?? null,
    }));

  const sortScore = (d) => d.observedScore ?? d.compositeScore;
  const topPosts = [...scoredDrafts].sort((a, b) => sortScore(b) - sortScore(a)).slice(0, 5);
  const worstPosts = [...scoredDrafts].sort((a, b) => sortScore(a) - sortScore(b)).slice(0, 5);

  // Publishing trend
  const publishingTrend = buildPublishingTrend(drafts, range, timezone);

  // Sync status + insights + recommendations + conversions in parallel
  const [syncStatus, insights, recResult, conversionsSection, campaignsSection, autopilotSection, businessDataSection, benchmarks, diagnostics] = await Promise.all([
    getMetricsSyncStatus(clientId),
    generateInsights({ clientId, range, timezone }).catch(() => []),
    generateRecommendations({ clientId, range, timezone }).catch(() => ({ recommendations: [] })),
    getConversionsSection({ clientId, since: getRangeDate(range) }).catch(() => ({
      totalConversions: 0, conversionRate: null, totalPublishedPosts: 0,
      activeLinks: 0, byType: [], byChannel: [], topDrafts: [], hasData: false,
    })),
    getCampaignsSection({ clientId, since: getRangeDate(range) }).catch(() => ({
      totalCampaigns: 0, completedCampaigns: 0, avgCompletionRate: null,
      totalCampaignReach: null, totalCampaignImpressions: null, avgCampaignScore: null,
      byType: [], byDay: [], topCampaigns: [], worstCampaigns: [], hasData: false,
    })),
    getAutopilotSection({ clientId, since: getRangeDate(range) }).catch(() => ({
      totalGenerated: 0, totalPublished: 0, totalApproved: 0, totalRejected: 0, totalPending: 0,
      approvalRate: null, publishRate: null, avgAutopilotScore: null, avgManualScore: null,
      scoreDelta: null, avgAutopilotEngagement: null, avgManualEngagement: null,
      engagementDelta: null, byChannel: [], byTrigger: [], recentActivity: [], hasData: false,
    })),
    getBusinessDataSection({ clientId }).catch(() => ({
      totalDataItems: 0, totalUsed: 0, totalUnused: 0, totalStale: 0,
      totalDraftsFromData: 0, totalPublishedFromData: 0,
      byType: [], byBlueprint: [], byFreshness: [], topItems: [], underusedItems: [], hasData: false,
    })),
    getWorkspaceBenchmarks(clientId, { since: getRangeDate(range) }).catch(() => ({
      workspace: { avgScore: null, avgEngagementRate: null, avgReach: null, sampleSize: 0, scoreSampleSize: 0, engagementSampleSize: 0, confidence: 'insufficient' },
      byChannel: {}, byContentType: {}, byMediaType: {}, hasData: false,
    })),
    getAnalyticsDiagnostics(clientId).catch(() => ({
      channelCoverage: [], connectionHealth: [], freshnessWarnings: [], overallHealth: 'healthy',
    })),
  ]);

  // Content type breakdown
  const contentTypeBreakdown = Object.entries(contentTypes).map(([contentType, items]) => {
    const scores = items.map((d) => d.postInsight?.compositeScore).filter((s) => s != null);
    return {
      contentType,
      postCount: items.length,
      avgScore: scores.length > 0 ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null,
    };
  });

  const formattedSyncStatus = {
    lastSyncedAt: syncStatus.lastSyncedAt?.toISOString() ?? null,
    syncedPostCount: syncStatus.syncedPostCount,
    pendingSyncCount: syncStatus.pendingSyncCount,
  };

  return {
    timezone,
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
    syncStatus: formattedSyncStatus,
    insights,
    recommendations: recResult.recommendations,
    contentTypeBreakdown,
    sections: {
      distribution: {
        totalImpressions: summary.totalImpressions,
        totalReach: summary.totalReach,
        postsPublished,
        publishingTrend,
        platformReach: channelStats,
        hasReachData: summary.totalReach != null,
      },
      engagement: {
        engagementRate: summary.engagementRate,
        observedScore: summary.observedScore,
        topPosts,
        worstPosts,
        hasEngagementData: withEngagement > 0,
      },
      contentIntelligence: {
        qualityScore: summary.qualityScore,
        compositeScore: summary.compositeScore,
        insights,
        recommendations: recResult.recommendations,
        contentTypeBreakdown,
        topPlatform: kpis.topPlatform,
        bestContentType: kpis.bestContentType,
        bestMediaType: kpis.bestMediaType,
      },
      coverage: {
        totalPublished: postsPublished,
        withEngagementData: withEngagement,
        withInternalOnly,
        coveragePercent,
        coverageLabel: dataCoverageLabel,
        syncStatus: formattedSyncStatus,
        channelCoverage: diagnostics.channelCoverage,
        connectionHealth: diagnostics.connectionHealth,
        freshnessWarnings: diagnostics.freshnessWarnings,
        overallHealth: diagnostics.overallHealth,
      },
      conversions: conversionsSection,
      campaigns: campaignsSection,
      autopilot: autopilotSection,
      businessData: businessDataSection,
      benchmarks,
    },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────

function buildPlatformBreakdown(drafts) {
  const byChannel = {};
  for (const d of drafts) {
    if (!byChannel[d.channel]) byChannel[d.channel] = { posts: [], rates: [], scores: [], reaches: [] };
    byChannel[d.channel].posts.push(d);
    if (d.normalizedMetric?.engagementRate != null) byChannel[d.channel].rates.push(d.normalizedMetric.engagementRate);
    if (d.postInsight?.compositeScore != null) byChannel[d.channel].scores.push(d.postInsight.compositeScore);
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

function buildPublishingTrend(drafts, range, timezone = 'UTC') {
  const bucketByDay = {};
  for (const d of drafts) {
    if (!d.publishedAt) continue;
    const day = getLocalDateString(d.publishedAt, timezone);
    if (!bucketByDay[day]) bucketByDay[day] = { count: 0, scores: [] };
    bucketByDay[day].count++;
    if (d.postInsight?.compositeScore != null) bucketByDay[day].scores.push(d.postInsight.compositeScore);
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
  let bestAvg = -1;
  for (const [key, items] of Object.entries(groups)) {
    const scores = items.map((d) => d.postInsight?.compositeScore).filter((s) => s != null);
    if (scores.length === 0) continue;
    const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
    if (avg > bestAvg) { best = key; bestAvg = avg; }
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
          qualityScore: true, observedScore: true, compositeScore: true,
          contentType: true, hookType: true, sentiment: true,
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

  // Get benchmarks, consistency, growth, and workspace benchmarks in parallel
  const [channelBenchmarks, consistencyScore, growth, wsBenchmarks] = await Promise.all([
    getClientChannelBenchmarks(clientId, draft.channel),
    getPostingConsistencyScore(clientId),
    getPostMetricGrowth(postId),
    getWorkspaceBenchmarks(clientId).catch(() => null),
  ]);

  const scoreBreakdown = explainPerformanceScoreBreakdown(
    draft, draft.normalizedMetric, channelBenchmarks, consistencyScore
  );

  // Build benchmark comparisons for this post
  let benchmarkComparison = null;
  if (wsBenchmarks?.hasData) {
    const postScore = draft.postInsight?.compositeScore;
    const postEngRate = draft.normalizedMetric?.engagementRate;
    const contentType = draft.postInsight?.contentType;

    benchmarkComparison = {
      vsWorkspace: {
        score: compareToBenchmark(postScore, wsBenchmarks.workspace, 'avgScore'),
        engagement: compareToBenchmark(postEngRate, wsBenchmarks.workspace, 'avgEngagementRate'),
      },
      vsChannel: {
        score: compareToBenchmark(postScore, wsBenchmarks.byChannel[draft.channel], 'avgScore'),
        engagement: compareToBenchmark(postEngRate, wsBenchmarks.byChannel[draft.channel], 'avgEngagementRate'),
      },
      vsContentType: contentType && wsBenchmarks.byContentType[contentType]
        ? {
            score: compareToBenchmark(postScore, wsBenchmarks.byContentType[contentType], 'avgScore'),
            engagement: compareToBenchmark(postEngRate, wsBenchmarks.byContentType[contentType], 'avgEngagementRate'),
          }
        : null,
    };
  }

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
          qualityScore: draft.postInsight.qualityScore,
          observedScore: draft.postInsight.observedScore,
          compositeScore: draft.postInsight.compositeScore,
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
    benchmarkComparison,
    growth,
  };
}
