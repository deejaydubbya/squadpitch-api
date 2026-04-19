// Data analytics service — performance tracking for data items and blueprints.
//
// Closes the feedback loop: Business Data -> Generate -> Publish -> Analytics -> Better Generation.
// Called fire-and-forget from publishingService (on publish) and metricsSyncService (on sync).

import { prisma } from "../../prisma.js";

// ── Data Item Performance ────────────────────────────────────────────

export async function updateDataItemPerformance(dataItemId) {
  const sources = await prisma.generatedContentSource.findMany({
    where: { dataItemId },
    select: {
      draft: {
        select: {
          id: true,
          status: true,
          postInsight: { select: { qualityScore: true, observedScore: true, compositeScore: true } },
          normalizedMetric: { select: { engagementRate: true } },
        },
      },
    },
  });

  const totalDrafts = sources.length;
  const published = sources.filter((s) => s.draft.status === "PUBLISHED");
  const totalPublished = published.length;

  const qScores = published.map((s) => s.draft.postInsight?.qualityScore).filter((s) => s != null);
  const oScores = published.map((s) => s.draft.postInsight?.observedScore).filter((s) => s != null);
  const cScores = published.map((s) => s.draft.postInsight?.compositeScore).filter((s) => s != null);
  const engagements = published
    .map((s) => s.draft.normalizedMetric?.engagementRate)
    .filter((e) => e != null);

  const avg = (arr) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  await prisma.dataItemPerformance.upsert({
    where: { dataItemId },
    create: {
      dataItemId,
      totalDrafts,
      totalPublished,
      avgEngagement: avg(engagements),
      avgQualityScore: avg(qScores),
      avgObservedScore: avg(oScores),
      avgCompositeScore: avg(cScores),
      lastCalculated: new Date(),
    },
    update: {
      totalDrafts,
      totalPublished,
      avgEngagement: avg(engagements),
      avgQualityScore: avg(qScores),
      avgObservedScore: avg(oScores),
      avgCompositeScore: avg(cScores),
      lastCalculated: new Date(),
    },
  });
}

// ── Blueprint Performance ────────────────────────────────────────────

export async function updateBlueprintPerformance(blueprintId) {
  const sources = await prisma.generatedContentSource.findMany({
    where: { blueprintId },
    select: {
      draft: {
        select: {
          id: true,
          status: true,
          postInsight: { select: { qualityScore: true, observedScore: true, compositeScore: true } },
          normalizedMetric: { select: { engagementRate: true } },
        },
      },
    },
  });

  const totalDrafts = sources.length;
  const published = sources.filter((s) => s.draft.status === "PUBLISHED");
  const totalPublished = published.length;

  const qScores = published.map((s) => s.draft.postInsight?.qualityScore).filter((s) => s != null);
  const oScores = published.map((s) => s.draft.postInsight?.observedScore).filter((s) => s != null);
  const cScores = published.map((s) => s.draft.postInsight?.compositeScore).filter((s) => s != null);
  const engagements = published
    .map((s) => s.draft.normalizedMetric?.engagementRate)
    .filter((e) => e != null);

  const avg = (arr) => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

  await prisma.blueprintPerformance.upsert({
    where: { blueprintId },
    create: {
      blueprintId,
      totalDrafts,
      totalPublished,
      avgEngagement: avg(engagements),
      avgQualityScore: avg(qScores),
      avgObservedScore: avg(oScores),
      avgCompositeScore: avg(cScores),
      lastCalculated: new Date(),
    },
    update: {
      totalDrafts,
      totalPublished,
      avgEngagement: avg(engagements),
      avgQualityScore: avg(qScores),
      avgObservedScore: avg(oScores),
      avgCompositeScore: avg(cScores),
      lastCalculated: new Date(),
    },
  });
}

// ── Draft-level Hook (single entry point) ────────────────────────────

export async function updatePerformanceForDraft(draftId) {
  const sources = await prisma.generatedContentSource.findMany({
    where: { draftId },
    select: { dataItemId: true, blueprintId: true },
  });

  if (sources.length === 0) return;

  const dataItemIds = [...new Set(sources.map((s) => s.dataItemId))];
  const blueprintIds = [...new Set(sources.map((s) => s.blueprintId))];

  await Promise.all([
    ...dataItemIds.map((id) => updateDataItemPerformance(id)),
    ...blueprintIds.map((id) => updateBlueprintPerformance(id)),
  ]);
}

// ── Queries ──────────────────────────────────────────────────────────

export async function getTopPerformingDataItems(clientId, { limit = 20 } = {}) {
  const items = await prisma.workspaceDataItem.findMany({
    where: { clientId, status: "ACTIVE", performance: { isNot: null } },
    include: { performance: true },
    orderBy: { performance: { avgEngagement: "desc" } },
    take: limit,
  });

  return items.map((item) => ({
    id: item.id,
    type: item.type,
    title: item.title,
    summary: item.summary,
    usageCount: item.usageCount,
    performance: item.performance
      ? {
          totalDrafts: item.performance.totalDrafts,
          totalPublished: item.performance.totalPublished,
          avgEngagement: item.performance.avgEngagement,
          avgQualityScore: item.performance.avgQualityScore,
          avgObservedScore: item.performance.avgObservedScore,
          avgCompositeScore: item.performance.avgCompositeScore,
          lastCalculated: item.performance.lastCalculated,
        }
      : null,
  }));
}

