// Shared Recommendation Intelligence Layer.
//
// One engine, one prioritization model, one object format.
// Consumed by Dashboard, Create Content, and Listing Campaign surfaces.
//
// Candidate builders evaluate real system data (listings, milestones,
// reviews, posting cadence, integrations, autopilot state). The engine
// scores, deduplicates, and filters recommendations per surface.

import { prisma } from "../../prisma.js";
import { redisGet, redisSet } from "../../redis.js";
import { resolveRealEstateContext } from "../industry/techStack.service.js";
import { loadRealEstateGenerationAssets } from "../industry/realEstateGeneration.js";
import { getContentContext, getRecommendationTemplates } from "../industry/industry.service.js";
import { buildTechStackContentContext } from "../industry/techStack.service.js";
import { getAutopilotStatus } from "./autopilot.service.js";
import { getPerformanceProfile } from "./performanceFeedback.service.js";
import { getGBPSignals } from "./gbpSync.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const REC_TRACK_PREFIX = "sp:rec:track:";
const REC_TRACK_TTL = 86400; // 24h
const REC_DISMISSED_PREFIX = "sp:rec:dismissed:";
const REC_ACCEPTED_PREFIX = "sp:rec:accepted:";

// ── Surface Definitions ──────────────────────────────────────────────────

const SURFACE_TYPES = {
  dashboard: [
    "listing_post", "listing_campaign", "milestone_post", "milestone_campaign",
    "open_house_campaign", "price_drop_campaign",
    "price_drop_alert", "stale_listing_refresh", "unpromoted_listing",
    "testimonial_post", "engagement_post", "growth_post", "scheduling_action",
    "autopilot_action", "integration_action", "campaign_hint", "gbp_reply",
  ],
  create_content: [
    "listing_post", "milestone_post", "testimonial_post", "engagement_post",
    "growth_post", "campaign_hint",
  ],
  listing_campaign: [
    "listing_campaign", "milestone_campaign", "open_house_campaign", "price_drop_campaign",
    "price_drop_alert",
  ],
  planner: [
    "listing_campaign", "milestone_campaign", "open_house_campaign", "price_drop_campaign",
    "campaign_hint", "scheduling_action", "growth_post",
  ],
};

// ── Base Priority Scores ─────────────────────────────────────────────────

const BASE_SCORES = {
  milestone_campaign: 95,
  listing_campaign: 92,
  price_drop_alert: 91,
  price_drop_campaign: 90,
  open_house_campaign: 88,
  milestone_post: 85,
  listing_post: 82,
  testimonial_post: 78,
  growth_post: 76,
  stale_listing_refresh: 72,
  scheduling_action: 70,
  unpromoted_listing: 68,
  autopilot_action: 65,
  campaign_hint: 60,
  neighborhood_post: 74,
  engagement_post: 55,
  integration_action: 50,
};

// ── Main Entry Point ─────────────────────────────────────────────────────

/**
 * Generate recommendations for a workspace, optionally filtered for a surface.
 *
 * @param {string} clientId
 * @param {object} [opts]
 * @param {string} [opts.surface] — "dashboard" | "create_content" | "listing_campaign"
 * @param {number} [opts.limit] — max results (default 6)
 * @returns {Promise<{ recommendations: Recommendation[], summary: object }>}
 */
