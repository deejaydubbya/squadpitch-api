// Dashboard recommendation + action engine.
// Reuses existing services; does NOT duplicate logic.

import { prisma } from "../../prisma.js";

const DAY_MS = 24 * 60 * 60 * 1000;

// ── Recommendations ─────────────────────────────────────────────────────

/**
 * Returns AI-driven dashboard recommendations based on
 * business data, posting activity, analytics, and integrations.
 */
export async function getDashboardRecommendations(clientId) {
  // Week boundaries (Mon-Sun)
  const now = new Date();
  const dayOfWeek = now.getUTCDay(); // 0=Sun
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date(now);
  weekStart.setUTCDate(now.getUTCDate() - mondayOffset);
  weekStart.setUTCHours(0, 0, 0, 0);

  const [
    dataItemStats,
    draftStats,
    channelSettings,
    recentPublished,
    publishedThisWeek,
    scheduledUpcoming,
    lastAutopilotDraft,
  ] = await Promise.all([
    // Business data summary
    prisma.workspaceDataItem.groupBy({
      by: ["type"],
      where: { clientId, status: "ACTIVE" },
      _count: { _all: true },
    }),
    // Draft status counts
    prisma.draft.groupBy({
      by: ["status"],
      where: { clientId },
      _count: { _all: true },
    }),
    // Channel settings
    prisma.channelSettings.findMany({
      where: { clientId },
      select: { channel: true, isEnabled: true },
    }),
    // Posts published in last 7 days
    prisma.draft.count({
      where: {
        clientId,
        status: "PUBLISHED",
        publishedAt: { gte: new Date(Date.now() - 7 * DAY_MS) },
      },
    }),
    // Posts published this week (Mon-Sun)
    prisma.draft.count({
      where: {
        clientId,
        status: "PUBLISHED",
        publishedAt: { gte: weekStart },
      },
    }),
    // Scheduled posts in the future
    prisma.draft.count({
      where: {
        clientId,
        status: "SCHEDULED",
        scheduledFor: { gte: now },
      },
    }),
    // Most recent autopilot-generated draft (publishSource = 'autopilot')
    prisma.draft.findFirst({
      where: { clientId, generationGuidance: { contains: "Autopilot" } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);

  const totalDataItems = dataItemStats.reduce((s, r) => s + r._count._all, 0);
  const statusMap = Object.fromEntries(
    draftStats.map((r) => [r.status, r._count._all])
  );
  const enabledChannels = channelSettings.filter((c) => c.isEnabled);

  // Count unused data items (usageCount = 0)
  const unusedDataCount = await prisma.workspaceDataItem.count({
    where: { clientId, status: "ACTIVE", usageCount: 0 },
  });

  const recommendations = [];

  // 1. Unused business data → generate content
  if (unusedDataCount > 0) {
    recommendations.push({
      id: "unused_data",
      title: `${unusedDataCount} unused data item${unusedDataCount === 1 ? "" : "s"}`,
      description: `You have business data that hasn't been turned into content yet. Generate posts from your best data.`,
      action: "generate_from_data",
      actionLabel: "Generate from data",
      priority: 90,
      category: "data",
    });
  }

  // 2. Low posting frequency
  if (recentPublished < 3) {
    recommendations.push({
      id: "low_frequency",
      title: "Post more frequently",
      description:
        recentPublished === 0
          ? "You haven't published anything this week. Consistent posting drives growth."
          : `Only ${recentPublished} post${recentPublished === 1 ? "" : "s"} this week. Aim for 3-5 per week.`,
      action: "generate_content",
      actionLabel: "Generate content",
      priority: 85,
      category: "frequency",
    });
  }

  // 3. Missing integrations
  if (enabledChannels.length === 0) {
    recommendations.push({
      id: "no_channels",
      title: "Connect a platform",
      description:
        "You haven't enabled any channels. Connect at least one to start publishing.",
      action: "setup_channels",
      actionLabel: "Set up channels",
      priority: 95,
      category: "setup",
    });
  } else if (enabledChannels.length === 1) {
    recommendations.push({
      id: "more_channels",
      title: "Expand your reach",
      description:
        "You're only on one platform. Adding more channels multiplies your content's reach.",
      action: "setup_channels",
      actionLabel: "Add channels",
      priority: 60,
      category: "growth",
    });
  }

  // 4. No business data at all
  if (totalDataItems === 0) {
    recommendations.push({
      id: "no_data",
      title: "Add business data",
      description:
        "Add testimonials, stats, case studies, or milestones to generate smarter, data-driven content.",
      action: "add_data",
      actionLabel: "Add data",
      priority: 80,
      category: "data",
    });
  }

  // 5. Pending drafts piling up
  const pendingCount = statusMap.PENDING_REVIEW ?? 0;
  if (pendingCount >= 5) {
    recommendations.push({
      id: "review_backlog",
      title: `${pendingCount} drafts awaiting review`,
      description:
        "Review and approve your pending drafts to keep your content pipeline moving.",
      action: "review_drafts",
      actionLabel: "Review drafts",
      priority: 75,
      category: "workflow",
    });
  }

  // 6. Approved but not scheduled
  const approvedCount = statusMap.APPROVED ?? 0;
  if (approvedCount >= 3) {
    recommendations.push({
      id: "schedule_approved",
      title: `${approvedCount} approved drafts ready to schedule`,
      description:
        "Schedule your approved content for consistent publishing.",
      action: "schedule_drafts",
      actionLabel: "Schedule drafts",
      priority: 70,
      category: "workflow",
    });
  }

  recommendations.sort((a, b) => b.priority - a.priority);

  // Per-type data item counts for Business Data Snapshot
  const dataByType = Object.fromEntries(
    dataItemStats.map((r) => [r.type, r._count._all])
  );

  return {
    recommendations: recommendations.slice(0, 5),
    summary: {
      totalDataItems,
      unusedDataCount,
      enabledChannels: enabledChannels.length,
      recentPublished,
      dataByType,
      publishedThisWeek,
      scheduledUpcoming,
      lastAutopilotAt: lastAutopilotDraft?.createdAt?.toISOString() ?? null,
    },
  };
}

// ── Next Best Actions ───────────────────────────────────────────────────

/**
 * Returns prioritized "what to do next" actions with direct CTAs.
 */
export async function getDashboardActions(clientId) {
  const [
    pendingDrafts,
    approvedDrafts,
    scheduledDrafts,
    channelSettings,
    dataItemCount,
  ] = await Promise.all([
    prisma.draft.findMany({
      where: { clientId, status: "PENDING_REVIEW" },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        body: true,
        channel: true,
        kind: true,
        createdAt: true,
      },
    }),
    prisma.draft.findMany({
      where: { clientId, status: "APPROVED" },
      orderBy: { createdAt: "desc" },
      take: 5,
      select: {
        id: true,
        body: true,
        channel: true,
        kind: true,
        createdAt: true,
      },
    }),
    prisma.draft.count({
      where: { clientId, status: "SCHEDULED" },
    }),
    prisma.channelSettings.findMany({
      where: { clientId },
      select: { channel: true, isEnabled: true },
    }),
    prisma.workspaceDataItem.count({
      where: { clientId, status: "ACTIVE" },
    }),
  ]);

  const enabledChannels = channelSettings.filter((c) => c.isEnabled);
  const actions = [];

  // Drafts needing approval
  if (pendingDrafts.length > 0) {
    actions.push({
      id: "review_pending",
      type: "review",
      title: `Review ${pendingDrafts.length} pending draft${pendingDrafts.length === 1 ? "" : "s"}`,
      description: "Approve or reject drafts waiting for your review.",
      actionLabel: "Review drafts",
      actionRoute: "library?status=PENDING_REVIEW",
      priority: 100,
      count: pendingDrafts.length,
      items: pendingDrafts.map((d) => ({
        id: d.id,
        body: d.body?.slice(0, 100) ?? "",
        channel: d.channel,
        kind: d.kind,
      })),
    });
  }

  // Approved drafts ready to publish/schedule
  if (approvedDrafts.length > 0) {
    actions.push({
      id: "publish_approved",
      type: "publish",
      title: `Publish or schedule ${approvedDrafts.length} approved draft${approvedDrafts.length === 1 ? "" : "s"}`,
      description: "Your approved content is ready to go live.",
      actionLabel: "View approved",
      actionRoute: "library?status=APPROVED",
      priority: 90,
      count: approvedDrafts.length,
      items: approvedDrafts.map((d) => ({
        id: d.id,
        body: d.body?.slice(0, 100) ?? "",
        channel: d.channel,
        kind: d.kind,
      })),
    });
  }

  // No channels enabled
  if (enabledChannels.length === 0) {
    actions.push({
      id: "setup_channels",
      type: "setup",
      title: "Enable at least one channel",
      description:
        "Connect a platform to start publishing your content.",
      actionLabel: "Set up channels",
      actionRoute: "settings/media",
      priority: 95,
      count: 0,
      items: [],
    });
  }

  // No business data
  if (dataItemCount === 0) {
    actions.push({
      id: "add_data",
      type: "data",
      title: "Add your first business data",
      description:
        "Testimonials, stats, and case studies power smarter content.",
      actionLabel: "Add data",
      actionRoute: "data",
      priority: 70,
      count: 0,
      items: [],
    });
  }

  // Nothing scheduled coming up
  if (scheduledDrafts === 0 && enabledChannels.length > 0) {
    actions.push({
      id: "nothing_scheduled",
      type: "schedule",
      title: "No posts scheduled",
      description:
        "Keep your content pipeline full by scheduling upcoming posts.",
      actionLabel: "Open planner",
      actionRoute: "planner",
      priority: 65,
      count: 0,
      items: [],
    });
  }

  actions.sort((a, b) => b.priority - a.priority);

  return { actions: actions.slice(0, 4) };
}
