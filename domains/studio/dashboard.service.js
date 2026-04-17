// Dashboard recommendation + action engine.
// Delegates to the shared recommendation engine for recommendations.
// getDashboardActions remains local — it's a different concern (queue-based).

import { prisma } from "../../prisma.js";
import { getRecommendations } from "./recommendationEngine.service.js";

// ── Recommendations ─────────────────────────────────────────────────────

/**
 * Returns AI-driven dashboard recommendations based on
 * business data, posting activity, analytics, and integrations.
 *
 * Returns unified engine recommendations directly, enriched with
 * legacy action/category fields for backward compatibility.
 */
export async function getDashboardRecommendations(clientId) {
  const { recommendations: engineRecs, summary } = await getRecommendations(clientId, {
    surface: "dashboard",
    limit: 6,
  });

  // Enrich engine recommendations with legacy fields for backward compat
  const recommendations = engineRecs.map(enrichWithLegacyFields);

  return { recommendations, summary };
}

/**
 * Enrich a unified engine recommendation with legacy fields for backward
 * compatibility. Returns the full unified object PLUS action/category/metadata.
 */
function enrichWithLegacyFields(rec) {
  const actionMap = {
    open_create_content: "generate_post",
    open_listing_campaign: "listing_campaign",
    openListingCampaign: "listing_campaign",
    open_planner: "schedule_drafts",
    open_autopilot: "toggle_autopilot",
    open_settings: "setup_channels",
    open_data: "add_data",
    open_drafts: "review_drafts",
  };

  const payload = rec.actionPayload ?? {};
  let action = actionMap[payload.action] ?? payload.action ?? "generate_content";

  if (rec.type === "scheduling_action") {
    if (rec.id.includes("review_backlog")) action = "review_drafts";
    else if (rec.id.includes("schedule_approved")) action = "schedule_drafts";
    else if (rec.id.includes("inactivity") || rec.id.includes("low_frequency")) action = "generate_content";
    else if (rec.id.includes("nothing_scheduled")) action = "schedule_drafts";
  }
  if (rec.type === "integration_action") {
    if (rec.id.includes("no_channels")) action = "setup_channels";
    else if (rec.id.includes("no_data")) action = "add_data";
    else if (rec.id.includes("listing_feed")) action = "setup_tech_stack";
  }

  const category = rec.type.includes("listing") || rec.type.includes("milestone") || rec.type.includes("testimonial") || rec.type.includes("open_house") || rec.type.includes("price_drop") || rec.type === "campaign_hint"
    ? "real_estate"
    : rec.type === "growth_post"
      ? "growth"
      : rec.type.includes("template") || rec.type.includes("engagement")
        ? "content"
        : rec.type.includes("scheduling")
          ? "workflow"
          : rec.type.includes("integration")
            ? "setup"
            : "content";

  // Return full unified rec + legacy fields
  return {
    ...rec,
    // Legacy fields (backward compat)
    action,
    category,
    priority: rec.priorityScore,
    reason: rec.reasons?.[0] ?? undefined,
    metadata: {
      guidance: payload.guidance ?? undefined,
      templateType: payload.templateType ?? undefined,
      dataItemId: payload.dataItemId ?? undefined,
      channel: payload.channel ?? rec.suggestedChannel ?? undefined,
      recommendationId: rec.id,
      campaignType: payload.campaignType ?? rec.suggestedCampaignType ?? undefined,
      listingDataItemId: payload.listingDataItemId ?? undefined,
    },
  };
}

// ── Next Best Actions ───────────────────────────────────────────────────

/**
 * Returns prioritized "what to do next" actions with direct CTAs.
 * This is queue-based (pending drafts, approved drafts) rather than
 * recommendation-based, so it stays as its own function.
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
