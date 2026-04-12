import { prisma } from '../../prisma.js';

// ── Helpers ──────────────────────────────────────────────────────────

function avg(arr) {
  return arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
}

function groupByField(rows, field) {
  const groups = {};
  for (const row of rows) {
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

function contentRecommendation(rows) {
  const groups = groupByField(rows, 'contentType');
  const entries = Object.entries(groups).filter(([, r]) => r.length >= 3);
  if (entries.length < 2) return null;

  const scored = entries.map(([type, r]) => ({
    type,
    avgScore: avg(r.map((x) => x.performanceScore).filter(Boolean)),
    count: r.length,
  }));
  scored.sort((a, b) => b.avgScore - a.avgScore);

  const best = scored[0];
  if (best.avgScore - (scored[1]?.avgScore ?? 0) < 5) return null;

  const label = best.type.charAt(0).toUpperCase() + best.type.slice(1);
  return {
    title: `Create more ${best.type} posts`,
    reason: `Your ${best.type} posts average ${Math.round(best.avgScore)} points — higher than other types.`,
    suggestedAction: `Try writing 3 ${best.type} posts this week`,
    confidence: confidenceLevel(best.count),
    category: 'content',
  };
}

function platformRecommendation(rows) {
  const groups = groupByField(rows, 'channel');
  const entries = Object.entries(groups).filter(([, r]) => r.length >= 3);
  if (entries.length < 2) return null;

  const scored = entries.map(([channel, r]) => ({
    channel,
    avgScore: avg(r.map((x) => x.performanceScore).filter(Boolean)),
    count: r.length,
  }));
  scored.sort((a, b) => b.avgScore - a.avgScore);

  const best = scored[0];
  if (best.avgScore - (scored[1]?.avgScore ?? 0) < 5) return null;

  return {
    title: `Double down on ${best.channel}`,
    reason: `${best.channel} posts average ${Math.round(best.avgScore)} points — your strongest platform.`,
    suggestedAction: `Schedule 2 more ${best.channel} posts next week`,
    confidence: confidenceLevel(best.count),
    category: 'platform',
  };
}

function mediaRecommendation(rows) {
  const groups = groupByField(rows, 'mediaType');
  const entries = Object.entries(groups).filter(([, r]) => r.length >= 3);
  if (entries.length < 2) return null;

  const scored = entries.map(([mediaType, r]) => ({
    mediaType,
    avgScore: avg(r.map((x) => x.performanceScore).filter(Boolean)),
    count: r.length,
  }));
  scored.sort((a, b) => b.avgScore - a.avgScore);

  const best = scored[0];
  if (best.avgScore - (scored[1]?.avgScore ?? 0) < 5) return null;

  const label = best.mediaType === 'video' ? 'video' : best.mediaType === 'image' ? 'image' : best.mediaType;
  return {
    title: `Add more ${label} content`,
    reason: `Posts with ${label} average ${Math.round(best.avgScore)} points, outperforming other formats.`,
    suggestedAction: `Create a short ${label} for your next post`,
    confidence: confidenceLevel(best.count),
    category: 'media',
  };
}

function timingRecommendation(rows) {
  const groups = groupByField(rows, 'postingTimeBucket');
  const entries = Object.entries(groups).filter(([, r]) => r.length >= 3);
  if (entries.length < 2) return null;

  const scored = entries.map(([bucket, r]) => ({
    bucket,
    avgScore: avg(r.map((x) => x.performanceScore).filter(Boolean)),
    count: r.length,
  }));
  scored.sort((a, b) => b.avgScore - a.avgScore);

  const best = scored[0];
  if (best.avgScore - (scored[1]?.avgScore ?? 0) < 5) return null;

  const timeHints = { morning: 'before 9am', midday: 'between 9am and noon', afternoon: 'between noon and 5pm', evening: 'between 5pm and 9pm', night: 'after 9pm' };
  return {
    title: `Schedule posts for the ${best.bucket}`,
    reason: `${best.bucket.charAt(0).toUpperCase() + best.bucket.slice(1)} posts average ${Math.round(best.avgScore)} points.`,
    suggestedAction: `Try scheduling your next 3 posts ${timeHints[best.bucket] || 'at that time'}`,
    confidence: confidenceLevel(best.count),
    category: 'timing',
  };
}

function cadenceRecommendation(rows) {
  // Group by ISO week
  const weekMap = {};
  for (const row of rows) {
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

  const avgPostsPerWeek = avg(weeks.map((w) => w.count));
  if (avgPostsPerWeek >= 3) return null;

  return {
    title: 'Increase your posting frequency',
    reason: `You average ${Math.round(avgPostsPerWeek * 10) / 10} posts per week. More consistent posting improves reach.`,
    suggestedAction: 'Aim for 3 posts per week minimum',
    confidence: 'medium',
    category: 'cadence',
  };
}

function hooksRecommendation(rows) {
  const groups = groupByField(rows, 'hookType');
  const entries = Object.entries(groups).filter(([, r]) => r.length >= 3);
  if (entries.length < 2) return null;

  const scored = entries.map(([hookType, r]) => ({
    hookType,
    avgScore: avg(r.map((x) => x.performanceScore).filter(Boolean)),
    count: r.length,
  }));
  scored.sort((a, b) => b.avgScore - a.avgScore);

  const best = scored[0];
  if (best.hookType === 'statement') return null; // don't recommend "use more statements"
  if (best.avgScore - (scored[scored.length - 1]?.avgScore ?? 0) < 5) return null;

  const hookLabels = { question: 'a question', 'how-to': 'a how-to', list: 'a numbered list', controversial: 'a bold take', urgency: 'urgency', inspirational: 'inspiration', direct_offer: 'a direct offer' };
  return {
    title: `Start more posts with ${hookLabels[best.hookType] || best.hookType}`,
    reason: `Posts with ${best.hookType} hooks average ${Math.round(best.avgScore)} points.`,
    suggestedAction: `Try ${hookLabels[best.hookType] || best.hookType} hook on your next post`,
    confidence: confidenceLevel(best.count),
    category: 'hooks',
  };
}

// ── Data-Aware Generators (async) ────────────────────────────────────

async function autopilotRecommendation(clientId) {
  const unusedCount = await prisma.workspaceDataItem.count({
    where: { clientId, status: 'ACTIVE', usageCount: 0 },
  });

  if (unusedCount < 3) return null;

  return {
    title: 'Run Autopilot to generate content from unused data',
    reason: `You have ${unusedCount} data items that haven't been used yet. Autopilot can batch-generate optimized content from them.`,
    suggestedAction: 'Open Autopilot from the Business Data page',
    confidence: 'high',
    category: 'autopilot',
  };
}

async function dataFreshnessRecommendation(clientId) {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const total = await prisma.workspaceDataItem.count({
    where: { clientId, status: 'ACTIVE' },
  });

  if (total === 0) return null;

  const old = await prisma.workspaceDataItem.count({
    where: { clientId, status: 'ACTIVE', createdAt: { lt: thirtyDaysAgo } },
  });

  const pct = old / total;
  if (pct < 0.7) return null;

  return {
    title: 'Add fresh business data',
    reason: `${Math.round(pct * 100)}% of your data items are over 30 days old. Fresh data leads to more relevant content.`,
    suggestedAction: 'Add new testimonials, stats, or milestones',
    confidence: 'medium',
    category: 'data_freshness',
  };
}

// ── Main ─────────────────────────────────────────────────────────────

export async function generateRecommendations({ clientId, range = '30d' }) {
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

  // If < 10 total posts, not enough data
  if (insights.length < 10) {
    return { recommendations: [], meta: { message: 'Not enough data yet — keep posting and check back.' } };
  }

  const rows = insights.map((i) => ({
    ...i,
    channel: i.draft?.channel,
    publishedAt: i.draft?.publishedAt,
  }));

  const generators = [
    contentRecommendation,
    platformRecommendation,
    mediaRecommendation,
    timingRecommendation,
    cadenceRecommendation,
    hooksRecommendation,
  ];

  const results = generators.map((gen) => gen(rows)).filter(Boolean);

  // Async data-aware recommendations
  const [autopilotRec, freshnessRec] = await Promise.all([
    autopilotRecommendation(clientId).catch(() => null),
    dataFreshnessRecommendation(clientId).catch(() => null),
  ]);
  if (autopilotRec) results.push(autopilotRec);
  if (freshnessRec) results.push(freshnessRec);

  // Drop low confidence, max 1 per category, cap at 5
  const seen = new Set();
  const filtered = results
    .filter((r) => r.confidence !== 'low')
    .filter((r) => {
      if (seen.has(r.category)) return false;
      seen.add(r.category);
      return true;
    });

  return { recommendations: filtered.slice(0, 5) };
}

// ── Range helper ─────────────────────────────────────────────────────

function getRangeDate(range) {
  if (range === 'all') return null;
  const days = { '7d': 7, '30d': 30, '90d': 90 };
  const d = new Date();
  d.setDate(d.getDate() - (days[range] || 30));
  return d;
}
