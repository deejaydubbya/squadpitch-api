import { prisma } from '../../prisma.js';

// ── Helpers ──────────────────────────────────────────────────────────

function avg(arr) {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function groupByField(insights, field) {
  const groups = {};
  for (const row of insights) {
    const key = row[field];
    if (!key) continue;
    if (!groups[key]) groups[key] = [];
    groups[key].push(row);
  }
  return groups;
}

function confidenceLevel(count) {
  if (count >= 10) return 'high';
  if (count >= 5) return 'medium';
  return 'low';
}

// ── Individual Generators ────────────────────────────────────────────

function bestPlatformInsight(insights) {
  const groups = groupByField(insights, 'channel');
  const entries = Object.entries(groups).filter(([, rows]) => rows.length >= 5);
  if (entries.length < 2) return null;

  const scored = entries.map(([channel, rows]) => ({
    channel,
    avgScore: avg(rows.map((r) => r.performanceScore).filter((s) => s != null)),
    count: rows.length,
  }));
  scored.sort((a, b) => b.avgScore - a.avgScore);

  const gap = scored[0].avgScore - scored[1].avgScore;
  if (gap < 10) return null;

  return {
    type: 'best_platform',
    title: `${scored[0].channel} outperforms your other platforms`,
    description: `Posts on ${scored[0].channel} average a score of ${Math.round(scored[0].avgScore)}, which is ${Math.round(gap)} points higher than your next best platform.`,
    confidence: confidenceLevel(scored[0].count),
    supportingMetrics: { bestPlatform: scored[0].channel, avgScore: Math.round(scored[0].avgScore), gap: Math.round(gap) },
  };
}

function bestMediaTypeInsight(insights) {
  const groups = groupByField(insights, 'mediaType');
  const entries = Object.entries(groups).filter(([, rows]) => rows.length >= 3);
  if (entries.length < 2) return null;

  const scored = entries.map(([mediaType, rows]) => ({
    mediaType,
    avgScore: avg(rows.map((r) => r.performanceScore).filter((s) => s != null)),
    count: rows.length,
  }));
  scored.sort((a, b) => b.avgScore - a.avgScore);

  const gap = scored[0].avgScore - scored[1].avgScore;
  if (gap < 10) return null;

  const label = scored[0].mediaType === 'video' ? 'Video' : scored[0].mediaType === 'image' ? 'Image' : scored[0].mediaType;
  return {
    type: 'best_media_type',
    title: `${label} posts drive your best results`,
    description: `${label} content scores ${Math.round(scored[0].avgScore)} on average, ${Math.round(gap)} points above other formats.`,
    confidence: confidenceLevel(scored[0].count),
    supportingMetrics: { bestMediaType: scored[0].mediaType, avgScore: Math.round(scored[0].avgScore), gap: Math.round(gap) },
  };
}

function bestContentTypeInsight(insights) {
  const groups = groupByField(insights, 'contentType');
  const entries = Object.entries(groups).filter(([, rows]) => rows.length >= 3);
  if (entries.length < 2) return null;

  const scored = entries.map(([contentType, rows]) => ({
    contentType,
    avgScore: avg(rows.map((r) => r.performanceScore).filter((s) => s != null)),
    count: rows.length,
  }));
  scored.sort((a, b) => b.avgScore - a.avgScore);

  const gap = scored[0].avgScore - scored[1].avgScore;
  if (gap < 10) return null;

  const label = scored[0].contentType.charAt(0).toUpperCase() + scored[0].contentType.slice(1);
  return {
    type: 'best_content_type',
    title: `${label} content resonates most`,
    description: `Your ${scored[0].contentType} posts average ${Math.round(scored[0].avgScore)} points, outperforming other types by ${Math.round(gap)} points.`,
    confidence: confidenceLevel(scored[0].count),
    supportingMetrics: { bestContentType: scored[0].contentType, avgScore: Math.round(scored[0].avgScore), gap: Math.round(gap) },
  };
}

function bestPostingTimeInsight(insights) {
  const groups = groupByField(insights, 'postingTimeBucket');
  const entries = Object.entries(groups).filter(([, rows]) => rows.length >= 3);
  if (entries.length < 2) return null;

  const scored = entries.map(([bucket, rows]) => ({
    bucket,
    avgScore: avg(rows.map((r) => r.performanceScore).filter((s) => s != null)),
    count: rows.length,
  }));
  scored.sort((a, b) => b.avgScore - a.avgScore);

  const gap = scored[0].avgScore - scored[1].avgScore;
  if (gap < 10) return null;

  const label = scored[0].bucket.charAt(0).toUpperCase() + scored[0].bucket.slice(1);
  return {
    type: 'best_posting_time',
    title: `${label} posts get the best results`,
    description: `Posts published in the ${scored[0].bucket} average ${Math.round(scored[0].avgScore)} points, ${Math.round(gap)} higher than other time slots.`,
    confidence: confidenceLevel(scored[0].count),
    supportingMetrics: { bestTimeBucket: scored[0].bucket, avgScore: Math.round(scored[0].avgScore), gap: Math.round(gap) },
  };
}

function lengthInsight(insights) {
  const groups = groupByField(insights, 'lengthBucket');
  const entries = Object.entries(groups).filter(([, rows]) => rows.length >= 3);
  if (entries.length < 2) return null;

  const scored = entries.map(([bucket, rows]) => ({
    bucket,
    avgScore: avg(rows.map((r) => r.performanceScore).filter((s) => s != null)),
    count: rows.length,
  }));
  scored.sort((a, b) => b.avgScore - a.avgScore);

  const gap = scored[0].avgScore - scored[1].avgScore;
  if (gap < 10) return null;

  const labels = { short: 'Short captions', medium: 'Medium-length captions', long: 'Long-form captions' };
  return {
    type: 'length_insight',
    title: `${labels[scored[0].bucket] || scored[0].bucket} work best for you`,
    description: `${labels[scored[0].bucket] || scored[0].bucket} average ${Math.round(scored[0].avgScore)} points, beating other lengths by ${Math.round(gap)} points.`,
    confidence: confidenceLevel(scored[0].count),
    supportingMetrics: { bestLengthBucket: scored[0].bucket, avgScore: Math.round(scored[0].avgScore), gap: Math.round(gap) },
  };
}

function consistencyInsight(insights) {
  // Group by ISO week
  const weekMap = {};
  for (const row of insights) {
    if (!row.publishedAt) continue;
    const d = new Date(row.publishedAt);
    const weekStart = new Date(d);
    weekStart.setDate(d.getDate() - d.getDay());
    const key = weekStart.toISOString().slice(0, 10);
    if (!weekMap[key]) weekMap[key] = { count: 0, scores: [] };
    weekMap[key].count++;
    if (row.performanceScore != null) weekMap[key].scores.push(row.performanceScore);
  }

  const weeks = Object.values(weekMap);
  if (weeks.length < 3) return null;

  const counts = weeks.map((w) => w.count);
  const mean = avg(counts);
  if (mean === 0) return null;

  const variance = avg(counts.map((c) => (c - mean) ** 2));
  const cv = Math.sqrt(variance) / mean;

  if (cv <= 0.5) return null;

  // Find the posting frequency of best-performing weeks
  const weekEntries = weeks.filter((w) => w.scores.length > 0);
  weekEntries.sort((a, b) => avg(b.scores) - avg(a.scores));
  const topWeeks = weekEntries.slice(0, Math.max(1, Math.floor(weekEntries.length / 3)));
  const bestFreq = Math.round(avg(topWeeks.map((w) => w.count)));

  return {
    type: 'consistency_insight',
    title: `Your best weeks have ${bestFreq}+ posts`,
    description: `Weeks where you post ${bestFreq} or more times tend to perform better. Consistency matters.`,
    confidence: 'medium',
    supportingMetrics: { bestWeeklyFrequency: bestFreq, coefficientOfVariation: Math.round(cv * 100) / 100 },
  };
}

// ── Data-Aware Generators ─────────────────────────────────────────────

async function bestDataTypeInsight(clientId) {
  const sources = await prisma.generatedContentSource.findMany({
    where: {
      draft: { clientId, status: 'PUBLISHED' },
    },
    select: {
      dataItem: { select: { type: true } },
      draft: {
        select: {
          postInsight: { select: { performanceScore: true } },
        },
      },
    },
  });

  const groups = {};
  for (const s of sources) {
    const type = s.dataItem.type;
    const score = s.draft.postInsight?.performanceScore;
    if (score == null) continue;
    if (!groups[type]) groups[type] = [];
    groups[type].push(score);
  }

  const entries = Object.entries(groups).filter(([, scores]) => scores.length >= 3);
  if (entries.length < 2) return null;

  const scored = entries.map(([type, scores]) => ({
    type,
    avgScore: avg(scores),
    count: scores.length,
  }));
  scored.sort((a, b) => b.avgScore - a.avgScore);

  const gap = scored[0].avgScore - scored[1].avgScore;
  if (gap < 5) return null;

  const label = scored[0].type.charAt(0) + scored[0].type.slice(1).toLowerCase().replace(/_/g, ' ');
  return {
    type: 'best_data_type',
    title: `${label}-based posts outperform other data types`,
    description: `Posts generated from ${label.toLowerCase()} data average ${Math.round(scored[0].avgScore)} points, ${Math.round(gap)} points higher than your next best data type.`,
    confidence: confidenceLevel(scored[0].count),
    supportingMetrics: { bestDataType: scored[0].type, avgScore: Math.round(scored[0].avgScore), gap: Math.round(gap) },
  };
}

async function bestBlueprintInsight(clientId) {
  const sources = await prisma.generatedContentSource.findMany({
    where: {
      draft: { clientId, status: 'PUBLISHED' },
    },
    select: {
      blueprint: { select: { name: true, slug: true } },
      draft: {
        select: {
          postInsight: { select: { performanceScore: true } },
        },
      },
    },
  });

  const groups = {};
  for (const s of sources) {
    const key = s.blueprint.slug;
    const score = s.draft.postInsight?.performanceScore;
    if (score == null) continue;
    if (!groups[key]) groups[key] = { name: s.blueprint.name, scores: [] };
    groups[key].scores.push(score);
  }

  const entries = Object.entries(groups).filter(([, g]) => g.scores.length >= 3);
  if (entries.length < 2) return null;

  const scored = entries.map(([slug, g]) => ({
    slug,
    name: g.name,
    avgScore: avg(g.scores),
    count: g.scores.length,
  }));
  scored.sort((a, b) => b.avgScore - a.avgScore);

  // Compare to overall average instead of second best
  const allScores = scored.flatMap((s) => Array(s.count).fill(s.avgScore));
  const overallAvg = avg(allScores);
  const pctAbove = overallAvg > 0 ? Math.round(((scored[0].avgScore - overallAvg) / overallAvg) * 100) : 0;
  if (pctAbove < 10) return null;

  return {
    type: 'best_blueprint',
    title: `${scored[0].name} posts consistently perform above average`,
    description: `${scored[0].name} posts score ${pctAbove}% above your average, making it your most effective content angle.`,
    confidence: confidenceLevel(scored[0].count),
    supportingMetrics: { bestBlueprint: scored[0].slug, avgScore: Math.round(scored[0].avgScore), pctAboveAverage: pctAbove },
  };
}

async function staleHighPerformerInsight(clientId) {
  const fourteenDaysAgo = new Date();
  fourteenDaysAgo.setDate(fourteenDaysAgo.getDate() - 14);

  const items = await prisma.workspaceDataItem.findMany({
    where: {
      clientId,
      status: 'ACTIVE',
      performance: { avgEngagement: { gt: 3 } },
      OR: [
        { lastUsedAt: { lt: fourteenDaysAgo } },
        { lastUsedAt: null },
      ],
    },
    include: { performance: true },
    take: 5,
  });

  if (items.length === 0) return null;

  const top = items[0];
  const daysSince = top.lastUsedAt
    ? Math.floor((Date.now() - new Date(top.lastUsedAt).getTime()) / (1000 * 60 * 60 * 24))
    : null;

  return {
    type: 'stale_high_performer',
    title: daysSince
      ? `'${top.title}' hasn't been used in ${daysSince}+ days`
      : `'${top.title}' is a high performer that's never been used`,
    description: `This data item has strong engagement (avg ${top.performance?.avgEngagement?.toFixed(1) ?? '?'}%) but hasn't been leveraged recently. Consider generating fresh content from it.`,
    confidence: 'medium',
    supportingMetrics: {
      dataItemId: top.id,
      avgEngagement: top.performance?.avgEngagement,
      daysSinceUse: daysSince,
      staleCount: items.length,
    },
  };
}

async function channelDataTypeInsight(clientId) {
  const sources = await prisma.generatedContentSource.findMany({
    where: {
      draft: { clientId, status: 'PUBLISHED' },
    },
    select: {
      dataItem: { select: { type: true } },
      draft: {
        select: {
          channel: true,
          normalizedMetric: { select: { engagementRate: true } },
        },
      },
    },
  });

  // Cross-tab: dataType × channel
  const crossTab = {};
  for (const s of sources) {
    const type = s.dataItem.type;
    const ch = s.draft.channel;
    const rate = s.draft.normalizedMetric?.engagementRate;
    if (rate == null || !ch) continue;
    const key = `${type}|${ch}`;
    if (!crossTab[key]) crossTab[key] = { type, channel: ch, rates: [] };
    crossTab[key].rates.push(rate);
  }

  const entries = Object.values(crossTab).filter((e) => e.rates.length >= 3);
  if (entries.length < 2) return null;

  const scored = entries.map((e) => ({
    ...e,
    avgRate: e.rates.reduce((a, b) => a + b, 0) / e.rates.length,
  }));
  scored.sort((a, b) => b.avgRate - a.avgRate);

  const best = scored[0];
  const label = best.type.charAt(0) + best.type.slice(1).toLowerCase().replace(/_/g, ' ');

  return {
    type: 'channel_data_type_match',
    title: `${label} content works best on ${best.channel}`,
    description: `${label} posts on ${best.channel} average ${(best.avgRate * 100).toFixed(1)}% engagement — your strongest data type × channel combination.`,
    confidence: confidenceLevel(best.rates.length),
    supportingMetrics: {
      dataType: best.type,
      channel: best.channel,
      avgEngagementRate: Math.round(best.avgRate * 10000) / 100,
      postCount: best.rates.length,
    },
  };
}

async function underutilizedDataInsight(clientId) {
  const unused = await prisma.workspaceDataItem.findMany({
    where: { clientId, status: 'ACTIVE', usageCount: 0 },
    select: { id: true, title: true, priority: true, expiresAt: true },
    orderBy: { priority: 'desc' },
  });

  if (unused.length === 0) return null;

  const expiring = unused.filter((i) => {
    if (!i.expiresAt) return false;
    const daysLeft = (new Date(i.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    return daysLeft > 0 && daysLeft <= 14;
  });

  const highPriority = unused.filter((i) => i.priority >= 7);

  let description = `You have ${unused.length} data item${unused.length === 1 ? '' : 's'} that ${unused.length === 1 ? 'has' : 'have'} never been used to generate content.`;
  if (expiring.length > 0) {
    description += ` ${expiring.length} ${expiring.length === 1 ? 'is' : 'are'} expiring soon.`;
  }
  if (highPriority.length > 0) {
    description += ` ${highPriority.length} ${highPriority.length === 1 ? 'is' : 'are'} high priority.`;
  }

  return {
    type: 'underutilized_data',
    title: `${unused.length} data item${unused.length === 1 ? '' : 's'} ${unused.length === 1 ? 'has' : 'have'} never been used`,
    description,
    confidence: 'high',
    supportingMetrics: {
      unusedCount: unused.length,
      expiringCount: expiring.length,
      highPriorityCount: highPriority.length,
    },
  };
}

// ── Main ─────────────────────────────────────────────────────────────

export async function generateInsights({ clientId, range = '30d' }) {
  const since = getRangeDate(range);
  const dateFilter = since ? { publishedAt: { gte: since } } : {};

  const insights = await prisma.postInsight.findMany({
    where: { clientId, draft: { status: 'PUBLISHED', ...dateFilter } },
    select: {
      performanceScore: true,
      contentType: true,
      hookType: true,
      mediaType: true,
      lengthBucket: true,
      postingTimeBucket: true,
      draft: { select: { channel: true, publishedAt: true } },
    },
  });

  // Flatten channel + publishedAt into each row for grouping convenience
  const rows = insights.map((i) => ({
    ...i,
    channel: i.draft?.channel,
    publishedAt: i.draft?.publishedAt,
  }));

  const generators = [
    bestPlatformInsight,
    bestMediaTypeInsight,
    bestContentTypeInsight,
    bestPostingTimeInsight,
    lengthInsight,
    consistencyInsight,
  ];

  const results = generators.map((gen) => gen(rows)).filter(Boolean);

  // Data-aware insights (async — require DB queries)
  const [dataTypeInsight, blueprintInsight, staleInsight, channelDataInsight, underutilizedInsight] = await Promise.all([
    bestDataTypeInsight(clientId).catch(() => null),
    bestBlueprintInsight(clientId).catch(() => null),
    staleHighPerformerInsight(clientId).catch(() => null),
    channelDataTypeInsight(clientId).catch(() => null),
    underutilizedDataInsight(clientId).catch(() => null),
  ]);
  if (dataTypeInsight) results.push(dataTypeInsight);
  if (blueprintInsight) results.push(blueprintInsight);
  if (staleInsight) results.push(staleInsight);
  if (channelDataInsight) results.push(channelDataInsight);
  if (underutilizedInsight) results.push(underutilizedInsight);

  // Drop low confidence, sort high first then by gap magnitude
  const filtered = results
    .filter((i) => i.confidence !== 'low')
    .sort((a, b) => {
      const confOrder = { high: 0, medium: 1 };
      const confDiff = (confOrder[a.confidence] ?? 2) - (confOrder[b.confidence] ?? 2);
      if (confDiff !== 0) return confDiff;
      return (b.supportingMetrics?.gap ?? 0) - (a.supportingMetrics?.gap ?? 0);
    });

  return filtered.slice(0, 8);
}

// ── Range helper (duplicated from overview for independence) ─────────

function getRangeDate(range) {
  if (range === 'all') return null;
  const days = { '7d': 7, '30d': 30, '90d': 90 };
  const d = new Date();
  d.setDate(d.getDate() - (days[range] || 30));
  return d;
}
