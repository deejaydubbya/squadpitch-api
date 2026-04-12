// Content opportunity scoring service.
//
// Cross-joins active data items × applicable blueprints, scores each
// pair deterministically, and returns the top N opportunities.
// Phase 2: scoring incorporates real analytics performance data.

import { prisma } from "../../prisma.js";

/**
 * Score a (dataItem, blueprint) pair on a 0-100 scale.
 *
 * Components:
 *   - Type compatibility    (25 pts) — does the blueprint list this item type?
 *   - Analytics performance (25 pts) — real engagement data from DataItemPerformance
 *   - Freshness             (15 pts) — newer items score higher
 *   - Usage staleness       (15 pts) — less-used items score higher
 *   - Priority              (10 pts) — item.priority 0-10 mapped to 0-10
 *   - Expiry urgency        (10 pts) — items closer to expiry get a boost
 */
function scoreOpportunity(item, blueprint, { performanceData, maxEngagement } = {}) {
  let score = 0;

  // Type compatibility (25 pts)
  if (blueprint.applicableTypes.includes(item.type)) {
    score += 25;
  }

  // Analytics performance (25 pts)
  if (performanceData?.avgEngagement != null && maxEngagement > 0) {
    score += (performanceData.avgEngagement / maxEngagement) * 25;
  } else {
    // No data — neutral score so unproven items aren't penalized
    score += 12;
  }

  // Freshness (15 pts) — items created in the last 7 days get full points
  const ageMs = Date.now() - new Date(item.createdAt).getTime();
  const ageDays = ageMs / (1000 * 60 * 60 * 24);
  score += Math.max(0, 15 - Math.floor(ageDays * (15 / 30)));

  // Usage staleness (15 pts) — items never used get full points
  if (item.usageCount === 0) {
    score += 15;
  } else {
    score += Math.max(0, 15 - item.usageCount * 3);
  }

  // Priority (10 pts)
  score += Math.min(10, item.priority);

  // Expiry urgency (10 pts)
  if (item.expiresAt) {
    const daysUntilExpiry =
      (new Date(item.expiresAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24);
    if (daysUntilExpiry > 0 && daysUntilExpiry <= 7) {
      score += 10;
    } else if (daysUntilExpiry > 7 && daysUntilExpiry <= 14) {
      score += 5;
    }
  }

  return score;
}

export async function getContentOpportunities(
  clientId,
  { limit = 20, channel, type } = {}
) {
  // Load active items
  const itemWhere = { clientId, status: "ACTIVE" };
  if (type) itemWhere.type = type;
  const items = await prisma.workspaceDataItem.findMany({
    where: itemWhere,
    orderBy: { createdAt: "desc" },
    take: 100,
  });

  // Load applicable blueprints
  const bpWhere = { isActive: true };
  if (channel) bpWhere.applicableChannels = { has: channel };
  const blueprints = await prisma.contentBlueprint.findMany({
    where: bpWhere,
  });

  // Batch-load performance data for all items
  const itemIds = items.map((i) => i.id);
  const perfRows = await prisma.dataItemPerformance.findMany({
    where: { dataItemId: { in: itemIds } },
  });
  const perfMap = {};
  for (const p of perfRows) {
    perfMap[p.dataItemId] = p;
  }

  // Find max engagement for normalization
  const maxEngagement = perfRows.reduce(
    (max, p) => (p.avgEngagement != null && p.avgEngagement > max ? p.avgEngagement : max),
    0
  );

  // Cross-join and score
  const opportunities = [];
  for (const item of items) {
    for (const bp of blueprints) {
      if (!bp.applicableTypes.includes(item.type)) continue;
      const score = scoreOpportunity(item, bp, {
        performanceData: perfMap[item.id] || null,
        maxEngagement,
      });
      opportunities.push({
        dataItem: {
          id: item.id,
          type: item.type,
          title: item.title,
          summary: item.summary,
          usageCount: item.usageCount,
          lastUsedAt: item.lastUsedAt,
        },
        blueprint: {
          id: bp.id,
          slug: bp.slug,
          name: bp.name,
          category: bp.category,
        },
        score,
      });
    }
  }

  // Sort by score descending, return top N
  opportunities.sort((a, b) => b.score - a.score);
  return opportunities.slice(0, limit);
}

export async function getOpportunitiesForItem(itemId, { channel } = {}) {
  const item = await prisma.workspaceDataItem.findUnique({
    where: { id: itemId },
  });
  if (!item) return [];

  const bpWhere = { isActive: true, applicableTypes: { has: item.type } };
  if (channel) bpWhere.applicableChannels = { has: channel };

  const blueprints = await prisma.contentBlueprint.findMany({
    where: bpWhere,
    orderBy: { name: "asc" },
  });

  // Load performance for this single item
  const perfData = await prisma.dataItemPerformance.findUnique({
    where: { dataItemId: itemId },
  });

  return blueprints.map((bp) => ({
    blueprint: {
      id: bp.id,
      slug: bp.slug,
      name: bp.name,
      category: bp.category,
      description: bp.description,
    },
    score: scoreOpportunity(item, bp, {
      performanceData: perfData,
      maxEngagement: perfData?.avgEngagement ?? 0,
    }),
  }));
}

// ── Smart Opportunities (diversity + spacing + exploration) ──────────

export async function getSmartOpportunities(
  clientId,
  { limit = 5, channel, excludeDataItemIds = [] } = {}
) {
  // 1. Over-fetch
  const raw = await getContentOpportunities(clientId, {
    limit: limit * 5,
    channel,
  });

  // 2. Filter out excluded items
  let pool = raw.filter(
    (opp) => !excludeDataItemIds.includes(opp.dataItem.id)
  );

  // 3. De-duplicate by dataItemId (keep highest-scoring pair per item)
  const bestByItem = new Map();
  for (const opp of pool) {
    const existing = bestByItem.get(opp.dataItem.id);
    if (!existing || opp.score > existing.score) {
      bestByItem.set(opp.dataItem.id, opp);
    }
  }
  pool = [...bestByItem.values()];

  // 4. Spacing penalty: items used in last 3 days get score × 0.5
  const threeDaysAgo = Date.now() - 3 * 24 * 60 * 60 * 1000;
  pool = pool.map((opp) => {
    const lastUsed = opp.dataItem.lastUsedAt
      ? new Date(opp.dataItem.lastUsedAt).getTime()
      : 0;
    const adjustedScore =
      lastUsed > threeDaysAgo ? opp.score * 0.5 : opp.score;
    return { ...opp, adjustedScore };
  });

  // Sort by adjusted score
  pool.sort((a, b) => b.adjustedScore - a.adjustedScore);

  // 5. Exploration: reserve ~20% of slots for untested items (usageCount === 0)
  const explorationSlots = Math.max(1, Math.floor(limit * 0.2));
  const mainSlots = limit - explorationSlots;

  const untested = pool.filter((o) => o.dataItem.usageCount === 0);
  const tested = pool.filter((o) => o.dataItem.usageCount > 0);

  // 6. Diversity cap: max 2 items per DataItemType
  function applyDiversityCap(items, maxSlots) {
    const typeCounts = {};
    const result = [];
    const overflow = [];
    for (const opp of items) {
      const t = opp.dataItem.type;
      typeCounts[t] = (typeCounts[t] || 0) + 1;
      if (typeCounts[t] <= 2 && result.length < maxSlots) {
        result.push(opp);
      } else {
        overflow.push(opp);
      }
    }
    return { result, overflow };
  }

  const { result: mainResult, overflow: mainOverflow } = applyDiversityCap(
    tested,
    mainSlots
  );
  const { result: explorationResult, overflow: explorationOverflow } =
    applyDiversityCap(untested, explorationSlots);

  let final = [...mainResult, ...explorationResult];

  // 7. Backfill remaining slots from overflow
  if (final.length < limit) {
    const backfill = [...explorationOverflow, ...mainOverflow];
    backfill.sort((a, b) => b.adjustedScore - a.adjustedScore);
    final = final.concat(backfill.slice(0, limit - final.length));
  }

  // Re-sort final list by adjusted score
  final.sort((a, b) => b.adjustedScore - a.adjustedScore);

  return final.slice(0, limit);
}
