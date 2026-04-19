import { prisma } from '../../prisma.js';

export async function getCampaignsSection({ clientId, since }) {
  const dateFilter = since ? { publishedAt: { gte: since } } : {};

  const drafts = await prisma.draft.findMany({
    where: {
      clientId,
      status: 'PUBLISHED',
      campaignId: { not: null },
      ...dateFilter,
    },
    select: {
      campaignId: true,
      campaignName: true,
      campaignType: true,
      campaignDay: true,
      campaignOrder: true,
      campaignTotal: true,
      normalizedMetric: {
        select: { impressions: true, reach: true, engagements: true, engagementRate: true },
      },
      postInsight: {
        select: { qualityScore: true, observedScore: true, compositeScore: true },
      },
    },
  });

  if (drafts.length === 0) {
    return {
      totalCampaigns: 0,
      completedCampaigns: 0,
      avgCompletionRate: null,
      totalCampaignReach: null,
      totalCampaignImpressions: null,
      avgCampaignScore: null,
      byType: [],
      byDay: [],
      topCampaigns: [],
      worstCampaigns: [],
      hasData: false,
    };
  }

  // Group by campaignId
  const campaigns = {};
  for (const d of drafts) {
    const id = d.campaignId;
    if (!campaigns[id]) {
      campaigns[id] = {
        campaignId: id,
        campaignName: d.campaignName,
        campaignType: d.campaignType,
        campaignTotal: d.campaignTotal ?? 0,
        posts: [],
      };
    }
    campaigns[id].posts.push(d);
  }

  const campaignList = Object.values(campaigns);
  const totalCampaigns = campaignList.length;

  // Per-campaign aggregation
  const campaignAggregates = campaignList.map((c) => {
    const scores = c.posts
      .map((p) => p.postInsight?.compositeScore)
      .filter((s) => s != null);
    const oScores = c.posts
      .map((p) => p.postInsight?.observedScore)
      .filter((s) => s != null);
    const engRates = c.posts
      .map((p) => p.normalizedMetric?.engagementRate)
      .filter((r) => r != null);
    const reaches = c.posts
      .map((p) => p.normalizedMetric?.reach)
      .filter((r) => r != null);

    const postCount = c.posts.length;
    const completionRate = c.campaignTotal > 0 ? postCount / c.campaignTotal : 0;

    return {
      campaignId: c.campaignId,
      campaignName: c.campaignName,
      campaignType: c.campaignType,
      postCount,
      campaignTotal: c.campaignTotal,
      completionRate,
      avgScore: scores.length > 0
        ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
        : null,
      avgObservedScore: oScores.length > 0
        ? Math.round((oScores.reduce((a, b) => a + b, 0) / oScores.length) * 10) / 10
        : null,
      avgEngagementRate: engRates.length > 0
        ? engRates.reduce((a, b) => a + b, 0) / engRates.length
        : null,
      totalReach: reaches.length > 0 ? reaches.reduce((a, b) => a + b, 0) : null,
    };
  });

  // Completion stats
  const completedCampaigns = campaignAggregates.filter(
    (c) => c.postCount >= c.campaignTotal && c.campaignTotal > 0,
  ).length;
  const completionRates = campaignAggregates
    .filter((c) => c.campaignTotal > 0)
    .map((c) => c.completionRate);
  const avgCompletionRate = completionRates.length > 0
    ? completionRates.reduce((a, b) => a + b, 0) / completionRates.length
    : null;

  // Totals
  const allReaches = drafts.map((d) => d.normalizedMetric?.reach).filter((r) => r != null);
  const allImpressions = drafts.map((d) => d.normalizedMetric?.impressions).filter((r) => r != null);
  const allScores = drafts.map((d) => d.postInsight?.compositeScore).filter((s) => s != null);

  const totalCampaignReach = allReaches.length > 0 ? allReaches.reduce((a, b) => a + b, 0) : null;
  const totalCampaignImpressions = allImpressions.length > 0 ? allImpressions.reduce((a, b) => a + b, 0) : null;
  const avgCampaignScore = allScores.length > 0
    ? Math.round((allScores.reduce((a, b) => a + b, 0) / allScores.length) * 10) / 10
    : null;

  // byType aggregation
  const typeGroups = {};
  for (const c of campaignAggregates) {
    const t = c.campaignType || 'unknown';
    if (!typeGroups[t]) typeGroups[t] = [];
    typeGroups[t].push(c);
  }

  const byType = Object.entries(typeGroups).map(([campaignType, items]) => {
    const scores = items.map((c) => c.avgScore).filter((s) => s != null);
    const engRates = items.map((c) => c.avgEngagementRate).filter((r) => r != null);
    const compRates = items.filter((c) => c.campaignTotal > 0).map((c) => c.completionRate);
    return {
      campaignType,
      campaignCount: items.length,
      totalPosts: items.reduce((sum, c) => sum + c.postCount, 0),
      avgScore: scores.length > 0
        ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
        : null,
      avgEngagementRate: engRates.length > 0
        ? engRates.reduce((a, b) => a + b, 0) / engRates.length
        : null,
      avgCompletionRate: compRates.length > 0
        ? compRates.reduce((a, b) => a + b, 0) / compRates.length
        : null,
    };
  });

  // byDay aggregation (across all campaigns)
  const dayGroups = {};
  for (const d of drafts) {
    if (d.campaignDay == null) continue;
    const day = d.campaignDay;
    if (!dayGroups[day]) dayGroups[day] = { scores: [], engRates: [], count: 0 };
    dayGroups[day].count++;
    if (d.postInsight?.compositeScore != null) dayGroups[day].scores.push(d.postInsight.compositeScore);
    if (d.normalizedMetric?.engagementRate != null) dayGroups[day].engRates.push(d.normalizedMetric.engagementRate);
  }

  const byDay = Object.entries(dayGroups)
    .map(([day, data]) => ({
      day: parseInt(day, 10),
      postCount: data.count,
      avgScore: data.scores.length > 0
        ? Math.round((data.scores.reduce((a, b) => a + b, 0) / data.scores.length) * 10) / 10
        : null,
      avgEngagementRate: data.engRates.length > 0
        ? data.engRates.reduce((a, b) => a + b, 0) / data.engRates.length
        : null,
    }))
    .sort((a, b) => a.day - b.day);

  // Top/worst campaigns by observedScore (fallback compositeScore)
  const sortScore = (c) => c.avgObservedScore ?? c.avgScore ?? -1;
  const sorted = [...campaignAggregates].sort((a, b) => sortScore(b) - sortScore(a));

  const mapRanked = (c) => ({
    campaignId: c.campaignId,
    campaignName: c.campaignName,
    campaignType: c.campaignType,
    postCount: c.postCount,
    campaignTotal: c.campaignTotal,
    completionRate: c.completionRate,
    avgScore: c.avgScore,
    avgEngagementRate: c.avgEngagementRate,
    totalReach: c.totalReach,
  });

  const topCampaigns = sorted.slice(0, 5).map(mapRanked);
  const worstCampaigns = [...campaignAggregates]
    .sort((a, b) => sortScore(a) - sortScore(b))
    .slice(0, 5)
    .map(mapRanked);

  return {
    totalCampaigns,
    completedCampaigns,
    avgCompletionRate,
    totalCampaignReach,
    totalCampaignImpressions,
    avgCampaignScore,
    byType,
    byDay,
    topCampaigns,
    worstCampaigns,
    hasData: totalCampaigns > 0,
  };
}