export async function getRecommendations(clientId, { surface, limit = 6 } = {}) {
  // Load workspace context in parallel
  const client = await prisma.client.findUnique({
    where: { id: clientId },
    select: { industryKey: true },
  });
  const industryKey = client?.industryKey ?? null;

  const now = new Date();
  const dayOfWeek = now.getUTCDay();
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
    lastGeneratedDraft,
    techStack,
    topUnusedItems,
    unusedDataCount,
    nearbyListings,
    campaignDrafts,
  ] = await Promise.all([
    prisma.workspaceDataItem.groupBy({
      by: ["type"],
      where: { clientId, status: "ACTIVE" },
      _count: { _all: true },
    }),
    prisma.draft.groupBy({
      by: ["status"],
      where: { clientId },
      _count: { _all: true },
    }),
    prisma.channelSettings.findMany({
      where: { clientId },
      select: { channel: true, isEnabled: true },
    }),
    prisma.draft.count({
      where: {
        clientId,
        status: "PUBLISHED",
        publishedAt: { gte: new Date(Date.now() - 7 * DAY_MS) },
      },
    }),
    prisma.draft.count({
      where: {
        clientId,
        status: "PUBLISHED",
        publishedAt: { gte: weekStart },
      },
    }),
    prisma.draft.count({
      where: {
        clientId,
        status: "SCHEDULED",
        scheduledFor: { gte: now },
      },
    }),
    prisma.draft.findFirst({
      where: { clientId, status: { not: "FAILED" } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    buildTechStackContentContext(clientId).catch(() => null),
    prisma.workspaceDataItem.findMany({
      where: { clientId, status: "ACTIVE", usageCount: 0 },
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
      take: 10,
      select: {
        id: true, type: true, title: true, summary: true,
        dataJson: true, usageCount: true, createdAt: true,
      },
    }),
    prisma.workspaceDataItem.count({
      where: { clientId, status: "ACTIVE", usageCount: 0 },
    }),
    // Nearby listings from RentCast cache (written by listings search endpoint)
    redisGet(`sp:nearby:${clientId}`).then((raw) => {
      if (!raw) return [];
      try { return JSON.parse(raw); } catch { return []; }
    }).catch(() => []),
    // Campaign usage — which sources already have launched campaigns
    prisma.draft.findMany({
      where: { clientId, campaignId: { not: null } },
      select: {
        campaignId: true,
        campaignType: true,
        campaignName: true,
        warnings: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);

  // Build campaign usage map: sourceId → { hasCampaign, campaignCount, lastCampaignAt, campaignTypes }
  const campaignUsageBySource = new Map();
  const activeCampaignIds = new Set();
  for (const d of campaignDrafts) {
    if (d.campaignId) activeCampaignIds.add(d.campaignId);
    // Extract source dataItemId from warnings array
    const dataItemWarning = d.warnings?.find((w) => w.startsWith("dataItemId:"));
    const sourceId = dataItemWarning ? dataItemWarning.replace("dataItemId:", "") : null;
    if (!sourceId) continue;
    let usage = campaignUsageBySource.get(sourceId);
    if (!usage) {
      usage = { hasCampaign: true, campaignCount: 0, lastCampaignAt: null, campaignTypes: new Set(), activeCampaigns: 0 };
      campaignUsageBySource.set(sourceId, usage);
    }
    // Count unique campaigns (not individual posts within a campaign)
    if (!usage._seenCampaignIds) usage._seenCampaignIds = new Set();
    if (!usage._seenCampaignIds.has(d.campaignId)) {
      usage._seenCampaignIds.add(d.campaignId);
      usage.campaignCount++;
      if (d.status !== "PUBLISHED" && d.status !== "FAILED") usage.activeCampaigns++;
    }
    if (d.campaignType) usage.campaignTypes.add(d.campaignType);
    if (!usage.lastCampaignAt || d.createdAt > usage.lastCampaignAt) {
      usage.lastCampaignAt = d.createdAt;
    }
  }

  const totalDataItems = dataItemStats.reduce((s, r) => s + r._count._all, 0);
  const statusMap = Object.fromEntries(draftStats.map((r) => [r.status, r._count._all]));
  const enabledChannels = channelSettings.filter((c) => c.isEnabled);
  const lastGeneratedAt = lastGeneratedDraft?.createdAt ?? null;
  const daysSinceLastGeneration = lastGeneratedAt
    ? Math.floor((now.getTime() - lastGeneratedAt.getTime()) / DAY_MS)
    : null;
  const generatedRecently = daysSinceLastGeneration !== null && daysSinceLastGeneration < 1;

  // Real estate context (if applicable)
  let realEstateContext = null;
  let reAssets = null;
  if (industryKey === "real_estate") {
    realEstateContext = await resolveRealEstateContext(clientId).catch(() => null);
    if (realEstateContext) {
      reAssets = await loadRealEstateGenerationAssets(clientId, realEstateContext).catch(() => null);
    }
  }

  // Autopilot status + GBP signals
  const [autopilotStatus, gbpSignals] = await Promise.all([
    getAutopilotStatus(clientId).catch(() => null),
    getGBPSignals(clientId).catch(() => ({ hasGBP: false, reviewCount: 0, averageRating: null, unrepliedCount: 0, recentNewReviews: 0, ratingDelta: 0, lastSyncedAt: null })),
  ]);

  // ── Build Candidates ───────────────────────────────────────────────────

  const ctx = {
    clientId,
    industryKey,
    now,
    enabledChannels,
    recentPublished,
    publishedThisWeek,
    scheduledUpcoming,
    totalDataItems,
    unusedDataCount,
    statusMap,
    daysSinceLastGeneration,
    generatedRecently,
    lastGeneratedAt,
    topUnusedItems,
    realEstateContext,
    reAssets,
    techStack,
    autopilotStatus,
    gbpSignals,
    campaignUsageBySource,
    activeCampaignIds,
    nearbyListings,
  };

  const candidates = [];

  candidates.push(...buildListingCandidates(ctx));
  candidates.push(...buildPropertyLibraryCandidates(ctx));
  candidates.push(...buildNearbyListingCandidates(ctx));
  candidates.push(...buildEventDrivenCandidates(ctx));
  candidates.push(...buildMilestoneCandidates(ctx));
  candidates.push(...buildTestimonialCandidates(ctx));
  candidates.push(...buildGrowthCandidates(ctx));
  candidates.push(...buildSchedulingCandidates(ctx));
  candidates.push(...buildAutopilotCandidates(ctx));
  candidates.push(...buildIntegrationCandidates(ctx));
  candidates.push(...buildEngagementCandidates(ctx));
  candidates.push(...buildTemplateCandidates(ctx));
  candidates.push(...buildCampaignFollowUpCandidates(ctx));
  candidates.push(...buildGBPCandidates(ctx));

  // ── Score, Deduplicate, Filter ─────────────────────────────────────────

  // Apply cadence dampening — lower generate-type priorities if recently generated
  if (generatedRecently) {
    const generateTypes = new Set([
      "listing_post", "listing_campaign", "milestone_post",
      "milestone_campaign", "open_house_campaign", "price_drop_campaign",
      "testimonial_post", "engagement_post", "growth_post", "campaign_hint",
    ]);
    for (const c of candidates) {
      if (generateTypes.has(c.type)) {
        c.priorityScore = Math.max(c.priorityScore - 15, 10);
      }
    }
  }

  // Apply performance feedback — boost high-performing content types, reduce weak ones
  let perfProfile = null;
  try {
    perfProfile = await getPerformanceProfile(clientId);
  } catch { /* non-critical */ }

  if (perfProfile && perfProfile.totalRated >= 3) {
    const TYPE_TO_CONTENT = {
      listing_post: "listing", listing_campaign: "listing",
      milestone_post: "testimonial", milestone_campaign: "testimonial",
      testimonial_post: "testimonial",
      growth_post: "growth",
      engagement_post: "engagement",
    };

    const topTypes = new Set(perfProfile.topContentTypes.map((t) => t.type));
    const weakTypes = new Set(perfProfile.weakContentTypes.map((t) => t.type));

    for (const c of candidates) {
      const contentType = TYPE_TO_CONTENT[c.type];
      if (!contentType) continue;
      if (topTypes.has(contentType)) {
        c.priorityScore = Math.min(c.priorityScore + 8, 100);
      } else if (weakTypes.has(contentType)) {
        c.priorityScore = Math.max(c.priorityScore - 6, 10);
      }
    }
  }

  // Apply recommendation recency dampening + show-count expiration
  let recentlyShown = new Set();
  let showCounts = {};
  try {
    const trackKey = `${REC_TRACK_PREFIX}${clientId}`;
    const tracked = await redisGet(trackKey);
    if (tracked) {
      const parsed = JSON.parse(tracked);
      recentlyShown = new Set(parsed.ids ?? []);
      showCounts = parsed.counts ?? {};
      for (const c of candidates) {
        if (recentlyShown.has(c.id)) {
          // Expire recs shown 3+ times in the 24h window
          if ((showCounts[c.id] ?? 0) >= 3) {
            c.priorityScore = -999;
          } else {
            c.priorityScore = Math.max(c.priorityScore - 5, 10);
          }
        }
      }
    }
  } catch { /* non-critical */ }

  // Accept dampening — penalise recently accepted recs
  try {
    const acceptedRaw = await redisGet(`${REC_ACCEPTED_PREFIX}${clientId}`);
    if (acceptedRaw) {
      const accepted = JSON.parse(acceptedRaw);
      const now = Date.now();
      for (const c of candidates) {
        const entry = accepted.findLast((a) => a.id === c.id);
        if (!entry) continue;
        const ageMs = now - new Date(entry.at).getTime();
        if (ageMs < 6 * 60 * 60 * 1000) {
          c.priorityScore = -999; // fully exclude < 6h
        } else if (ageMs < 48 * 60 * 60 * 1000) {
          c.priorityScore -= 20; // dampen < 48h
        }
      }
    }
  } catch { /* non-critical */ }

  // Dismiss dampening — penalise dismissed recs (7d window)
  try {
    const dismissedRaw = await redisGet(`${REC_DISMISSED_PREFIX}${clientId}`);
    if (dismissedRaw) {
      const dismissed = JSON.parse(dismissedRaw);
      // Count dismissals per rec ID
      const dismissCounts = {};
      for (const d of dismissed) {
        dismissCounts[d.id] = (dismissCounts[d.id] ?? 0) + 1;
      }
      for (const c of candidates) {
        const count = dismissCounts[c.id] ?? 0;
        if (count >= 2) {
          c.priorityScore = -999; // fully excluded
        } else if (count === 1) {
          c.priorityScore -= 30;
        }
      }
    }
  } catch { /* non-critical */ }

  // Viability filter — remove candidates that scored below zero
  const viable = candidates.filter((c) => c.priorityScore > 0);

  // Deduplicate: don't show both campaign + post for same source
  const deduped = deduplicateCandidates(viable);

  // Filter by surface
  const allowedTypes = surface && SURFACE_TYPES[surface]
    ? new Set(SURFACE_TYPES[surface])
    : null;
  const filtered = allowedTypes
    ? deduped.filter((c) => allowedTypes.has(c.type))
    : deduped;

  // Sort and limit
  filtered.sort((a, b) => b.priorityScore - a.priorityScore);
  const recommendations = filtered.slice(0, limit);

  // Track shown recommendations with counts (fire-and-forget)
  try {
    const shownIds = recommendations.map((r) => r.id);
    const mergedIds = [...new Set([...recentlyShown, ...shownIds])].slice(-40);
    const updatedCounts = { ...showCounts };
    for (const id of shownIds) {
      updatedCounts[id] = (updatedCounts[id] ?? 0) + 1;
    }
    // Trim counts to only tracked IDs
    const mergedSet = new Set(mergedIds);
    for (const key of Object.keys(updatedCounts)) {
      if (!mergedSet.has(key)) delete updatedCounts[key];
    }
    redisSet(
      `${REC_TRACK_PREFIX}${clientId}`,
      JSON.stringify({ ids: mergedIds, counts: updatedCounts, at: new Date().toISOString() }),
      REC_TRACK_TTL,
    ).catch(() => {});
  } catch { /* non-critical */ }

  // ── Build Summary ──────────────────────────────────────────────────────

  const dataByType = Object.fromEntries(
    dataItemStats.map((r) => [r.type, r._count._all])
  );

  const summary = {
    totalDataItems,
    unusedDataCount,
    enabledChannels: enabledChannels.length,
    recentPublished,
    dataByType,
    publishedThisWeek,
    scheduledUpcoming,
    lastGeneratedAt: lastGeneratedAt?.toISOString() ?? null,
    daysSinceLastGeneration,
    topUnusedItems: topUnusedItems.map((item) => ({
      id: item.id,
      type: item.type,
      title: item.title,
      summary: item.summary,
      address: item.dataJson?.address ?? null,
      quote: item.dataJson?.quote ?? item.dataJson?.testimonial ?? null,
      author: item.dataJson?.author ?? item.dataJson?.name ?? null,
      achievement: item.dataJson?.achievement ?? null,
    })),
  };

  summary.activeCampaigns = activeCampaignIds.size;

  // Lightweight Growth Score (0-100) based on posting frequency, content mix, and growth content presence
  const growthDrafts = candidates.filter((c) => c.type === "growth_post");
  const frequencyScore = Math.min(recentPublished * 15, 45); // 0-45 from posting frequency (3+ posts = max)
  const mixScore = Math.min(totalDataItems * 3, 30); // 0-30 from content variety
  const growthContentScore = growthDrafts.length > 0 ? 0 : 25; // 0 or 25 — penalty when no growth content exists
  summary.growthScore = Math.min(100, frequencyScore + mixScore + (25 - growthContentScore));

  // Real estate + autopilot summary
  if (industryKey === "real_estate") {
    summary.realEstate = {
      listingCount: reAssets?.listingCount ?? realEstateContext?.assets?.listingCount ?? 0,
      reviewCount: reAssets?.reviewCount ?? realEstateContext?.assets?.reviewCount ?? 0,
      milestoneCount: reAssets?.milestoneCount ?? 0,
      listingFeedConnected: realEstateContext?.techStack?.listingFeed?.status === "connected",
      websiteConnected: realEstateContext?.techStack?.website?.status === "connected",
      availableChannels: realEstateContext?.publishing?.availableChannels ?? [],
    };
    if (autopilotStatus) summary.autopilot = autopilotStatus;
  }

  return { recommendations, summary };
}

// ── Candidate Builders ───────────────────────────────────────────────────

function buildListingCandidates(ctx) {
  const candidates = [];
  const { reAssets, enabledChannels, industryKey, campaignUsageBySource } = ctx;

  if (industryKey !== "real_estate" || !reAssets) return candidates;

  const hasFB = enabledChannels.some((c) => c.channel === "FACEBOOK");
  const hasIG = enabledChannels.some((c) => c.channel === "INSTAGRAM");

  // All normalized listings for multi-candidate generation
  const listings = reAssets.listings && reAssets.listings.length > 0
    ? reAssets.listings
    : reAssets.bestListing && reAssets.bestListingSource
      ? [{ normalized: reAssets.bestListing, source: reAssets.bestListingSource }]
      : [];

  for (const entry of listings) {
    const listing = entry.normalized;
    const source = entry.source;
    const label = listing.title || listing.address || "a property";
    const isNew = source.createdAt && (ctx.now - new Date(source.createdAt)) < 3 * DAY_MS;
    const isUnused = (source.usageCount ?? 0) === 0;
    const freshness = isNew ? "fresh" : isUnused ? "recent" : "stale";

    // Campaign suppression check
    const campUsage = campaignUsageBySource.get(source.id);
    const hasCampaign = campUsage?.hasCampaign ?? false;
    const hasActiveCampaign = (campUsage?.activeCampaigns ?? 0) > 0;
    const hasJustListedCampaign = campUsage?.campaignTypes?.has("just_listed") ?? false;
    const recentCampaign = campUsage?.lastCampaignAt
      ? (ctx.now - campUsage.lastCampaignAt) < 14 * DAY_MS
      : false;

    // Media richness — check if listing has images
    const images = source.dataJson?.images ?? source.dataJson?.photos ?? [];
    const hasStrongMedia = Array.isArray(images) && images.length >= 3;

    const reasons = [];
    if (isNew) reasons.push("New listing detected");
    if (isUnused) reasons.push("No content created from this listing yet");
    if (!hasCampaign) reasons.push("No campaign launched yet");
    if (hasStrongMedia) reasons.push("This listing has strong media");
    if (listing.price) reasons.push(`Listed at $${Number(listing.price).toLocaleString()}`);

    // ── Just Listed Campaign ──
    // Suppress if already has a just_listed campaign, sharp drop if any campaign exists
    if (!hasCampaign) {
      let score = BASE_SCORES.listing_campaign + (isNew ? 5 : 0) + (isUnused ? 3 : 0) + (hasStrongMedia ? 3 : 0);
      if (hasCampaign && !hasJustListedCampaign) score -= 25; // Different type exists, lower priority
      if (hasActiveCampaign) score -= 15; // Active campaign running
      if (recentCampaign) score -= 10; // Recent campaign for this source

      candidates.push({
        id: `listing_campaign:${source.id}`,
        type: "listing_campaign",
        title: `Launch a Just Listed campaign for ${label}`,
        description: `Create a coordinated ${hasStrongMedia ? "media-rich " : ""}marketing campaign across multiple posts and platforms.`,
        sourceType: "listing",
        sourceId: source.id,
        sourceLabel: label,
        priorityScore: Math.max(score, 10),
        confidence: listing.completenessScore >= 4 ? "high" : "medium",
        freshness,
        surfaces: ["dashboard", "listing_campaign"],
        suggestedContentType: "listing",
        suggestedCampaignType: "just_listed",
        suggestedChannel: hasFB ? "FACEBOOK" : hasIG ? "INSTAGRAM" : null,
        actionLabel: "Launch Campaign",
        actionPayload: {
          action: "openListingCampaign",
          sourceType: "listing",
          sourceId: source.id,
          campaignType: "just_listed",
          listingDataItemId: source.id,
        },
        reasons,
        hasCampaign,
        campaignCount: campUsage?.campaignCount ?? 0,
        lastCampaignAt: campUsage?.lastCampaignAt?.toISOString() ?? null,
        evaluatedAt: ctx.now.toISOString(),
      });
    }

    // ── Listing Spotlight Campaign (media-rich listings) ──
    if (hasStrongMedia && !hasCampaign) {
      let score = BASE_SCORES.listing_campaign - 5 + (hasStrongMedia ? 8 : 0);
      if (hasCampaign) score -= 20;

      candidates.push({
        id: `listing_campaign_spotlight:${source.id}`,
        type: "listing_campaign",
        title: `Create a Listing Spotlight for ${label}`,
        description: "This property has strong media — showcase it with a lifestyle-focused campaign.",
        sourceType: "listing",
        sourceId: source.id,
        sourceLabel: label,
        priorityScore: Math.max(score, 10),
        confidence: "medium",
        freshness,
        surfaces: ["listing_campaign"],
        suggestedContentType: "listing",
        suggestedCampaignType: "listing_spotlight",
        suggestedChannel: hasIG ? "INSTAGRAM" : hasFB ? "FACEBOOK" : null,
        actionLabel: "Launch Spotlight",
        actionPayload: {
          action: "openListingCampaign",
          sourceType: "listing",
          sourceId: source.id,
          campaignType: "listing_spotlight",
          listingDataItemId: source.id,
        },
        reasons: ["This listing has strong media", "Well-suited for a multi-post campaign"],
        hasCampaign,
        campaignCount: campUsage?.campaignCount ?? 0,
        lastCampaignAt: campUsage?.lastCampaignAt?.toISOString() ?? null,
        evaluatedAt: ctx.now.toISOString(),
      });
    }

    // ── Listing Post (Facebook) ──
    if (hasFB) {
      candidates.push({
        id: `listing_post_fb:${source.id}`,
        type: "listing_post",
        title: `Post ${label} to Facebook`,
        description: "Create a listing post with property details for your Facebook audience.",
        sourceType: "listing",
        sourceId: source.id,
        sourceLabel: label,
        priorityScore: BASE_SCORES.listing_post + (isNew ? 3 : 0) + (isUnused ? 2 : 0),
        confidence: listing.completenessScore >= 3 ? "high" : "medium",
        freshness,
        surfaces: ["dashboard", "create_content"],
        suggestedContentType: "listing",
        suggestedCampaignType: null,
        suggestedChannel: "FACEBOOK",
        actionLabel: "Create Listing Post",
        actionPayload: {
          action: "open_create_content",
          guidance: `Create a 'just listed' post highlighting this property's best features.`,
          templateType: "listing_post",
          dataItemId: source.id,
          channel: "FACEBOOK",
        },
        reasons,
        evaluatedAt: ctx.now.toISOString(),
      });
    }

    // ── Listing Post (Instagram) ──
    if (hasIG) {
      candidates.push({
        id: `listing_post_ig:${source.id}`,
        type: "listing_post",
        title: `Feature ${label} on Instagram`,
        description: "Create a visual-first property post for Instagram.",
        sourceType: "listing",
        sourceId: source.id,
        sourceLabel: label,
        priorityScore: BASE_SCORES.listing_post + (isNew ? 3 : 0) + (isUnused ? 2 : 0) - (hasFB ? 3 : 0),
        confidence: listing.completenessScore >= 3 ? "high" : "medium",
        freshness,
        surfaces: ["dashboard", "create_content"],
        suggestedContentType: "listing",
        suggestedCampaignType: null,
        suggestedChannel: "INSTAGRAM",
        actionLabel: "Create Property Post",
        actionPayload: {
          action: "open_create_content",
          guidance: "Create an Instagram property feature post — punchy, visual, scroll-stopping.",
          templateType: "featured_property",
          dataItemId: source.id,
          channel: "INSTAGRAM",
        },
        reasons,
        evaluatedAt: ctx.now.toISOString(),
      });
    }

    // ── Campaign-worthy hint for Create Content ──
    // If this listing is campaign-worthy but user is on Create Content, nudge them
    if (!hasCampaign && isNew && listing.completenessScore >= 3) {
      candidates.push({
        id: `campaign_hint:${source.id}`,
        type: "campaign_hint",
        title: `Consider a full campaign for ${label}`,
        description: "This listing is well-suited for a multi-post campaign instead of a single post.",
        sourceType: "listing",
        sourceId: source.id,
        sourceLabel: label,
        priorityScore: BASE_SCORES.campaign_hint + (isNew ? 5 : 0),
        confidence: "medium",
        freshness: "fresh",
        surfaces: ["create_content"],
        suggestedContentType: "listing",
        suggestedCampaignType: "just_listed",
        suggestedChannel: null,
        actionLabel: "Launch Campaign Instead",
        actionPayload: {
          action: "openListingCampaign",
          sourceType: "listing",
          sourceId: source.id,
          campaignType: "just_listed",
          listingDataItemId: source.id,
        },
        reasons: ["New listing detected", "This property is well-suited for a multi-post campaign"],
        evaluatedAt: ctx.now.toISOString(),
      });
    }
  }

  // ── Price Drop Campaigns ──
  for (const item of ctx.topUnusedItems) {
    if (item.type !== "PROPERTY" && item.type !== "CUSTOM") continue;

    // Check for price_drop via _events first, then fall back to tag check
    const events = item.dataJson?._events || [];
    const priceDrop = events.find((e) => e.type === "price_drop");
    const tags = item.dataJson?.tags ?? [];
    const isPriceDropTag = Array.isArray(tags) && tags.some((t) =>
      typeof t === "string" && (t.includes("price_drop") || t.includes("price_reduced"))
    );
    if (!priceDrop && !isPriceDropTag) continue;

    const campUsage = campaignUsageBySource.get(item.id);
    if (campUsage?.campaignTypes?.has("price_drop")) continue; // Already has price drop campaign

    const label = item.dataJson?.street || item.dataJson?.address || item.title;
    let score = BASE_SCORES.price_drop_campaign;
    if (campUsage?.hasCampaign) score -= 15; // Has another type of campaign

    // Build richer description if event data is available
    const dropInfo = priceDrop?.data;
    const description = dropInfo
      ? `Price dropped $${Number(dropInfo.dropAmount).toLocaleString()} (${dropInfo.dropPercent}%) — create urgency with a price reduction campaign.`
      : "Create urgency with a price reduction campaign across multiple posts.";
    const title = dropInfo
      ? `Price dropped $${Number(dropInfo.dropAmount).toLocaleString()} on ${label}`
      : `Launch a Price Drop campaign for ${label}`;

    const reasons = [];
    if (dropInfo) {
      reasons.push(`Price reduced from $${Number(dropInfo.oldPrice).toLocaleString()} to $${Number(dropInfo.newPrice).toLocaleString()}`);
    } else {
      reasons.push("Recent price update detected");
    }
    reasons.push("Price drops generate urgency and engagement");

    candidates.push({
      id: `price_drop_campaign:${item.id}`,
      type: "price_drop_campaign",
      title,
      description,
      sourceType: "listing",
      sourceId: item.id,
      sourceLabel: label,
      priorityScore: Math.max(score, 10),
      confidence: dropInfo ? "high" : "medium",
      freshness: "fresh",
      surfaces: ["dashboard", "listing_campaign"],
      suggestedContentType: "listing",
      suggestedCampaignType: "price_drop",
      suggestedChannel: null,
      actionLabel: "Launch Campaign",
      actionPayload: {
        action: "openListingCampaign",
        sourceType: "listing",
        sourceId: item.id,
        campaignType: "price_drop",
        listingDataItemId: item.id,
      },
      reasons,
      hasCampaign: campUsage?.hasCampaign ?? false,
      campaignCount: campUsage?.campaignCount ?? 0,
      lastCampaignAt: campUsage?.lastCampaignAt?.toISOString() ?? null,
      evaluatedAt: ctx.now.toISOString(),
    });
  }

  // ── Open House Campaigns ──
  for (const item of ctx.topUnusedItems) {
    if (item.type !== "PROPERTY" && item.type !== "CUSTOM" && item.type !== "EVENT") continue;
    const tags = item.dataJson?.tags ?? [];
    const isOpenHouse = (item.type === "EVENT" && item.dataJson?.eventName?.toLowerCase()?.includes("open house"))
      || (Array.isArray(tags) && tags.some((t) =>
        typeof t === "string" && (t.includes("open_house") || t.includes("openhouse"))
      ))
      || item.dataJson?.openHouseDate;
    if (!isOpenHouse) continue;

    const campUsage = campaignUsageBySource.get(item.id);
    if (campUsage?.campaignTypes?.has("open_house")) continue;

    const label = item.dataJson?.address || item.dataJson?.eventName || item.title;
    let score = BASE_SCORES.open_house_campaign;
    if (campUsage?.hasCampaign) score -= 15;

    candidates.push({
      id: `open_house_campaign:${item.id}`,
      type: "open_house_campaign",
      title: `Launch an Open House campaign for ${label}`,
      description: "Drive attendance with a targeted multi-post campaign leading up to the open house.",
      sourceType: "listing",
      sourceId: item.id,
      sourceLabel: label,
      priorityScore: Math.max(score, 10),
      confidence: "medium",
      freshness: "fresh",
      surfaces: ["dashboard", "listing_campaign"],
      suggestedContentType: "listing",
      suggestedCampaignType: "open_house",
      suggestedChannel: null,
      actionLabel: "Launch Campaign",
      actionPayload: {
        action: "openListingCampaign",
        sourceType: "listing",
        sourceId: item.id,
        campaignType: "open_house",
        listingDataItemId: item.id,
      },
      reasons: ["Open house detected", "Multi-post campaigns drive higher attendance"],
      hasCampaign: campUsage?.hasCampaign ?? false,
      campaignCount: campUsage?.campaignCount ?? 0,
      lastCampaignAt: campUsage?.lastCampaignAt?.toISOString() ?? null,
      evaluatedAt: ctx.now.toISOString(),
    });
  }

  return candidates;
}

/**
 * Build property library recommendations — nudge users to act on saved properties
 * and generate market/neighborhood content from aggregate listing data.
 */
function buildPropertyLibraryCandidates(ctx) {
  const candidates = [];
  const { reAssets, enabledChannels, industryKey, campaignUsageBySource, now } = ctx;

  if (industryKey !== "real_estate" || !reAssets) return candidates;

  const allListings = reAssets.listings ?? [];
  if (allListings.length === 0) return candidates;

  const hasFB = enabledChannels.some((c) => c.channel === "FACEBOOK");
  const hasIG = enabledChannels.some((c) => c.channel === "INSTAGRAM");

  // ── Saved properties without any campaign ──
  const noCampaignListings = allListings.filter((entry) => {
    const campUsage = campaignUsageBySource.get(entry.source.id);
    return !(campUsage?.hasCampaign);
  });

  // Nudge for unused properties (up to 3 — avoid noise)
  for (const entry of noCampaignListings.slice(0, 3)) {
    const listing = entry.normalized;
    const source = entry.source;
    const label = listing.title || listing.address || "a saved property";
    const isNew = source.createdAt && (now - new Date(source.createdAt)) < 3 * DAY_MS;
    const isUnused = (source.usageCount ?? 0) === 0;

    if (!isUnused) continue; // Only suggest for truly unused properties

    candidates.push({
      id: `unpromoted_listing:${source.id}`,
      type: "unpromoted_listing",
      title: `Create content for ${label}`,
      description: "This saved property doesn't have any campaigns or posts yet — use it for a listing post or full campaign.",
      sourceType: "listing",
      sourceId: source.id,
      sourceLabel: label,
      priorityScore: BASE_SCORES.unpromoted_listing + (isNew ? 5 : 0),
      confidence: listing.completenessScore >= 3 ? "high" : "medium",
      freshness: isNew ? "fresh" : "recent",
      surfaces: ["dashboard", "listing_campaign", "create_content"],
      suggestedContentType: "listing",
      suggestedCampaignType: "just_listed",
      suggestedChannel: hasFB ? "FACEBOOK" : hasIG ? "INSTAGRAM" : null,
      actionLabel: "Launch Campaign",
      actionPayload: {
        action: "openListingCampaign",
        sourceType: "listing",
        sourceId: source.id,
        campaignType: "just_listed",
        listingDataItemId: source.id,
      },
      reasons: [
        "Saved to your property library",
        "No campaigns or posts created yet",
        ...(isNew ? ["Recently added"] : []),
      ],
      evaluatedAt: now.toISOString(),
    });
  }

  // ── Neighborhood / Market post from aggregate property data ──
  // Only suggest if user has 2+ saved properties (enough for a market narrative)
  if (allListings.length >= 2) {
    // Gather market signals
    const cities = new Set();
    const zips = new Set();
    let activeCount = 0;
    let totalPrice = 0;
    let priceCount = 0;

    for (const entry of allListings) {
      const d = entry.source.dataJson ?? {};
      if (d.city) cities.add(d.city);
      if (d.zip) zips.add(d.zip);
      const status = (d.status ?? "").toLowerCase();
      if (status === "active" || status === "coming_soon") activeCount++;
      if (typeof d.price === "number") {
        totalPrice += d.price;
        priceCount++;
      }
    }

    const avgPrice = priceCount > 0 ? Math.round(totalPrice / priceCount) : null;
    const areaLabel = cities.size === 1
      ? [...cities][0]
      : zips.size === 1
        ? `ZIP ${[...zips][0]}`
        : cities.size <= 3
          ? [...cities].join(", ")
          : "your market area";

    const description = avgPrice
      ? `You have ${allListings.length} properties saved in ${areaLabel} — avg price $${avgPrice.toLocaleString()}. Create a market update post showcasing local activity.`
      : `You have ${allListings.length} properties saved in ${areaLabel}. Create a market update post showcasing local activity.`;

    const reasons = [
      `${allListings.length} properties saved in your library`,
      ...(activeCount > 0 ? [`${activeCount} currently active`] : []),
      "Market posts build authority and engagement",
    ];

    candidates.push({
      id: "neighborhood_post:library",
      type: "neighborhood_post",
      title: `Create a market update for ${areaLabel}`,
      description,
      sourceType: "listing",
      sourceId: null,
      sourceLabel: areaLabel,
      priorityScore: BASE_SCORES.neighborhood_post,
      confidence: allListings.length >= 4 ? "high" : "medium",
      freshness: "recent",
      surfaces: ["dashboard", "create_content", "planner"],
      suggestedContentType: "listing",
      suggestedCampaignType: null,
      suggestedChannel: hasFB ? "FACEBOOK" : hasIG ? "INSTAGRAM" : null,
      actionLabel: "Create Post",
      actionPayload: {
        action: "open_create_content",
        guidance: `Create a market update post for ${areaLabel}. You have ${allListings.length} properties to reference — highlight pricing trends, inventory activity, and what it means for buyers/sellers.`,
        templateType: "market_update",
      },
      reasons,
      evaluatedAt: now.toISOString(),
    });
  }

  return candidates;
}

/**
 * Build recommendation candidates from cached nearby RentCast listings.
 * Reads sp:nearby:{clientId} written by the listings search endpoint.
 * Only surfaces listings that haven't been saved yet.
 */
function buildNearbyListingCandidates(ctx) {
  const candidates = [];
  const { nearbyListings, topUnusedItems, now } = ctx;

  if (!nearbyListings || !Array.isArray(nearbyListings) || nearbyListings.length === 0) return candidates;

  // Build set of saved provider IDs to exclude already-saved listings
  const savedProviderIds = new Set();
  for (const item of topUnusedItems) {
    const d = item.dataJson ?? {};
    if (d.providerId) savedProviderIds.add(String(d.providerId));
  }

  const unsaved = nearbyListings.filter(
    (l) => l.providerId && !savedProviderIds.has(String(l.providerId))
  );

  // Top 3 by price (highest value = most marketing-worthy)
  const sorted = [...unsaved].sort((a, b) => (b.price ?? 0) - (a.price ?? 0)).slice(0, 3);

  for (const listing of sorted) {
    const addr = listing.formattedAddress || listing.street || "Nearby property";
    const specs = [
      listing.bedrooms != null ? `${listing.bedrooms} bd` : null,
      listing.bathrooms != null ? `${listing.bathrooms} ba` : null,
      listing.sqft != null ? `${Number(listing.sqft).toLocaleString()} sqft` : null,
    ].filter(Boolean).join(" / ");
    const priceStr = listing.price ? "$" + listing.price.toLocaleString() : "";
    const descParts = [priceStr, specs].filter(Boolean).join(" — ");

    candidates.push({
      id: `nearby_listing:${listing.providerId}`,
      type: "listing_campaign",
      title: `New listing near you: ${addr}`,
      description: descParts
        ? `${descParts}. Create a campaign to market this property.`
        : "Create a campaign to market this property.",
      sourceType: "nearby_listing",
      sourceId: null,
      sourceLabel: addr,
      priorityScore: BASE_SCORES.listing_campaign - 10,
      confidence: "medium",
      freshness: "fresh",
      surfaces: ["dashboard", "listing_campaign"],
      suggestedContentType: "listing",
      suggestedCampaignType: "just_listed",
      suggestedChannel: null,
      actionLabel: "Launch Campaign",
      actionPayload: {
        action: "openListingCampaign",
        nearbyListing: listing,
      },
      reasons: [
        "Active listing found in your market area",
        ...(listing.daysOnMarket != null && listing.daysOnMarket <= 3 ? ["Just hit the market"] : []),
        ...(listing.price >= 500000 ? ["High-value property"] : []),
      ],
      evaluatedAt: now.toISOString(),
    });
  }

  return candidates;
}

/**
 * Build event-driven recommendation candidates from listing _events.
 * Scans topUnusedItems for recent events and produces actionable recommendations.
 */
function buildEventDrivenCandidates(ctx) {
  const candidates = [];
  const { topUnusedItems, campaignUsageBySource, now } = ctx;
  const SEVEN_DAYS = 7 * DAY_MS;
  const FOURTEEN_DAYS = 14 * DAY_MS;

  for (const item of topUnusedItems) {
    if (item.type !== "PROPERTY" && item.type !== "CUSTOM") continue;
    const events = item.dataJson?._events || [];
    if (events.length === 0) continue;

    const label = item.dataJson?.street || item.dataJson?.address || item.title;
    const campUsage = campaignUsageBySource.get(item.id);

    // Price drop alert — recent price_drop events (last 7 days)
    const recentPriceDrop = events.find(
      (e) => e.type === "price_drop" && (now - new Date(e.detectedAt)) < SEVEN_DAYS
    );
    if (recentPriceDrop && !campUsage?.campaignTypes?.has("price_drop")) {
      const { dropAmount, dropPercent, oldPrice, newPrice } = recentPriceDrop.data || {};
      candidates.push({
        id: `price_drop_alert:${item.id}`,
        type: "price_drop_alert",
        title: dropAmount
          ? `Price dropped $${Number(dropAmount).toLocaleString()} on ${label}`
          : `Price drop detected on ${label}`,
        description: dropAmount
          ? `Reduced ${dropPercent}% from $${Number(oldPrice).toLocaleString()} to $${Number(newPrice).toLocaleString()} — launch a campaign to generate urgency.`
          : "A price reduction was detected — create a targeted campaign.",
        sourceType: "listing",
        sourceId: item.id,
        sourceLabel: label,
        priorityScore: Math.max(BASE_SCORES.price_drop_alert - (campUsage?.hasCampaign ? 15 : 0), 10),
        confidence: "high",
        freshness: "fresh",
        surfaces: ["dashboard", "listing_campaign"],
        suggestedCampaignType: "price_drop",
        actionLabel: "Launch Price Drop Campaign",
        actionPayload: {
          action: "openListingCampaign",
          campaignType: "price_drop",
          listingDataItemId: item.id,
        },
        reasons: [
          dropAmount ? `Price reduced $${Number(dropAmount).toLocaleString()} (${dropPercent}%)` : "Price drop detected",
          "Price drop campaigns generate urgency and engagement",
        ],
        evaluatedAt: now.toISOString(),
      });
    }

    // Not promoted — listing active but never used for content
    const notPromoted = events.find((e) => e.type === "not_promoted");
    if (notPromoted) {
      const daysActive = notPromoted.data?.daysActive || 0;
      candidates.push({
        id: `unpromoted_listing:${item.id}`,
        type: "unpromoted_listing",
        title: `${label} has no content yet`,
        description: `This listing has been active for ${daysActive} days without any posts or campaigns. Create content to boost visibility.`,
        sourceType: "listing",
        sourceId: item.id,
        sourceLabel: label,
        priorityScore: BASE_SCORES.unpromoted_listing,
        confidence: "medium",
        freshness: "evergreen",
        surfaces: ["dashboard"],
        actionLabel: "Create Content",
        actionPayload: {
          action: "openListingCampaign",
          campaignType: "just_listed",
          listingDataItemId: item.id,
        },
        reasons: [`Active for ${daysActive} days with no content`, "Every listing should have at least one campaign"],
        evaluatedAt: now.toISOString(),
      });
    }

    // Stale listing — active too long, needs fresh content
    const recentStale = events.find(
      (e) => e.type === "stale_listing" && (now - new Date(e.detectedAt)) < FOURTEEN_DAYS
    );
    if (recentStale) {
      const daysActive = recentStale.data?.daysActive || 0;
      candidates.push({
        id: `stale_listing_refresh:${item.id}`,
        type: "stale_listing_refresh",
        title: `${label} has been active for ${daysActive} days`,
        description: `This listing has been active for ${daysActive} days — create a fresh post to reignite interest.`,
        sourceType: "listing",
        sourceId: item.id,
        sourceLabel: label,
        priorityScore: BASE_SCORES.stale_listing_refresh,
        confidence: "medium",
        freshness: "fresh",
        surfaces: ["dashboard"],
        actionLabel: "Create Fresh Post",
        actionPayload: {
          action: "openListingCampaign",
          campaignType: "listing_spotlight",
          listingDataItemId: item.id,
        },
        reasons: [`Active for ${daysActive} days`, "Fresh content can reignite buyer interest"],
        evaluatedAt: now.toISOString(),
      });
    }
  }

  return candidates;
}

function buildMilestoneCandidates(ctx) {
  const candidates = [];
  const { reAssets, enabledChannels, industryKey, topUnusedItems, campaignUsageBySource } = ctx;

  // From RE assets
  if (industryKey === "real_estate" && reAssets?.bestMilestone && reAssets?.bestMilestoneSource) {
    const ms = reAssets.bestMilestone;
    const source = reAssets.bestMilestoneSource;
    const label = ms.address || ms.achievement || source.title || "a recent sale";
    const isNew = source.createdAt && (ctx.now - new Date(source.createdAt)) < 7 * DAY_MS;
    const isUnused = (source.usageCount ?? 0) === 0;

    // Campaign suppression
    const campUsage = campaignUsageBySource.get(source.id);
    const hasJustSoldCampaign = campUsage?.campaignTypes?.has("just_sold") ?? false;
    const hasActiveCampaign = (campUsage?.activeCampaigns ?? 0) > 0;

    const reasons = [];
    if (isNew) reasons.push("Closed deal imported recently");
    if (isUnused) reasons.push("No content created from this milestone yet");
    if (!campUsage?.hasCampaign) reasons.push("No campaign launched yet");
    reasons.push("Just Sold campaigns are high-performing content");

    const hasFB = enabledChannels.some((c) => c.channel === "FACEBOOK");
    const hasIG = enabledChannels.some((c) => c.channel === "INSTAGRAM");
    const targetChannel = hasFB ? "FACEBOOK" : hasIG ? "INSTAGRAM" : enabledChannels[0]?.channel;

    // Milestone campaign — suppress if already has just_sold campaign
    if (!hasJustSoldCampaign) {
      let score = BASE_SCORES.milestone_campaign + (isNew ? 5 : 0) + (isUnused ? 3 : 0);
      if (hasActiveCampaign) score -= 20;

      candidates.push({
        id: `milestone_campaign:${source.id}`,
        type: "milestone_campaign",
        title: `Create a Just Sold campaign for ${label}`,
        description: "Celebrate your closed deal with a coordinated multi-post campaign — build trust and attract new clients.",
        sourceType: "milestone",
        sourceId: source.id,
        sourceLabel: label,
        priorityScore: Math.max(score, 10),
        confidence: "high",
        freshness: isNew ? "fresh" : "recent",
        surfaces: ["dashboard", "listing_campaign"],
        suggestedContentType: "personal",
        suggestedCampaignType: "just_sold",
        suggestedChannel: targetChannel,
        actionLabel: "Launch Campaign",
        actionPayload: {
          action: "openListingCampaign",
          sourceType: "milestone",
          sourceId: source.id,
          campaignType: "just_sold",
          listingDataItemId: source.id,
        },
        reasons,
        hasCampaign: campUsage?.hasCampaign ?? false,
        campaignCount: campUsage?.campaignCount ?? 0,
        lastCampaignAt: campUsage?.lastCampaignAt?.toISOString() ?? null,
        evaluatedAt: ctx.now.toISOString(),
      });
    }

    // Milestone post
    if (targetChannel) {
      candidates.push({
        id: `milestone_post:${source.id}`,
        type: "milestone_post",
        title: `Celebrate your sale at ${label}`,
        description: ms.price
          ? `Just Sold post for this ${ms.dealType?.toLowerCase() || "sale"}${ms.closingDate ? ` closed on ${ms.closingDate}` : ""}.`
          : "Create a Just Sold post to celebrate and attract new clients.",
        sourceType: "milestone",
        sourceId: source.id,
        sourceLabel: label,
        priorityScore: BASE_SCORES.milestone_post + (isNew ? 5 : 0) + (isUnused ? 3 : 0),
        confidence: "high",
        freshness: isNew ? "fresh" : "recent",
        surfaces: ["dashboard", "create_content"],
        suggestedContentType: "personal",
        suggestedCampaignType: null,
        suggestedChannel: targetChannel,
        actionLabel: "Create Just Sold Post",
        actionPayload: {
          action: "open_create_content",
          guidance: `Create a "Just Sold" celebration post for the property at ${label}. Emphasize success and invite new clients.`,
          templateType: "milestone_post",
          dataItemId: source.id,
          channel: targetChannel,
        },
        reasons,
        evaluatedAt: ctx.now.toISOString(),
      });
    }
  }

  // Also check topUnusedItems for milestones (non-RE or additional milestones)
  for (const item of topUnusedItems) {
    if (item.type !== "MILESTONE") continue;
    if (reAssets?.bestMilestoneSource?.id === item.id) continue;

    const campUsage = campaignUsageBySource.get(item.id);
    const hasJustSoldCampaign = campUsage?.campaignTypes?.has("just_sold") ?? false;
    const label = item.dataJson?.address || item.dataJson?.achievement || item.title;

    // Milestone campaign for additional milestones
    if (!hasJustSoldCampaign) {
      let score = BASE_SCORES.milestone_campaign - 5;
      if (campUsage?.hasCampaign) score -= 20;

      candidates.push({
        id: `milestone_campaign:${item.id}`,
        type: "milestone_campaign",
        title: `Create a Just Sold campaign for ${label}`,
        description: "Celebrate and build trust with a multi-post campaign.",
        sourceType: "milestone",
        sourceId: item.id,
        sourceLabel: label,
        priorityScore: Math.max(score, 10),
        confidence: "medium",
        freshness: "recent",
        surfaces: ["dashboard", "listing_campaign"],
        suggestedContentType: "personal",
        suggestedCampaignType: "just_sold",
        suggestedChannel: null,
        actionLabel: "Launch Campaign",
        actionPayload: {
          action: "openListingCampaign",
          sourceType: "milestone",
          sourceId: item.id,
          campaignType: "just_sold",
          listingDataItemId: item.id,
        },
        reasons: ["No campaign launched for this milestone yet"],
        hasCampaign: campUsage?.hasCampaign ?? false,
        campaignCount: campUsage?.campaignCount ?? 0,
        lastCampaignAt: campUsage?.lastCampaignAt?.toISOString() ?? null,
        evaluatedAt: ctx.now.toISOString(),
      });
    }

    // Milestone post
    candidates.push({
      id: `milestone_post:${item.id}`,
      type: "milestone_post",
      title: `Celebrate your sale at ${label}`,
      description: "Create a Just Sold post to build credibility",
      sourceType: "milestone",
      sourceId: item.id,
      sourceLabel: label,
      priorityScore: BASE_SCORES.milestone_post,
      confidence: "medium",
      freshness: "recent",
      surfaces: ["dashboard", "create_content"],
      suggestedContentType: "personal",
      suggestedCampaignType: null,
      suggestedChannel: null,
      actionLabel: "Create Post",
      actionPayload: {
        action: "open_create_content",
        guidance: `Create a "Just Sold" celebration post for ${label}. Emphasize success and invite new clients.`,
        templateType: "milestone_post",
        dataItemId: item.id,
      },
      reasons: ["No content created from this milestone yet"],
      evaluatedAt: ctx.now.toISOString(),
    });
  }

  return candidates;
}

function buildTestimonialCandidates(ctx) {
  const candidates = [];
  const { reAssets, topUnusedItems, enabledChannels, gbpSignals } = ctx;

  // From RE assets
  if (reAssets?.reviewCount > 0) {
    const hasIG = enabledChannels.some((c) => c.channel === "INSTAGRAM");
    const hasFB = enabledChannels.some((c) => c.channel === "FACEBOOK");
    const targetChannel = hasIG ? "INSTAGRAM" : hasFB ? "FACEBOOK" : enabledChannels[0]?.channel;

    // Find unused testimonial from topUnusedItems
    const bestReview = topUnusedItems.find((r) => r.type === "TESTIMONIAL");
    if (bestReview && targetChannel) {
      const quote = bestReview.dataJson?.quote || bestReview.summary || null;
      const author = bestReview.dataJson?.author || bestReview.dataJson?.name || null;

      const reasons = ["Real client reviews are powerful social proof"];
      if ((bestReview.usageCount ?? 0) === 0) reasons.push("This review is unused");
      const rating = bestReview.dataJson?.rating;
      if (rating && Number(rating) >= 5) reasons.push("5-star review");

      // Boost when GBP has recent new reviews
      const gbpRecencyBoost = gbpSignals?.hasGBP && gbpSignals.recentNewReviews > 0 ? 8 : 0;
      if (gbpRecencyBoost > 0) reasons.push("New Google review received");

      candidates.push({
        id: `testimonial_post:${bestReview.id}`,
        type: "testimonial_post",
        title: author ? `Share ${author}'s review` : "Turn a client review into a post",
        description: quote
          ? `"${quote.length > 80 ? quote.slice(0, 77) + "..." : quote}" — build trust with social proof.`
          : "Testimonial posts build trust and credibility.",
        sourceType: "testimonial",
        sourceId: bestReview.id,
        sourceLabel: author || "Client review",
        priorityScore: BASE_SCORES.testimonial_post
          + (Number(rating) >= 5 ? 5 : 0)
          + ((bestReview.usageCount ?? 0) === 0 ? 3 : 0)
          + gbpRecencyBoost,
        confidence: quote ? "high" : "medium",
        freshness: "recent",
        surfaces: ["dashboard", "create_content"],
        suggestedContentType: "testimonial",
        suggestedCampaignType: null,
        suggestedChannel: targetChannel,
        actionLabel: "Create Testimonial Post",
        actionPayload: {
          action: "open_create_content",
          guidance: quote
            ? `Create a social proof post featuring this client review: "${quote}"${author ? ` from ${author}` : ""}. Build trust and encourage inquiries.`
            : "Create a testimonial post using a real client review. Quote accurately and build trust.",
          templateType: "client_testimonial",
          dataItemId: bestReview.id,
          channel: targetChannel,
        },
        reasons,
        evaluatedAt: ctx.now.toISOString(),
      });
    }
  }

  return candidates;
}

function buildSchedulingCandidates(ctx) {
  const candidates = [];
  const { publishedThisWeek, scheduledUpcoming, enabledChannels, statusMap, recentPublished } = ctx;

  // Low posting frequency
  if (recentPublished < 3 && enabledChannels.length > 0) {
    candidates.push({
      id: "scheduling:low_frequency",
      type: "scheduling_action",
      title: publishedThisWeek === 0 ? "Start your week strong" : "Post more frequently",
      description: publishedThisWeek === 0
        ? "You haven't published anything this week. Consistent posting drives growth."
        : `Only ${publishedThisWeek} post${publishedThisWeek === 1 ? "" : "s"} this week. Aim for 3-5 per week.`,
      sourceType: "system",
      sourceId: null,
      sourceLabel: "Posting cadence",
      priorityScore: BASE_SCORES.scheduling_action + (publishedThisWeek === 0 ? 10 : 0),
      confidence: "high",
      freshness: "fresh",
      surfaces: ["dashboard", "create_content"],
      suggestedContentType: null,
      suggestedCampaignType: null,
      suggestedChannel: null,
      actionLabel: "Generate content",
      actionPayload: { action: "open_create_content" },
      reasons: [
        publishedThisWeek === 0
          ? "No posts published this week"
          : `Only ${publishedThisWeek} of 5 target posts this week`,
        "Consistent posting keeps your audience engaged",
      ],
      evaluatedAt: ctx.now.toISOString(),
    });
  }

  // Nothing scheduled
  if (scheduledUpcoming === 0 && enabledChannels.length > 0) {
    candidates.push({
      id: "scheduling:nothing_scheduled",
      type: "scheduling_action",
      title: "No posts scheduled",
      description: "Keep your content pipeline full by scheduling upcoming posts.",
      sourceType: "system",
      sourceId: null,
      sourceLabel: "Schedule",
      priorityScore: BASE_SCORES.scheduling_action - 5,
      confidence: "high",
      freshness: "fresh",
      surfaces: ["dashboard"],
      suggestedContentType: null,
      suggestedCampaignType: null,
      suggestedChannel: null,
      actionLabel: "Open planner",
      actionPayload: { action: "open_planner" },
      reasons: ["No upcoming posts scheduled", "Planning ahead ensures consistent visibility"],
      evaluatedAt: ctx.now.toISOString(),
    });
  }

  // Pending review backlog
  const pendingCount = statusMap.PENDING_REVIEW ?? 0;
  if (pendingCount >= 5) {
    candidates.push({
      id: "scheduling:review_backlog",
      type: "scheduling_action",
      title: `${pendingCount} drafts awaiting review`,
      description: "Review and approve your pending drafts to keep your content pipeline moving.",
      sourceType: "system",
      sourceId: null,
      sourceLabel: "Review queue",
      priorityScore: BASE_SCORES.scheduling_action + 5,
      confidence: "high",
      freshness: "fresh",
      surfaces: ["dashboard"],
      suggestedContentType: null,
      suggestedCampaignType: null,
      suggestedChannel: null,
      actionLabel: "Review drafts",
      actionPayload: { action: "open_drafts", status: "PENDING_REVIEW" },
      reasons: [`${pendingCount} drafts need your attention`],
      evaluatedAt: ctx.now.toISOString(),
    });
  }

  // Approved but not scheduled
  const approvedCount = statusMap.APPROVED ?? 0;
  if (approvedCount >= 3) {
    candidates.push({
      id: "scheduling:schedule_approved",
      type: "scheduling_action",
      title: `${approvedCount} approved drafts ready to schedule`,
      description: "Schedule your approved content for consistent publishing.",
      sourceType: "system",
      sourceId: null,
      sourceLabel: "Approved drafts",
      priorityScore: BASE_SCORES.scheduling_action,
      confidence: "high",
      freshness: "fresh",
      surfaces: ["dashboard"],
      suggestedContentType: null,
      suggestedCampaignType: null,
      suggestedChannel: null,
      actionLabel: "Schedule drafts",
      actionPayload: { action: "open_planner" },
      reasons: [`${approvedCount} approved drafts waiting to be scheduled`],
      evaluatedAt: ctx.now.toISOString(),
    });
  }

  // Inactivity
  if (ctx.daysSinceLastGeneration !== null && ctx.daysSinceLastGeneration >= 3 && enabledChannels.length > 0) {
    candidates.push({
      id: "scheduling:inactivity",
      type: "scheduling_action",
      title: `No content in ${ctx.daysSinceLastGeneration} days`,
      description: "Consistent posting keeps your audience engaged. Generate fresh content.",
      sourceType: "system",
      sourceId: null,
      sourceLabel: "Inactivity",
      priorityScore: BASE_SCORES.scheduling_action + 18,
      confidence: "high",
      freshness: "fresh",
      surfaces: ["dashboard"],
      suggestedContentType: null,
      suggestedCampaignType: null,
      suggestedChannel: null,
      actionLabel: "Generate content",
      actionPayload: { action: "open_create_content" },
      reasons: [`${ctx.daysSinceLastGeneration} days since last content generation`],
      evaluatedAt: ctx.now.toISOString(),
    });
  }

  return candidates;
}

function buildAutopilotCandidates(ctx) {
  const candidates = [];
  const { autopilotStatus, enabledChannels, totalDataItems } = ctx;

  if (!autopilotStatus || enabledChannels.length === 0) return candidates;

  const isEnabled = autopilotStatus.enabled ?? false;
  const isReady = totalDataItems >= 3 && enabledChannels.length >= 1;

  if (!isEnabled && isReady) {
    candidates.push({
      id: "autopilot:enable",
      type: "autopilot_action",
      title: "Turn on Autopilot",
      description: "Your system has enough data to auto-generate content. Let Autopilot fill your pipeline.",
      sourceType: "system",
      sourceId: null,
      sourceLabel: "Autopilot",
      priorityScore: BASE_SCORES.autopilot_action + 10,
      confidence: "high",
      freshness: "fresh",
      surfaces: ["dashboard"],
      suggestedContentType: null,
      suggestedCampaignType: null,
      suggestedChannel: null,
      actionLabel: "Enable Autopilot",
      actionPayload: { action: "open_autopilot" },
      reasons: [
        "Your system has enough data to auto-generate",
        `${totalDataItems} data items + ${enabledChannels.length} channel${enabledChannels.length > 1 ? "s" : ""} connected`,
      ],
      evaluatedAt: ctx.now.toISOString(),
    });
  }

  return candidates;
}

function buildIntegrationCandidates(ctx) {
  const candidates = [];
  const { enabledChannels, totalDataItems, realEstateContext, industryKey } = ctx;

  // No channels
  if (enabledChannels.length === 0) {
    candidates.push({
      id: "integration:no_channels",
      type: "integration_action",
      title: "Connect a platform",
      description: "You haven't enabled any channels. Connect at least one to start publishing.",
      sourceType: "system",
      sourceId: null,
      sourceLabel: "Channels",
      priorityScore: BASE_SCORES.integration_action + 45, // High priority — blocks core value
      confidence: "high",
      freshness: "fresh",
      surfaces: ["dashboard"],
      suggestedContentType: null,
      suggestedCampaignType: null,
      suggestedChannel: null,
      actionLabel: "Set up channels",
      actionPayload: { action: "open_settings", route: "settings/media" },
      reasons: ["No channels connected — this blocks publishing"],
      evaluatedAt: ctx.now.toISOString(),
    });
  }

  // No business data
  if (totalDataItems === 0) {
    candidates.push({
      id: "integration:no_data",
      type: "integration_action",
      title: "Add business data",
      description: "Add testimonials, stats, or milestones to generate smarter, data-driven content.",
      sourceType: "system",
      sourceId: null,
      sourceLabel: "Business data",
      priorityScore: BASE_SCORES.integration_action + 30,
      confidence: "high",
      freshness: "fresh",
      surfaces: ["dashboard"],
      suggestedContentType: null,
      suggestedCampaignType: null,
      suggestedChannel: null,
      actionLabel: "Add data",
      actionPayload: { action: "open_data" },
      reasons: ["No business data available", "Data-driven content performs 2-3x better"],
      evaluatedAt: ctx.now.toISOString(),
    });
  }

  // Listing feed not connected (real estate only)
  if (industryKey === "real_estate" && realEstateContext) {
    const feedConnected = realEstateContext.techStack?.listingFeed?.status === "connected";
    if (!feedConnected) {
      candidates.push({
        id: "integration:listing_feed",
        type: "integration_action",
        title: "Add your listings page",
        description: "Connect your listings page to automatically import properties for content.",
        sourceType: "system",
        sourceId: null,
        sourceLabel: "Listing feed",
        priorityScore: BASE_SCORES.integration_action + 28,
        confidence: "high",
        freshness: "fresh",
        surfaces: ["dashboard"],
        suggestedContentType: null,
        suggestedCampaignType: null,
        suggestedChannel: null,
        actionLabel: "Set Up Listing Feeds",
        actionPayload: { action: "open_settings", route: "settings/tech-stack" },
        reasons: ["Listing data powers campaigns and property posts"],
        evaluatedAt: ctx.now.toISOString(),
      });
    }
  }

  return candidates;
}

function buildGBPCandidates(ctx) {
  const candidates = [];
  const { gbpSignals } = ctx;

  // Suggest replying to unreplied reviews
  if (gbpSignals?.hasGBP && gbpSignals.unrepliedCount > 0) {
    candidates.push({
      id: "gbp:unreplied_review",
      type: "gbp_reply",
      title: `Reply to ${gbpSignals.unrepliedCount} unreplied review${gbpSignals.unrepliedCount === 1 ? "" : "s"}`,
      description: "Responding to reviews builds trust and improves your Google ranking.",
      sourceType: "system",
      sourceId: null,
      sourceLabel: "Google Business Profile",
      priorityScore: BASE_SCORES.integration_action + 35,
      confidence: "high",
      freshness: "fresh",
      surfaces: ["dashboard"],
      suggestedContentType: null,
      suggestedCampaignType: null,
      suggestedChannel: null,
      actionLabel: "Reply to Reviews",
      actionPayload: { action: "draft_gbp_reply" },
      reasons: [
        `You have ${gbpSignals.unrepliedCount} unreplied review${gbpSignals.unrepliedCount === 1 ? "" : "s"} — responding builds trust`,
        "Google favors businesses that engage with reviewers",
      ],
      evaluatedAt: ctx.now.toISOString(),
    });
  }

  // Strong theme detected — when a theme appears in 3+ reviews
  if (gbpSignals?.hasGBP && gbpSignals.topThemes?.length > 0) {
    const strongTheme = gbpSignals.topThemes.find((t) => t.count >= 3);
    if (strongTheme) {
      candidates.push({
        id: `gbp:strong_theme:${strongTheme.theme}`,
        type: "testimonial_post",
        title: `Your clients keep mentioning "${strongTheme.theme}"`,
        description: `"${strongTheme.theme}" appears in ${strongTheme.count} reviews — turn this recurring praise into content.`,
        sourceType: "system",
        sourceId: null,
        sourceLabel: "Google Business Profile",
        priorityScore: BASE_SCORES.testimonial_post + 12,
        confidence: "high",
        freshness: "fresh",
        surfaces: ["dashboard", "create_content"],
        suggestedContentType: "testimonial",
        suggestedCampaignType: null,
        suggestedChannel: null,
        actionLabel: "Create Theme Post",
        actionPayload: {
          action: "open_create_content",
          guidance: `Create content highlighting your "${strongTheme.theme}" reputation — ${strongTheme.count} clients have praised this. Use real quotes for authenticity.`,
          templateType: "client_testimonial",
        },
        reasons: [
          `"${strongTheme.theme}" appears in ${strongTheme.count} reviews`,
          "Recurring themes make compelling, authentic content",
        ],
        evaluatedAt: ctx.now.toISOString(),
      });
    }
  }

  // Multiple recent reviews — review surge
  if (gbpSignals?.hasGBP && gbpSignals.recentNewReviews >= 3) {
    candidates.push({
      id: "gbp:recent_review_surge",
      type: "testimonial_post",
      title: `You've received ${gbpSignals.recentNewReviews} new reviews this week`,
      description: "A burst of reviews is perfect for social proof content — capitalize on the momentum.",
      sourceType: "system",
      sourceId: null,
      sourceLabel: "Google Business Profile",
      priorityScore: BASE_SCORES.testimonial_post + 10,
      confidence: "high",
      freshness: "fresh",
      surfaces: ["dashboard", "create_content"],
      suggestedContentType: "testimonial",
      suggestedCampaignType: null,
      suggestedChannel: null,
      actionLabel: "Create Review Roundup",
      actionPayload: {
        action: "open_create_content",
        guidance: `You've received ${gbpSignals.recentNewReviews} new Google reviews this week. Create a review roundup or highlight post to showcase the momentum.`,
        templateType: "client_testimonial",
      },
      reasons: [
        `${gbpSignals.recentNewReviews} new reviews in the last 7 days`,
        "Review surges are great for momentum-based social proof",
      ],
      evaluatedAt: ctx.now.toISOString(),
    });
  }

  // Suggest connecting GBP if not connected
  if (!gbpSignals?.hasGBP) {
    candidates.push({
      id: "gbp:connect",
      type: "integration_action",
      title: "Connect Google Business Profile",
      description: "Connect Google Business Profile to import reviews and boost credibility.",
      sourceType: "system",
      sourceId: null,
      sourceLabel: "Integrations",
      priorityScore: BASE_SCORES.integration_action + 20,
      confidence: "medium",
      freshness: "fresh",
      surfaces: ["dashboard"],
      suggestedContentType: null,
      suggestedCampaignType: null,
      suggestedChannel: null,
      actionLabel: "Connect GBP",
      actionPayload: { action: "setup_integrations" },
      reasons: [
        "Google Business reviews are powerful social proof",
        "Automatic review import saves time",
      ],
      evaluatedAt: ctx.now.toISOString(),
    });
  }

  return candidates;
}

function buildEngagementCandidates(ctx) {
  const candidates = [];
  const { enabledChannels, totalDataItems, techStack } = ctx;

  if (enabledChannels.length === 0) return candidates;

  // Website-based content
  if (techStack?.hasWebsite && techStack?.websiteUrl && ctx.recentPublished < 2) {
    candidates.push({
      id: "engagement:website_content",
      type: "engagement_post",
      title: "Generate content from your website",
      description: "Use your website content to create posts that showcase your real business.",
      sourceType: "system",
      sourceId: null,
      sourceLabel: "Website",
      priorityScore: BASE_SCORES.engagement_post + 27,
      confidence: "medium",
      freshness: "recent",
      surfaces: ["dashboard", "create_content"],
      suggestedContentType: "educational",
      suggestedCampaignType: null,
      suggestedChannel: null,
      actionLabel: "Create Post",
      actionPayload: {
        action: "open_create_content",
        guidance: `Create a post based on this business's website. Reference real pages, services, and details from ${techStack.websiteUrl}.`,
        templateType: "website_content",
      },
      reasons: ["Your website is connected but you have few recent posts"],
      evaluatedAt: ctx.now.toISOString(),
    });
  }

  // Unused data items as content sources
  for (const item of ctx.topUnusedItems) {
    if (item.type === "MILESTONE" || item.type === "TESTIMONIAL") continue; // Handled by their own builders
    if (item.type === "CUSTOM") continue; // Handled by listing builder
    if (candidates.length >= 2) break;

    candidates.push({
      id: `engagement:unused_${item.id}`,
      type: "engagement_post",
      title: `Create content from "${item.title}"`,
      description: item.summary || "Turn this business data into engaging content.",
      sourceType: "data_item",
      sourceId: item.id,
      sourceLabel: item.title,
      priorityScore: BASE_SCORES.engagement_post + 10,
      confidence: "medium",
      freshness: "recent",
      surfaces: ["dashboard", "create_content"],
      suggestedContentType: "educational",
      suggestedCampaignType: null,
      suggestedChannel: null,
      actionLabel: "Create Post",
      actionPayload: {
        action: "open_create_content",
        guidance: `Create an engaging post using this business data: ${item.title}${item.summary ? ` — ${item.summary}` : ""}`,
        dataItemId: item.id,
      },
      reasons: ["Unused business data", "Data-driven content outperforms generic posts"],
      evaluatedAt: ctx.now.toISOString(),
    });
  }

  return candidates;
}

function buildTemplateCandidates(ctx) {
  const candidates = [];
  const { industryKey, enabledChannels, totalDataItems, techStack } = ctx;

  if (enabledChannels.length === 0) return candidates;

  const templates = getRecommendationTemplates(industryKey);
  if (!templates?.length) return candidates;

  const condCtx = {
    hasData: totalDataItems > 0,
    noPublished: (ctx.statusMap.PUBLISHED ?? 0) === 0,
    hasWebsite: !!techStack?.hasWebsite,
  };

  const eligible = templates.filter((t) => {
    if (t.tier === "advanced") return false;
    const cond = t.conditions ?? {};
    if (cond.hasData && !condCtx.hasData) return false;
    if (cond.noPublished && !condCtx.noPublished) return false;
    if (cond.hasWebsite && !condCtx.hasWebsite) return false;
    return true;
  });

  const priorityRank = { high: 3, medium: 2, low: 1 };
  eligible.sort((a, b) => (priorityRank[b.priority] ?? 1) - (priorityRank[a.priority] ?? 1));

  const industryCtx = getContentContext(industryKey);
  const industryLabel = industryCtx?.label ?? "your industry";

  for (const tmpl of eligible.slice(0, 2)) {
    const numPriority = tmpl.priority === "high" ? 54 : tmpl.priority === "medium" ? 48 : 42;
    candidates.push({
      id: `template:${tmpl.type}`,
      type: "engagement_post",
      title: tmpl.title,
      description: tmpl.description,
      sourceType: "template",
      sourceId: null,
      sourceLabel: industryLabel,
      priorityScore: numPriority,
      confidence: "low",
      freshness: "recent",
      surfaces: ["dashboard", "create_content"],
      suggestedContentType: "educational",
      suggestedCampaignType: null,
      suggestedChannel: null,
      actionLabel: "Create Post",
      actionPayload: {
        action: "open_create_content",
        guidance: tmpl.guidance,
        templateType: tmpl.type,
      },
      reasons: [`Suggested for ${industryLabel} businesses based on proven content patterns`],
      evaluatedAt: ctx.now.toISOString(),
    });
  }

  return candidates;
}

// ── Growth Candidates ──────────────────────────────────────────────────

/**
 * Growth-focused content recommendations.
 * Triggers when: below posting target, lacking discovery content,
 * or no strong listing/testimonial signals to recommend.
 */
function buildGrowthCandidates(ctx) {
  const candidates = [];
  const { enabledChannels, recentPublished, publishedThisWeek, industryKey, reAssets, topUnusedItems } = ctx;

  if (enabledChannels.length === 0) return candidates;

  // Count how many strong data-driven signals exist
  const hasStrongListings = reAssets?.listings?.length > 0;
  const hasStrongTestimonials = reAssets?.reviewCount > 0;
  const hasStrongMilestones = topUnusedItems?.some((i) => i.type === "MILESTONE");
  const strongSignalCount = [hasStrongListings, hasStrongTestimonials, hasStrongMilestones].filter(Boolean).length;

  // Below posting target: fewer than 3 posts in last 7 days
  const belowTarget = recentPublished < 3;
  // Low weekly activity
  const lowWeeklyActivity = publishedThisWeek < 2;

  // Growth recs are more valuable when other signals are weak
  const signalBoost = strongSignalCount === 0 ? 10 : strongSignalCount === 1 ? 5 : 0;
  const activityBoost = belowTarget ? 8 : lowWeeklyActivity ? 4 : 0;

  const hasIG = enabledChannels.some((c) => c.channel === "INSTAGRAM");
  const hasFB = enabledChannels.some((c) => c.channel === "FACEBOOK");

  // Growth idea pool — concrete, actionable suggestions
  const growthIdeas = [];

  if (industryKey === "real_estate") {
    growthIdeas.push(
      {
        id: "growth:curiosity_price",
        title: "Create a 'What does $X get you?' post",
        description: "Curiosity-driven posts about local price points attract broad audiences and drive follows.",
        guidance: "[Type: growth] Create a post about what a common price point gets you in the local market. Use a curiosity-driven hook like 'You won't believe what $400k gets you in [area]'. Focus on surprising value, not a specific listing.",
        channel: hasIG ? "INSTAGRAM" : hasFB ? "FACEBOOK" : null,
        angle: "curiosity_hook",
      },
      {
        id: "growth:buyer_mistakes",
        title: "Share common buyer mistakes",
        description: "Educational 'mistakes to avoid' content gets saved and shared — great for reach.",
        guidance: "[Type: growth] Create a post about the top 3 mistakes first-time home buyers make. Use a numbered list format. Be specific and actionable — not generic advice.",
        channel: hasIG ? "INSTAGRAM" : hasFB ? "FACEBOOK" : null,
        angle: "value_tips",
      },
      {
        id: "growth:market_question",
        title: "Post a market timing question",
        description: "Polarizing questions drive comments, which boost reach and attract new followers.",
        guidance: "[Type: growth] Create a post asking 'Is now a good time to buy?' Give your honest expert take with specific local data. Encourage comments and debate.",
        channel: hasFB ? "FACEBOOK" : hasIG ? "INSTAGRAM" : null,
        angle: "community_question",
      },
      {
        id: "growth:myth_bust",
        title: "Bust a real estate myth",
        description: "Myth-busting content positions you as a trusted authority and gets shared widely.",
        guidance: "[Type: growth] Bust a common real estate myth (e.g., 'You need 20% down to buy a home'). Lead with the myth as if it's true, then flip it with the reality. Be specific with facts.",
        channel: hasIG ? "INSTAGRAM" : hasFB ? "FACEBOOK" : null,
        angle: "myth_busting",
      },
    );
  } else {
    // Generic growth ideas for non-real-estate industries
    growthIdeas.push(
      {
        id: "growth:industry_tip",
        title: "Share an insider tip",
        description: "Quick-win tips get saved, shared, and drive follows from new audiences.",
        guidance: "[Type: growth] Share a practical industry tip that most people don't know. Use a curiosity-driven hook. Make it immediately actionable.",
        channel: hasIG ? "INSTAGRAM" : hasFB ? "FACEBOOK" : null,
        angle: "value_tips",
      },
      {
        id: "growth:common_mistakes",
        title: "Share common mistakes in your industry",
        description: "Mistake-avoidance content performs well — people save and share it.",
        guidance: "[Type: growth] Create a post about the top 3 mistakes people make in your industry. Use a numbered list. Be specific, not generic.",
        channel: hasIG ? "INSTAGRAM" : hasFB ? "FACEBOOK" : null,
        angle: "myth_busting",
      },
      {
        id: "growth:engagement_question",
        title: "Ask an engagement question",
        description: "Questions spark comments, which boost algorithmic reach.",
        guidance: "[Type: growth] Ask a thought-provoking question related to your industry that people will want to answer. Encourage debate in the comments.",
        channel: hasFB ? "FACEBOOK" : hasIG ? "INSTAGRAM" : null,
        angle: "community_question",
      },
    );
  }

  // Pick top ideas based on what would be most impactful
  // Always include at least 1 if below target, up to 2 otherwise
  const maxGrowth = belowTarget ? 2 : lowWeeklyActivity ? 2 : 1;
  const selected = growthIdeas.slice(0, maxGrowth);

  for (let i = 0; i < selected.length; i++) {
    const idea = selected[i];
    const score = BASE_SCORES.growth_post + signalBoost + activityBoost - (i * 3);

    candidates.push({
      id: idea.id,
      type: "growth_post",
      title: idea.title,
      description: idea.description,
      sourceType: "system",
      sourceId: null,
      sourceLabel: "Growth",
      priorityScore: Math.min(score, 95),
      confidence: belowTarget ? "high" : "medium",
      freshness: "fresh",
      surfaces: ["dashboard", "create_content"],
      suggestedContentType: "growth",
      suggestedCampaignType: null,
      suggestedChannel: idea.channel,
      actionLabel: "Create Growth Post",
      actionPayload: {
        action: "open_create_content",
        guidance: idea.guidance,
        contentType: "growth",
        channel: idea.channel,
      },
      reasons: buildGrowthReasons(ctx, idea.angle),
      evaluatedAt: ctx.now.toISOString(),
    });
  }

  return candidates;
}

function buildGrowthReasons(ctx, angle) {
  const reasons = [];
  if (ctx.recentPublished < 3) reasons.push(`Only ${ctx.recentPublished} posts in the last 7 days — growth content helps maintain visibility`);
  else if (ctx.publishedThisWeek < 2) reasons.push("Low activity this week — a growth post keeps your audience engaged");
  if (angle === "curiosity_hook") reasons.push("Curiosity-driven posts attract new followers and expand reach");
  if (angle === "value_tips") reasons.push("Value-first content gets saved and shared — great for organic growth");
  if (angle === "myth_busting") reasons.push("Myth-busting content positions you as a trusted authority");
  if (angle === "community_question") reasons.push("Questions drive comments, which boost algorithmic reach");
  if (reasons.length === 0) reasons.push("Growth-focused content helps attract new followers");
  return reasons;
}

// ── Campaign Follow-Up Candidates ───────────────────────────────────────

function buildCampaignFollowUpCandidates(ctx) {
  const candidates = [];
  const { campaignUsageBySource, now } = ctx;

  if (!campaignUsageBySource || campaignUsageBySource.size === 0) return candidates;

  const FOLLOW_UP_TYPES = [
    { id: "still_available", label: "Still Available", description: "Create a 'still available' follow-up — remind buyers this property is on the market", minDays: 7, campaignType: "just_listed" },
    { id: "price_update", label: "Price Update", description: "Create a price update or market comparison post for this listing", minDays: 14, campaignType: "just_listed" },
    { id: "buyer_interest", label: "Buyer Interest", description: "Share buyer activity — open house attendance, showing requests, or offers received", minDays: 5, campaignType: "open_house" },
    { id: "sold_follow_up", label: "Sold Celebration", description: "Celebrate the closing and build social proof with a just-sold post", minDays: 3, campaignType: "just_sold" },
  ];

  for (const [sourceId, usage] of campaignUsageBySource) {
    if (!usage.lastCampaignAt) continue;

    const daysSinceCampaign = Math.floor((now - usage.lastCampaignAt) / (24 * 60 * 60 * 1000));

    for (const followUp of FOLLOW_UP_TYPES) {
      if (daysSinceCampaign < followUp.minDays) continue;
      if (!usage.campaignTypes.has(followUp.campaignType)) continue;

      candidates.push({
        id: `campaign_followup:${followUp.id}:${sourceId}`,
        type: "campaign_hint",
        title: `${followUp.label} follow-up`,
        description: followUp.description,
        sourceType: "listing",
        sourceId,
        priorityScore: Math.max(BASE_SCORES.campaign_hint + 5, 40),
        confidence: "medium",
        freshness: "recent",
        surfaces: ["dashboard", "create_content"],
        suggestedContentType: "listing",
        suggestedCampaignType: null,
        suggestedChannel: null,
        actionLabel: `Create ${followUp.label}`,
        actionPayload: {
          action: "open_create_content",
          guidance: followUp.description,
          templateType: "listing_post",
          dataItemId: sourceId,
        },
        reasons: [
          `${daysSinceCampaign} days since last campaign`,
          `Follow up on your ${followUp.campaignType.replace(/_/g, " ")} campaign`,
        ],
        evaluatedAt: now.toISOString(),
      });
    }
  }

  return candidates;
}

// ── Deduplication ────────────────────────────────────────────────────────

/**
 * Deduplication rules:
 * 1. For same sourceId: keep best campaign + best post, suppress extras.
 * 2. campaign_hint is suppressed if a campaign rec exists for same source.
 * 3. Max 2 campaign recommendations per surface to avoid spam.
 */
function deduplicateCandidates(candidates) {
  const bySource = new Map();
  for (const c of candidates) {
    if (!c.sourceId) continue;
    if (!bySource.has(c.sourceId)) bySource.set(c.sourceId, []);
    bySource.get(c.sourceId).push(c);
  }

  const suppressed = new Set();
  for (const [, group] of bySource) {
    if (group.length <= 1) continue;

    const isCampaignType = (t) => t.includes("campaign") && t !== "campaign_hint";
    const campaigns = group.filter((c) => isCampaignType(c.type));
    const posts = group.filter((c) => !isCampaignType(c.type) && c.type !== "campaign_hint");
    const hints = group.filter((c) => c.type === "campaign_hint");

    // Keep best campaign and best post, suppress extras
    if (campaigns.length > 0) {
      campaigns.sort((a, b) => b.priorityScore - a.priorityScore);
      for (const c of campaigns.slice(1)) suppressed.add(c.id);
      // Suppress campaign hints if a real campaign rec exists
      for (const h of hints) suppressed.add(h.id);
    }
    if (posts.length > 1) {
      posts.sort((a, b) => b.priorityScore - a.priorityScore);
      for (const p of posts.slice(1)) suppressed.add(p.id);
    }
  }

  return candidates.filter((c) => !suppressed.has(c.id));
}