export async function getBestBlueprints(clientId, { limit = 10 } = {}) {
  // Find blueprints used by this client via GeneratedContentSource
  const sources = await prisma.generatedContentSource.findMany({
    where: { draft: { clientId } },
    select: { blueprintId: true },
    distinct: ["blueprintId"],
  });

  if (sources.length === 0) return [];

  const blueprintIds = sources.map((s) => s.blueprintId);

  const blueprints = await prisma.contentBlueprint.findMany({
    where: { id: { in: blueprintIds }, performance: { isNot: null } },
    include: { performance: true },
    orderBy: { performance: { avgEngagement: "desc" } },
    take: limit,
  });

  return blueprints.map((bp) => ({
    id: bp.id,
    slug: bp.slug,
    name: bp.name,
    category: bp.category,
    performance: bp.performance
      ? {
          totalDrafts: bp.performance.totalDrafts,
          totalPublished: bp.performance.totalPublished,
          avgEngagement: bp.performance.avgEngagement,
          avgQualityScore: bp.performance.avgQualityScore,
          avgObservedScore: bp.performance.avgObservedScore,
          avgCompositeScore: bp.performance.avgCompositeScore,
          lastCalculated: bp.performance.lastCalculated,
        }
      : null,
  }));
}

export async function getBestPlatformForDataType(clientId, dataType) {
  const sources = await prisma.generatedContentSource.findMany({
    where: {
      dataItem: { clientId, type: dataType },
      draft: { status: "PUBLISHED" },
    },
    select: {
      draft: {
        select: {
          channel: true,
          normalizedMetric: { select: { engagementRate: true } },
        },
      },
    },
  });

  const channelMap = {};
  for (const s of sources) {
    const ch = s.draft.channel;
    const rate = s.draft.normalizedMetric?.engagementRate;
    if (rate == null) continue;
    if (!channelMap[ch]) channelMap[ch] = [];
    channelMap[ch].push(rate);
  }

  const entries = Object.entries(channelMap).map(([channel, rates]) => ({
    channel,
    avgEngagement: rates.reduce((a, b) => a + b, 0) / rates.length,
    postCount: rates.length,
  }));

  if (entries.length === 0) return null;

  entries.sort((a, b) => b.avgEngagement - a.avgEngagement);
  return entries[0];
}

export async function getDataItemPerformanceSummary(dataItemId) {
  const perf = await prisma.dataItemPerformance.findUnique({
    where: { dataItemId },
  });
  if (!perf) return null;

  return {
    totalDrafts: perf.totalDrafts,
    totalPublished: perf.totalPublished,
    avgEngagement: perf.avgEngagement,
    avgQualityScore: perf.avgQualityScore,
    avgObservedScore: perf.avgObservedScore,
    avgCompositeScore: perf.avgCompositeScore,
    lastCalculated: perf.lastCalculated,
  };
}

export async function recalculateAllPerformance(clientId) {
  // Recalc all data items for this client
  const items = await prisma.workspaceDataItem.findMany({
    where: { clientId },
    select: { id: true },
  });
  for (const item of items) {
    await updateDataItemPerformance(item.id);
  }

  // Recalc all blueprints used by this client
  const sources = await prisma.generatedContentSource.findMany({
    where: { draft: { clientId } },
    select: { blueprintId: true },
    distinct: ["blueprintId"],
  });
  for (const s of sources) {
    await updateBlueprintPerformance(s.blueprintId);
  }

  return { recalculated: items.length + sources.length };
}

// ── Smart Blueprint Selection ────────────────────────────────────────

export async function getSmartBlueprintForItem(dataItemId, clientId, { channel } = {}) {
  const item = await prisma.workspaceDataItem.findUnique({
    where: { id: dataItemId },
    select: { type: true },
  });
  if (!item) return null;

  const bpWhere = { isActive: true, applicableTypes: { has: item.type } };
  if (channel) bpWhere.applicableChannels = { has: channel };

  const blueprints = await prisma.contentBlueprint.findMany({
    where: bpWhere,
    include: { performance: true },
  });

  if (blueprints.length === 0) return null;

  // Sort by performance (client-scoped engagement from GeneratedContentSource)
  // If no performance data, fall back to first applicable
  const withPerf = blueprints.filter((bp) => bp.performance?.avgEngagement != null);
  if (withPerf.length > 0) {
    withPerf.sort((a, b) => b.performance.avgEngagement - a.performance.avgEngagement);
    return withPerf[0];
  }

  return blueprints[0];
}
