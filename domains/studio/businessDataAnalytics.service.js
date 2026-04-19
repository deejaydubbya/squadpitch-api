import { prisma } from '../../prisma.js';

export async function getBusinessDataSection({ clientId }) {
  // All data items for this workspace
  const dataItems = await prisma.workspaceDataItem.findMany({
    where: { clientId, status: 'ACTIVE' },
    select: {
      id: true,
      type: true,
      title: true,
      usageCount: true,
      lastUsedAt: true,
      createdAt: true,
      performance: {
        select: {
          totalDrafts: true,
          totalPublished: true,
          avgEngagement: true,
          avgQualityScore: true,
          avgObservedScore: true,
          avgCompositeScore: true,
        },
      },
    },
  });

  if (dataItems.length === 0) {
    return {
      totalDataItems: 0,
      totalUsed: 0,
      totalUnused: 0,
      totalStale: 0,
      totalDraftsFromData: 0,
      totalPublishedFromData: 0,
      byType: [],
      byBlueprint: [],
      byFreshness: [],
      topItems: [],
      underusedItems: [],
      hasData: false,
    };
  }

  const now = Date.now();
  const STALE_DAYS = 30;

  // Volume stats
  const totalDataItems = dataItems.length;
  const totalUsed = dataItems.filter((d) => d.usageCount > 0).length;
  const totalUnused = dataItems.filter((d) => d.usageCount === 0).length;
  const totalStale = dataItems.filter((d) => {
    if (d.usageCount === 0) return false; // unused, not stale
    if (!d.lastUsedAt) return true;
    return (now - new Date(d.lastUsedAt).getTime()) / 86400000 > STALE_DAYS;
  }).length;

  const totalDraftsFromData = dataItems.reduce((sum, d) => sum + (d.performance?.totalDrafts ?? 0), 0);
  const totalPublishedFromData = dataItems.reduce((sum, d) => sum + (d.performance?.totalPublished ?? 0), 0);

  // By type
  const typeGroups = {};
  for (const item of dataItems) {
    const t = item.type;
    if (!typeGroups[t]) typeGroups[t] = { items: [], drafts: 0, published: 0, scores: [], engRates: [] };
    typeGroups[t].items.push(item);
    typeGroups[t].drafts += item.performance?.totalDrafts ?? 0;
    typeGroups[t].published += item.performance?.totalPublished ?? 0;
    if (item.performance?.avgCompositeScore != null) typeGroups[t].scores.push(item.performance.avgCompositeScore);
    if (item.performance?.avgEngagement != null) typeGroups[t].engRates.push(item.performance.avgEngagement);
  }

  const avg = (arr) => arr.length > 0
    ? Math.round((arr.reduce((a, b) => a + b, 0) / arr.length) * 10) / 10
    : null;

  const byType = Object.entries(typeGroups).map(([type, data]) => ({
    type,
    itemCount: data.items.length,
    totalDrafts: data.drafts,
    totalPublished: data.published,
    avgScore: avg(data.scores),
    avgEngagement: data.engRates.length > 0
      ? data.engRates.reduce((a, b) => a + b, 0) / data.engRates.length
      : null,
  })).sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0));

  // By blueprint — find blueprints used by this client
  const sources = await prisma.generatedContentSource.findMany({
    where: { draft: { clientId } },
    select: { blueprintId: true },
    distinct: ['blueprintId'],
  });

  const bpIds = sources.map((s) => s.blueprintId);
  let byBlueprint = [];

  if (bpIds.length > 0) {
    const blueprints = await prisma.contentBlueprint.findMany({
      where: { id: { in: bpIds } },
      select: {
        id: true,
        name: true,
        category: true,
        performance: {
          select: {
            totalDrafts: true,
            totalPublished: true,
            avgEngagement: true,
            avgCompositeScore: true,
          },
        },
      },
    });

    byBlueprint = blueprints
      .filter((bp) => bp.performance != null)
      .map((bp) => ({
        blueprintId: bp.id,
        blueprintName: bp.name,
        category: bp.category,
        totalDrafts: bp.performance.totalDrafts,
        totalPublished: bp.performance.totalPublished,
        avgScore: bp.performance.avgCompositeScore != null
          ? Math.round(bp.performance.avgCompositeScore * 10) / 10
          : null,
        avgEngagement: bp.performance.avgEngagement,
      }))
      .sort((a, b) => (b.avgScore ?? 0) - (a.avgScore ?? 0))
      .slice(0, 10);
  }

  // By freshness — bucket data items by age and correlate performance
  const freshnessBuckets = { recent: [], moderate: [], aged: [] };
  for (const item of dataItems) {
    if (!item.performance || item.performance.totalPublished === 0) continue;
    const ageDays = (now - new Date(item.createdAt).getTime()) / 86400000;
    if (ageDays < 7) freshnessBuckets.recent.push(item);
    else if (ageDays < 30) freshnessBuckets.moderate.push(item);
    else freshnessBuckets.aged.push(item);
  }

  const byFreshness = [
    { bucket: '< 7 days', label: 'Fresh', itemCount: freshnessBuckets.recent.length },
    { bucket: '7-30 days', label: 'Moderate', itemCount: freshnessBuckets.moderate.length },
    { bucket: '30+ days', label: 'Aged', itemCount: freshnessBuckets.aged.length },
  ].map((b) => {
    const items = freshnessBuckets[b.bucket === '< 7 days' ? 'recent' : b.bucket === '7-30 days' ? 'moderate' : 'aged'];
    const scores = items.map((i) => i.performance?.avgCompositeScore).filter((s) => s != null);
    return {
      ...b,
      avgScore: avg(scores),
    };
  });

  // Top items by performance
  const topItems = dataItems
    .filter((d) => d.performance?.avgCompositeScore != null && d.performance.totalPublished > 0)
    .sort((a, b) => (b.performance.avgCompositeScore ?? 0) - (a.performance.avgCompositeScore ?? 0))
    .slice(0, 5)
    .map((d) => ({
      id: d.id,
      title: d.title,
      type: d.type,
      usageCount: d.usageCount,
      totalPublished: d.performance.totalPublished,
      avgScore: d.performance.avgCompositeScore != null
        ? Math.round(d.performance.avgCompositeScore * 10) / 10
        : null,
      avgEngagement: d.performance.avgEngagement,
    }));

  // Underused — have data but never used or rarely used
  const underusedItems = dataItems
    .filter((d) => d.usageCount === 0)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .slice(0, 5)
    .map((d) => ({
      id: d.id,
      title: d.title,
      type: d.type,
      usageCount: d.usageCount,
      daysSinceCreation: Math.floor((now - new Date(d.createdAt).getTime()) / 86400000),
    }));

  return {
    totalDataItems,
    totalUsed,
    totalUnused,
    totalStale,
    totalDraftsFromData,
    totalPublishedFromData,
    byType,
    byBlueprint,
    byFreshness,
    topItems,
    underusedItems,
    hasData: true,
  };
}
