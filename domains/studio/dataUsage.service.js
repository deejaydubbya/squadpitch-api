// Data usage detection service (Phase 4).
//
// Identifies unused business data items and provides actionable
// suggestions to help users get more value from their data.

import { prisma } from "../../prisma.js";
import { getIndustryProfile } from "../industry/registry.js";

const ALL_DATA_TYPES = [
  "TESTIMONIAL",
  "CASE_STUDY",
  "PRODUCT_LAUNCH",
  "PROMOTION",
  "STATISTIC",
  "MILESTONE",
  "FAQ",
  "TEAM_SPOTLIGHT",
  "INDUSTRY_NEWS",
  "EVENT",
  "CUSTOM",
];

/**
 * Returns unused data items (usageCount = 0) for a client.
 */
export async function getUnusedData(clientId, { limit = 50 } = {}) {
  const items = await prisma.workspaceDataItem.findMany({
    where: { clientId, status: "ACTIVE", usageCount: 0 },
    orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
    take: limit,
    include: { performance: true },
  });

  return {
    unusedCount: items.length,
    items: items.map(formatItem),
  };
}

/**
 * Returns data-specific suggestions for the Business Data manager.
 *
 * Categories:
 *   - unused_data   → items with usageCount = 0
 *   - missing_types → data types with no items
 *   - stale_data    → items not used in 30+ days
 *   - new_data      → items added in last 7 days with no content
 */
export async function getDataSuggestions(clientId, { industryKey } = {}) {
  // Resolve industry-aware labels
  const isRE = industryKey === "real_estate";
  const labelMap = { ...TYPE_LABEL_MAP };
  const itemLabel = isRE ? "content assets" : "business data";
  const itemsLabel = isRE ? "unused listings" : "unused data items";
  if (isRE) {
    labelMap.PRODUCT_LAUNCH = "New Listings";
    labelMap.CUSTOM = "Listings";
  }

  const [
    typeGroups,
    unusedCount,
    staleItems,
    recentUnused,
    totalActive,
  ] = await Promise.all([
    // Count by type
    prisma.workspaceDataItem.groupBy({
      by: ["type"],
      where: { clientId, status: "ACTIVE" },
      _count: { _all: true },
    }),

    // Unused items
    prisma.workspaceDataItem.count({
      where: { clientId, status: "ACTIVE", usageCount: 0 },
    }),

    // Stale: used before but not in 30+ days
    prisma.workspaceDataItem.count({
      where: {
        clientId,
        status: "ACTIVE",
        usageCount: { gt: 0 },
        lastUsedAt: { lt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      },
    }),

    // New + unused: added in last 7 days, never used
    prisma.workspaceDataItem.count({
      where: {
        clientId,
        status: "ACTIVE",
        usageCount: 0,
        createdAt: { gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) },
      },
    }),

    // Total active count
    prisma.workspaceDataItem.count({
      where: { clientId, status: "ACTIVE" },
    }),
  ]);

  // Build type coverage map
  const existingTypes = new Set(typeGroups.map((g) => g.type));
  const missingTypes = ALL_DATA_TYPES.filter((t) => !existingTypes.has(t));

  // Only suggest important missing types (not all 11)
  const IMPORTANT_TYPES = [
    "TESTIMONIAL",
    "CASE_STUDY",
    "STATISTIC",
    "FAQ",
    "PRODUCT_LAUNCH",
  ];
  const missingImportant = missingTypes.filter((t) =>
    IMPORTANT_TYPES.includes(t)
  );

  const suggestions = [];

  // 1. Unused data
  if (unusedCount > 0) {
    suggestions.push({
      id: "unused_data",
      type: "unused_data",
      title: `${unusedCount} ${itemsLabel}`,
      description:
        `Generate content from your ${itemLabel} to maximize its value.`,
      action: "generate_from_unused",
      priority: 90,
    });
  }

  // 2. New data ready to use
  if (recentUnused > 0) {
    suggestions.push({
      id: "new_data_ready",
      type: "new_data",
      title: `${recentUnused} new item${recentUnused === 1 ? "" : "s"} ready for content`,
      description:
        "You recently added data that hasn't been used yet. Turn it into content while it's fresh.",
      action: "generate_from_new",
      priority: 85,
    });
  }

  // 3. Missing important types
  if (missingImportant.length > 0 && totalActive > 0) {
    const typeLabels = missingImportant
      .slice(0, 3)
      .map((t) => labelMap[t] || t)
      .join(", ");
    suggestions.push({
      id: "missing_types",
      type: "missing_types",
      title: `Add ${typeLabels}`,
      description: `Diversify your content by adding ${missingImportant.length} more data type${missingImportant.length === 1 ? "" : "s"}.`,
      action: "add_data",
      missingTypes: missingImportant,
      priority: 60,
    });
  }

  // 4. Stale data
  if (staleItems > 0) {
    suggestions.push({
      id: "stale_data",
      type: "stale_data",
      title: `${staleItems} item${staleItems === 1 ? "" : "s"} not used in 30+ days`,
      description:
        "Revisit older data items — they may generate fresh content from a new angle.",
      action: "generate_from_stale",
      priority: 50,
    });
  }

  // 5. No data at all
  if (totalActive === 0) {
    suggestions.push({
      id: "no_data",
      type: "no_data",
      title: `Add your first ${itemLabel}`,
      description:
        "Testimonials, stats, and case studies power smarter, data-driven content.",
      action: "add_data",
      priority: 95,
    });
  }

  suggestions.sort((a, b) => b.priority - a.priority);

  return {
    suggestions,
    coverage: {
      totalActive,
      unusedCount,
      staleCount: staleItems,
      missingTypes,
      typeBreakdown: Object.fromEntries(
        typeGroups.map((g) => [g.type, g._count._all])
      ),
    },
  };
}

function formatItem(item) {
  return {
    id: item.id,
    type: item.type,
    title: item.title,
    summary: item.summary,
    tags: item.tags,
    priority: item.priority,
    createdAt: item.createdAt.toISOString(),
  };
}

const TYPE_LABEL_MAP = {
  TESTIMONIAL: "Testimonials",
  CASE_STUDY: "Case Studies",
  PRODUCT_LAUNCH: "Product Launches",
  PROMOTION: "Promotions",
  STATISTIC: "Statistics",
  MILESTONE: "Milestones",
  FAQ: "FAQs",
  TEAM_SPOTLIGHT: "Team Spotlights",
  INDUSTRY_NEWS: "Industry News",
  EVENT: "Events",
  CUSTOM: "Custom",
};
