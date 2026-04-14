// Dashboard recommendation + action engine.
// Reuses existing services; does NOT duplicate logic.

import { prisma } from "../../prisma.js";
import { getContentContext, getRecommendationTemplates } from "../industry/industry.service.js";
import { buildTechStackContentContext, resolveRealEstateContext } from "../industry/techStack.service.js";
import { loadRealEstateGenerationAssets } from "../industry/realEstateGeneration.js";

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

  // Load client for industryKey
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { industryKey: true },
  });
  const industryKey = client?.industryKey ?? null;

  const [
    dataItemStats,
    draftStats,
    channelSettings,
    recentPublished,
    publishedThisWeek,
    scheduledUpcoming,
    lastAutopilotDraft,
    techStack,
    lastGeneratedDraft,
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
    // Tech stack context (non-critical)
    buildTechStackContentContext(clientId).catch(() => null),
    // Most recent generated draft (for cadence awareness)
    prisma.draft.findFirst({
      where: { clientId, status: { not: "FAILED" } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);

  const totalDataItems = dataItemStats.reduce((s, r) => s + r._count._all, 0);
  const statusMap = Object.fromEntries(
    draftStats.map((r) => [r.status, r._count._all])
  );
  const enabledChannels = channelSettings.filter((c) => c.isEnabled);

  // Resolve canonical real estate context when applicable
  let realEstateContext = null;
  if (industryKey === "real_estate") {
    realEstateContext = await resolveRealEstateContext(clientId).catch(() => null);
  }

  // Count unused data items (usageCount = 0)
  const unusedDataCount = await prisma.workspaceDataItem.count({
    where: { clientId, status: "ACTIVE", usageCount: 0 },
  });

  // Cadence awareness — days since last generation
  const lastGeneratedAt = lastGeneratedDraft?.createdAt ?? null;
  const daysSinceLastGeneration = lastGeneratedAt
    ? Math.floor((now.getTime() - lastGeneratedAt.getTime()) / DAY_MS)
    : null;
  const isInactive = daysSinceLastGeneration !== null && daysSinceLastGeneration >= 3;
  const generatedRecently = daysSinceLastGeneration !== null && daysSinceLastGeneration < 1;

  const recommendations = [];

  // 1. Unused business data → generate content (listing-aware for real estate)
  if (unusedDataCount > 0) {
    const reListingCount = realEstateContext?.assets?.listingCount ?? 0;
    const isRE = industryKey === "real_estate" && reListingCount > 0;
    recommendations.push({
      id: "unused_data",
      title: isRE
        ? `${reListingCount} listing${reListingCount === 1 ? "" : "s"} ready for content`
        : `${unusedDataCount} unused data item${unusedDataCount === 1 ? "" : "s"}`,
      description: isRE
        ? `You have ${reListingCount} listing${reListingCount === 1 ? "" : "s"} that can power listing posts, open house alerts, and price drop content.`
        : `You have business data that hasn't been turned into content yet. Generate posts from your best data.`,
      action: "generate_from_data",
      actionLabel: isRE ? "Generate listing posts" : "Generate from data",
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

  // 7. Inactivity trigger — no content generated in 3+ days
  if (isInactive && enabledChannels.length > 0) {
    recommendations.push({
      id: "inactivity",
      title: `No content in ${daysSinceLastGeneration} day${daysSinceLastGeneration === 1 ? "" : "s"}`,
      description: "Consistent posting keeps your audience engaged. Generate fresh content to stay visible.",
      action: "generate_content",
      actionLabel: "Generate content",
      priority: 88,
      category: "cadence",
    });
  }

  // ── Template-driven content suggestions ──────────────────────────────
  const industryCtx = getContentContext(industryKey);
  const totalPublished = statusMap.PUBLISHED ?? 0;
  const templates = getRecommendationTemplates(industryKey);

  if (enabledChannels.length > 0 && templates.length > 0) {
    // Build condition context for template filtering
    const condCtx = {
      hasData: totalDataItems > 0,
      noPublished: totalPublished === 0,
      hasWebsite: !!techStack?.hasWebsite,
    };

    // Filter templates by tier (exclude advanced) and conditions
    const eligible = templates.filter((t) => {
      if (t.tier === "advanced") return false;
      const cond = t.conditions ?? {};
      if (cond.hasData && !condCtx.hasData) return false;
      if (cond.noPublished && !condCtx.noPublished) return false;
      if (cond.hasWebsite && !condCtx.hasWebsite) return false;
      return true;
    });

    // Sort by priority rank (high > medium > low)
    const priorityRank = { high: 3, medium: 2, low: 1 };
    eligible.sort((a, b) => (priorityRank[b.priority] ?? 1) - (priorityRank[a.priority] ?? 1));

    // Boost: website-connected items get +2 priority points
    const industryLabel = industryCtx?.label ?? "your industry";

    // Pick top 3 templates as recommendations
    for (const tmpl of eligible.slice(0, 3)) {
      const numPriority =
        tmpl.priority === "high" ? 84 : tmpl.priority === "medium" ? 72 : 60;

      recommendations.push({
        id: `tmpl_${tmpl.type}`,
        title: tmpl.title,
        description: tmpl.description,
        reason: `Suggested for ${industryLabel} businesses based on proven content patterns.`,
        action: "generate_post",
        actionLabel: "Create Post",
        priority: numPriority,
        category: "content",
        metadata: { guidance: tmpl.guidance, templateType: tmpl.type },
      });
    }
  }

  // ── Tech-stack-aware boosts ─────────────────────────────────────────
  if (techStack && enabledChannels.length > 0) {
    // Website connected but low posting → suggest website-based content
    if (techStack.hasWebsite && techStack.websiteUrl && recentPublished < 2) {
      recommendations.push({
        id: "website_content",
        title: "Generate content from your website",
        description: "Use your website content to create posts that showcase your real business.",
        reason: "Your website is connected but you have few recent posts.",
        action: "generate_post",
        actionLabel: "Create Post",
        priority: 82,
        category: "content",
        metadata: {
          guidance: `Create a post based on this business's website. Reference real pages, services, and details from ${techStack.websiteUrl}.`,
          templateType: "website_content",
        },
      });
    }
  }

  // ── Real estate asset-aware recommendations ───────────────────────
  let reAssets = null;
  if (industryKey === "real_estate" && realEstateContext) {
    try {
      reAssets = await loadRealEstateGenerationAssets(clientId, realEstateContext);
    } catch {
      // Non-critical
    }

    if (reAssets && enabledChannels.length > 0) {
      const hasFB = enabledChannels.some((c) => c.channel === "FACEBOOK");
      const hasIG = enabledChannels.some((c) => c.channel === "INSTAGRAM");

      // Listing-based recommendations
      if (reAssets.bestListing && reAssets.bestListingSource) {
        const listing = reAssets.bestListing;
        const listingLabel = listing.title || listing.address || "a property";

        if (hasFB) {
          recommendations.push({
            id: "re_listing_facebook",
            title: `Post ${listingLabel} to Facebook`,
            description: "Create a listing post with property details for your Facebook audience.",
            reason: `You have ${reAssets.listingCount} listing${reAssets.listingCount === 1 ? "" : "s"} ready. Facebook is ideal for detailed property posts.`,
            action: "generate_post",
            actionLabel: "Create Listing Post",
            priority: 91,
            category: "real_estate",
            metadata: {
              templateType: "listing_post",
              channel: "FACEBOOK",
              dataItemId: reAssets.bestListingSource.id,
              guidance: "Create a 'just listed' post highlighting this property's best features.",
              recommendationId: "re_listing_facebook",
            },
          });
        }

        if (hasIG) {
          recommendations.push({
            id: "re_listing_instagram",
            title: `Feature ${listingLabel} on Instagram`,
            description: "Create a visual-first property post for Instagram.",
            reason: `Instagram is perfect for showcasing property photos and quick highlights.`,
            action: "generate_post",
            actionLabel: "Create Property Post",
            priority: hasFB ? 86 : 91,
            category: "real_estate",
            metadata: {
              templateType: "featured_property",
              channel: "INSTAGRAM",
              dataItemId: reAssets.bestListingSource.id,
              guidance: "Create an Instagram property feature post — punchy, visual, scroll-stopping.",
              recommendationId: "re_listing_instagram",
            },
          });
        }
      }

      // Review-based recommendation
      if (reAssets.reviewCount > 0) {
        const targetChannel = hasIG ? "INSTAGRAM" : hasFB ? "FACEBOOK" : enabledChannels[0]?.channel;
        if (targetChannel) {
          recommendations.push({
            id: "re_testimonial_post",
            title: "Turn a client review into a post",
            description: `You have ${reAssets.reviewCount} client review${reAssets.reviewCount === 1 ? "" : "s"}. Testimonial posts build trust and credibility.`,
            reason: "Real client reviews are powerful social proof for real estate.",
            action: "generate_post",
            actionLabel: "Create Testimonial Post",
            priority: 83,
            category: "real_estate",
            metadata: {
              templateType: "client_testimonial",
              channel: targetChannel,
              guidance: "Create a testimonial post using a real client review. Quote accurately and build trust.",
              recommendationId: "re_testimonial_post",
            },
          });
        }
      }

      // No recent property posts suggestion
      if (reAssets.listingCount > 0 && recentPublished > 0) {
        // Check if any recent published drafts were listing posts
        const recentListingDraft = await prisma.draft.findFirst({
          where: {
            clientId,
            status: "PUBLISHED",
            publishedAt: { gte: new Date(Date.now() - 14 * DAY_MS) },
            warnings: { hasSome: ["re_auto_listing"] },
          },
        }).catch(() => null);

        if (!recentListingDraft) {
          recommendations.push({
            id: "re_no_recent_listing",
            title: "You haven't posted a property recently",
            description: `You have ${reAssets.listingCount} listing${reAssets.listingCount === 1 ? "" : "s"} but haven't featured one in a while. Keep listings visible.`,
            reason: "Regular listing posts keep your properties in front of buyers.",
            action: "generate_post",
            actionLabel: "Post a Listing",
            priority: 80,
            category: "real_estate",
            metadata: {
              templateType: "listing_post",
              channel: hasFB ? "FACEBOOK" : hasIG ? "INSTAGRAM" : enabledChannels[0]?.channel,
              guidance: "Create a just-listed or featured property post for one of the available listings.",
              recommendationId: "re_no_recent_listing",
            },
          });
        }
      }

      // Listing feed not connected
      if (!realEstateContext.techStack?.listingFeed || realEstateContext.techStack.listingFeed.status !== "connected") {
        recommendations.push({
          id: "re_setup_listing_feed",
          title: "Add your listings page",
          description: "Connect your listings page to automatically import properties for content.",
          reason: "Listing data powers just-listed posts, open house alerts, and price drop content.",
          action: "setup_tech_stack",
          actionLabel: "Set Up Listing Feed",
          priority: 78,
          category: "real_estate",
        });
      }
    }
  }

  // Cadence dampening — lower generate-type priorities if content was created recently
  if (generatedRecently) {
    const generateActions = new Set(["generate_content", "generate_post", "generate_from_data"]);
    for (const rec of recommendations) {
      if (generateActions.has(rec.action)) {
        rec.priority = Math.max(rec.priority - 15, 10);
      }
    }
  }

  recommendations.sort((a, b) => b.priority - a.priority);

  // Per-type data item counts for Business Data Snapshot
  const dataByType = Object.fromEntries(
    dataItemStats.map((r) => [r.type, r._count._all])
  );

  // Build summary with real estate enhancements
  const summary = {
    totalDataItems,
    unusedDataCount,
    enabledChannels: enabledChannels.length,
    recentPublished,
    dataByType,
    publishedThisWeek,
    scheduledUpcoming,
    lastAutopilotAt: lastAutopilotDraft?.createdAt?.toISOString() ?? null,
    lastGeneratedAt: lastGeneratedAt?.toISOString() ?? null,
    daysSinceLastGeneration,
  };

  // Real estate asset summary
  if (industryKey === "real_estate") {
    summary.realEstate = {
      listingCount: reAssets?.listingCount ?? realEstateContext?.assets?.listingCount ?? 0,
      reviewCount: reAssets?.reviewCount ?? realEstateContext?.assets?.reviewCount ?? 0,
      listingFeedConnected: realEstateContext?.techStack?.listingFeed?.status === "connected",
      websiteConnected: realEstateContext?.techStack?.website?.status === "connected",
      availableChannels: realEstateContext?.publishing?.availableChannels ?? [],
    };
  }

  return {
    recommendations: recommendations.slice(0, 6),
    summary,
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
