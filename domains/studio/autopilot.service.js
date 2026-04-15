// Real Estate Autopilot v2.
//
// A scheduled, rule-based content coverage system that evaluates real estate
// assets, connected channels, and recent content history, then creates a small
// number of ready-to-review drafts to maintain consistent marketing output.
//
// v1 capabilities (preserved):
//   - Trigger evaluation (new listing, inactivity, new review, channel gap)
//   - Single-draft decision engine
//   - Guardrails (daily/weekly caps, spacing, duplicate prevention)
//   - Event-driven execution (listing feed refresh)
//   - Manual run endpoint
//
// v2 additions:
//   - Content coverage evaluation (channel + content type balance)
//   - Multi-draft planning (max 2 per scheduled run, diversified)
//   - Channel differentiation (different angles per channel)
//   - Scheduled execution support (daily evaluation)
//   - Run history / transparency (mode, drafts created, coverage gaps)
//   - Asset strategy (_sourceType preference, recent exclusion)
//
// What Autopilot does NOT do:
//   - No auto-publish — all output is DRAFT status
//   - No black-box strategy engine — every decision is explainable
//   - No uncontrolled posting — hard weekly/daily limits enforced
//   - No other industries — real estate only
//   - Not designed for full autonomy — designed for consistency

import { prisma } from "../../prisma.js";
import { resolveRealEstateContext } from "../industry/techStack.service.js";
import { loadRealEstateGenerationAssets } from "../industry/realEstateGeneration.js";
import { getRecentAssetCount } from "../industry/realEstateAssets.js";
import { generateDraft } from "./generation/aiGenerationService.js";
import { formatDraft } from "./draft.service.js";
import { pickAngleForSource } from "./contentAngles.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const AUTOPILOT_PROVIDER_KEY = "_autopilot_settings";

// ── Default settings ─────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  enabled: false,
  mode: "off",                  // "off" | "draft_assist"
  preferredChannels: [],        // e.g. ["FACEBOOK", "INSTAGRAM"]
  maxDraftsPerWeek: 3,
  maxDraftsPerScheduledRun: 2,
  minimumHoursBetweenDrafts: 24,
  allowListingPosts: true,
  allowTestimonialPosts: true,
  allowMilestonePosts: true,
  allowFallbackPosts: true,
};

// ── Settings CRUD ────────────────────────────────────────────────────────

/** @param {string} workspaceId */
export async function getAutopilotSettings(workspaceId) {
  const row = await prisma.workspaceTechStackConnection.findUnique({
    where: { workspaceId_providerKey: { workspaceId, providerKey: AUTOPILOT_PROVIDER_KEY } },
  });
  return { ...DEFAULT_SETTINGS, ...(row?.metadataJson ?? {}) };
}

/** @param {string} workspaceId @param {object} patch */
export async function updateAutopilotSettings(workspaceId, patch) {
  const existing = await prisma.workspaceTechStackConnection.findUnique({
    where: { workspaceId_providerKey: { workspaceId, providerKey: AUTOPILOT_PROVIDER_KEY } },
  });
  const merged = { ...DEFAULT_SETTINGS, ...(existing?.metadataJson ?? {}), ...patch };

  await prisma.workspaceTechStackConnection.upsert({
    where: { workspaceId_providerKey: { workspaceId, providerKey: AUTOPILOT_PROVIDER_KEY } },
    create: {
      workspaceId,
      providerKey: AUTOPILOT_PROVIDER_KEY,
      connectionStatus: "connected",
      metadataJson: merged,
    },
    update: { metadataJson: merged },
  });

  return merged;
}

// ── Trigger evaluation (v1, preserved) ───────────────────────────────────

/** @typedef {{ triggerType: string, reason: string, eligible: boolean, supportingData?: object }} TriggerResult */

async function evaluateTriggers(workspaceId, reAssets, settings) {
  const triggers = [];

  const [lastAnyDraft, recentNewListings, recentNewReviews, recentNewMilestones] = await Promise.all([
    prisma.draft.findFirst({
      where: { clientId: workspaceId, status: { not: "FAILED" } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    getRecentAssetCount(workspaceId, "CUSTOM", DAY_MS),
    getRecentAssetCount(workspaceId, "TESTIMONIAL", 2 * DAY_MS),
    getRecentAssetCount(workspaceId, "MILESTONE", 2 * DAY_MS),
  ]);

  // A. new_listing
  if (settings.allowListingPosts && reAssets.listingCount > 0) {
    triggers.push({
      triggerType: "new_listing",
      reason: recentNewListings > 0
        ? `${recentNewListings} new listing${recentNewListings === 1 ? "" : "s"} imported in the last 24 hours`
        : `${reAssets.listingCount} listing${reAssets.listingCount === 1 ? "" : "s"} available`,
      eligible: recentNewListings > 0,
      supportingData: { newCount: recentNewListings, totalCount: reAssets.listingCount },
    });
  }

  // B. inactivity_gap
  const daysSinceAny = lastAnyDraft
    ? Math.floor((Date.now() - lastAnyDraft.createdAt.getTime()) / DAY_MS)
    : null;
  const inactive = daysSinceAny === null || daysSinceAny >= 3;
  triggers.push({
    triggerType: "inactivity_gap",
    reason: daysSinceAny === null
      ? "No content has been generated yet"
      : inactive
        ? `No content generated in ${daysSinceAny} days`
        : `Content generated ${daysSinceAny} day${daysSinceAny === 1 ? "" : "s"} ago`,
    eligible: inactive,
    supportingData: { daysSinceLastContent: daysSinceAny },
  });

  // C. new_review
  if (settings.allowTestimonialPosts && reAssets.reviewCount > 0) {
    triggers.push({
      triggerType: "new_review",
      reason: recentNewReviews > 0
        ? `${recentNewReviews} new review${recentNewReviews === 1 ? "" : "s"} added recently`
        : `${reAssets.reviewCount} review${reAssets.reviewCount === 1 ? "" : "s"} available`,
      eligible: recentNewReviews > 0,
      supportingData: { newCount: recentNewReviews, totalCount: reAssets.reviewCount },
    });
  }

  // D. new_milestone (closed deal / "Just Sold")
  if (settings.allowMilestonePosts && reAssets.milestoneCount > 0) {
    triggers.push({
      triggerType: "new_milestone",
      reason: recentNewMilestones > 0
        ? `${recentNewMilestones} new milestone${recentNewMilestones === 1 ? "" : "s"} (closed deal) imported recently`
        : `${reAssets.milestoneCount} milestone${reAssets.milestoneCount === 1 ? "" : "s"} available`,
      eligible: recentNewMilestones > 0,
      supportingData: { newCount: recentNewMilestones, totalCount: reAssets.milestoneCount },
    });
  }

  return triggers;
}

// ── Content coverage evaluation (v2) ─────────────────────────────────────

/**
 * Evaluate content coverage across channels and content types.
 * Returns a snapshot of what's been covered and what's missing.
 */
async function evaluateContentCoverage(workspaceId, enabledChannels, reAssets, settings) {
  const lookbackMs = 7 * DAY_MS;
  const since = new Date(Date.now() - lookbackMs);

  // Recent drafts by channel and by content warnings
  const recentDrafts = await prisma.draft.findMany({
    where: {
      clientId: workspaceId,
      status: { not: "FAILED" },
      createdAt: { gte: since },
    },
    select: { channel: true, warnings: true, createdBy: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });

  // Channel coverage
  const channelCounts = {};
  for (const ch of enabledChannels) channelCounts[ch] = 0;
  for (const d of recentDrafts) {
    if (channelCounts[d.channel] !== undefined) channelCounts[d.channel]++;
  }
  const channelsWithContent = Object.keys(channelCounts).filter((ch) => channelCounts[ch] > 0);
  const channelsWithoutContent = enabledChannels.filter((ch) => channelCounts[ch] === 0);

  // Content type coverage (inferred from warnings/templateType)
  let hasRecentListingPost = false;
  let hasRecentTestimonialPost = false;
  let hasRecentMilestonePost = false;
  let hasRecentFallbackPost = false;
  let listingPostCount = 0;
  let testimonialPostCount = 0;
  let milestonePostCount = 0;

  for (const d of recentDrafts) {
    const ws = d.warnings ?? [];
    const isListing = ws.some((w) => w.includes("listing") || w.includes("re_auto_listing"));
    const isTestimonial = ws.some((w) => w.includes("testimonial") || w.includes("review"));
    const isMilestone = ws.some((w) => w.includes("milestone") || w.includes("just_sold"));
    const isFallback = ws.some((w) => w.includes("fallback") || w.includes("market_update"));

    if (isListing) { hasRecentListingPost = true; listingPostCount++; }
    if (isTestimonial) { hasRecentTestimonialPost = true; testimonialPostCount++; }
    if (isMilestone) { hasRecentMilestonePost = true; milestonePostCount++; }
    if (isFallback) hasRecentFallbackPost = true;
  }

  // Identify missing opportunities (coverage gaps)
  const gaps = [];

  if (!hasRecentListingPost && settings.allowListingPosts && reAssets.listingCount > 0) {
    gaps.push({ type: "listing", reason: "No listing post this week", priority: 90 });
  }
  if (!hasRecentTestimonialPost && settings.allowTestimonialPosts && reAssets.reviewCount > 0) {
    gaps.push({ type: "testimonial", reason: "No testimonial post this week", priority: 80 });
  }
  if (!hasRecentMilestonePost && settings.allowMilestonePosts && reAssets.milestoneCount > 0) {
    gaps.push({ type: "milestone", reason: "No 'Just Sold' or milestone post this week", priority: 85 });
  }
  if (!hasRecentFallbackPost && settings.allowFallbackPosts && recentDrafts.length >= 2) {
    gaps.push({ type: "fallback", reason: "No market insight or tip post this week", priority: 60 });
  }
  for (const ch of channelsWithoutContent) {
    gaps.push({ type: "channel", channel: ch, reason: `No content for ${ch} this week`, priority: 75 });
  }

  // Variety check: too many listing posts in a row?
  const tooManyListings = listingPostCount >= 3 && !hasRecentTestimonialPost && !hasRecentFallbackPost;

  return {
    channelCounts,
    channelsWithContent,
    channelsWithoutContent,
    hasRecentListingPost,
    hasRecentTestimonialPost,
    hasRecentMilestonePost,
    hasRecentFallbackPost,
    listingPostCount,
    testimonialPostCount,
    milestonePostCount,
    totalRecentDrafts: recentDrafts.length,
    tooManyListings,
    gaps: gaps.sort((a, b) => b.priority - a.priority),
  };
}

// ── Guardrails ───────────────────────────────────────────────────────────

/**
 * Check how many more drafts autopilot can create.
 * Returns { allowed: boolean, remaining: number, reason?: string }.
 */
async function checkGuardrails(workspaceId, settings) {
  const now = Date.now();
  const minSpacingMs = (settings.minimumHoursBetweenDrafts ?? 24) * 60 * 60 * 1000;

  const dayOfWeek = new Date().getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date();
  weekStart.setUTCDate(weekStart.getUTCDate() - mondayOffset);
  weekStart.setUTCHours(0, 0, 0, 0);

  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const [weekCount, todayCount, lastAutopilot] = await Promise.all([
    prisma.draft.count({
      where: { clientId: workspaceId, createdBy: "system:autopilot", createdAt: { gte: weekStart } },
    }),
    prisma.draft.count({
      where: { clientId: workspaceId, createdBy: "system:autopilot", createdAt: { gte: todayStart } },
    }),
    prisma.draft.findFirst({
      where: { clientId: workspaceId, createdBy: "system:autopilot" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);

  const maxWeek = settings.maxDraftsPerWeek ?? 3;

  if (weekCount >= maxWeek) {
    return { allowed: false, remaining: 0, reason: `Weekly limit reached (${weekCount}/${maxWeek})` };
  }

  // For scheduled runs: daily cap is 2 (up from 1 for multi-draft)
  if (todayCount >= 2) {
    return { allowed: false, remaining: 0, reason: "Daily autopilot limit reached (2/day)" };
  }

  if (lastAutopilot) {
    const elapsed = now - lastAutopilot.createdAt.getTime();
    if (elapsed < minSpacingMs) {
      const hoursLeft = Math.ceil((minSpacingMs - elapsed) / (60 * 60 * 1000));
      return { allowed: false, remaining: 0, reason: `Too soon — next autopilot draft in ~${hoursLeft}h` };
    }
  }

  const weekRemaining = maxWeek - weekCount;
  const dayRemaining = 2 - todayCount;
  return { allowed: true, remaining: Math.min(weekRemaining, dayRemaining) };
}

// ── Channel differentiation helpers ──────────────────────────────────────

/** Pick channel-appropriate guidance variations. */
function channelGuidanceVariation(channel, baseGuidance, contentType) {
  const suffix = {
    FACEBOOK: contentType === "listing"
      ? " Write a detailed, community-friendly post with property highlights and neighborhood context."
      : " Write a warm, engaging post suited for Facebook's community-driven audience.",
    INSTAGRAM: contentType === "listing"
      ? " Write a punchy, visual-first caption — scroll-stopping opener, key features, strong CTA."
      : " Write a short, visual-first Instagram caption — engaging, concise, with a clear CTA.",
    LINKEDIN: " Write a professional, analytical post suitable for LinkedIn's business audience.",
  };
  return baseGuidance + (suffix[channel] ?? "");
}

// ── Multi-draft planner (v2) ─────────────────────────────────────────────

/** @typedef {{ reasonCode: string, templateType: string, channel: string, dataItemId?: string, guidance: string, sourceType: string, triggerType: string, contentAngle?: object }} DraftPlan */

/**
 * Plan up to `maxPlans` diversified drafts based on coverage gaps and triggers.
 * Returns an array of draft plans (may be empty).
 */
function planMultiDraft({ triggers, coverage, reAssets, settings, enabledChannels, maxPlans }) {
  const plans = [];
  const usedChannels = new Set();
  const usedAssets = new Set();
  const usedTypes = new Set();
  const usedAngles = new Set();

  const preferred = settings.preferredChannels?.length > 0 ? settings.preferredChannels : null;
  const channelOrder = ["FACEBOOK", "INSTAGRAM", "LINKEDIN", "X"];

  const pickChannel = (exclude = new Set()) => {
    // Prefer channels with coverage gaps first
    const gapChannel = coverage.channelsWithoutContent.find(
      (ch) => !exclude.has(ch) && enabledChannels.includes(ch)
    );
    if (gapChannel) return gapChannel;

    if (preferred) {
      const match = preferred.find((c) => enabledChannels.includes(c) && !exclude.has(c));
      if (match) return match;
    }
    return channelOrder.find((c) => enabledChannels.includes(c) && !exclude.has(c))
      ?? enabledChannels.find((c) => !exclude.has(c))
      ?? enabledChannels[0];
  };

  const eligible = triggers.filter((t) => t.eligible);

  const addPlan = (plan) => {
    if (plans.length >= maxPlans) return false;
    // Select content angle for strategic variety
    const dataJson = plan.dataItemId && reAssets.bestListing ? reAssets.bestListing : null;
    const angle = pickAngleForSource(plan.sourceType, dataJson, usedAngles);
    plan.contentAngle = angle;
    plans.push(plan);
    usedChannels.add(plan.channel);
    if (plan.dataItemId) usedAssets.add(plan.dataItemId);
    usedTypes.add(plan.sourceType);
    usedAngles.add(angle.key);
    return true;
  };

  // ── Priority 1: New listing post (if gap or trigger)
  const newListingTrigger = eligible.find((t) => t.triggerType === "new_listing");
  if (
    (newListingTrigger || !coverage.hasRecentListingPost) &&
    settings.allowListingPosts &&
    reAssets.bestListing &&
    reAssets.bestListingSource &&
    !coverage.tooManyListings
  ) {
    const ch = pickChannel(usedChannels);
    const label = reAssets.bestListing.title || reAssets.bestListing.address || "property";
    addPlan({
      reasonCode: newListingTrigger ? "listing_import" : "coverage_listing",
      templateType: "listing_post",
      channel: ch,
      dataItemId: reAssets.bestListingSource.id,
      guidance: channelGuidanceVariation(ch, `Create a 'just listed' post for ${label}.`, "listing"),
      sourceType: "listing",
      triggerType: newListingTrigger ? "new_listing" : "coverage",
    });
  }

  // ── Priority 2: Testimonial post (if gap or trigger)
  const newReviewTrigger = eligible.find((t) => t.triggerType === "new_review");
  if (
    plans.length < maxPlans &&
    (newReviewTrigger || !coverage.hasRecentTestimonialPost) &&
    settings.allowTestimonialPosts &&
    reAssets.reviews?.length > 0 &&
    !usedTypes.has("review")
  ) {
    const ch = pickChannel(usedChannels);
    addPlan({
      reasonCode: newReviewTrigger ? "new_review" : "coverage_testimonial",
      templateType: "client_testimonial",
      channel: ch,
      guidance: channelGuidanceVariation(ch, "Create a testimonial post using a real client review. Quote accurately.", "review"),
      sourceType: "review",
      triggerType: newReviewTrigger ? "new_review" : "coverage",
    });
  }

  // ── Priority 3: Milestone post — "Just Sold" (if gap or trigger)
  const newMilestoneTrigger = eligible.find((t) => t.triggerType === "new_milestone");
  if (
    plans.length < maxPlans &&
    (newMilestoneTrigger || !coverage.hasRecentMilestonePost) &&
    settings.allowMilestonePosts &&
    reAssets.bestMilestone &&
    reAssets.bestMilestoneSource &&
    !usedTypes.has("milestone")
  ) {
    const ch = pickChannel(usedChannels);
    const label = reAssets.bestMilestone.address || reAssets.bestMilestone.achievement || "closed deal";
    addPlan({
      reasonCode: newMilestoneTrigger ? "new_milestone" : "coverage_milestone",
      templateType: "milestone_celebration",
      channel: ch,
      dataItemId: reAssets.bestMilestoneSource.id,
      guidance: channelGuidanceVariation(ch, `Create a 'Just Sold' or milestone celebration post for ${label}. Celebrate the achievement.`, "milestone"),
      sourceType: "milestone",
      triggerType: newMilestoneTrigger ? "new_milestone" : "coverage",
    });
  }

  // ── Priority 4: Channel gap fill (different content type)
  if (plans.length < maxPlans && coverage.channelsWithoutContent.length > 0) {
    const gapCh = coverage.channelsWithoutContent.find((ch) => !usedChannels.has(ch));
    if (gapCh) {
      // Pick a content type we haven't used yet
      if (settings.allowListingPosts && !usedTypes.has("listing") && reAssets.bestListing && reAssets.bestListingSource) {
        addPlan({
          reasonCode: "channel_gap_listing",
          templateType: "featured_property",
          channel: gapCh,
          dataItemId: reAssets.bestListingSource.id,
          guidance: channelGuidanceVariation(gapCh, `Feature a property for ${gapCh}.`, "listing"),
          sourceType: "listing",
          triggerType: "channel_gap",
        });
      } else if (settings.allowFallbackPosts && !usedTypes.has("fallback")) {
        addPlan({
          reasonCode: "channel_gap_fallback",
          templateType: "market_update",
          channel: gapCh,
          guidance: channelGuidanceVariation(gapCh, "Create a real estate market insight or local tip.", "fallback"),
          sourceType: "fallback",
          triggerType: "channel_gap",
        });
      }
    }
  }

  // ── Priority 5: Inactivity fallback
  const inactivity = eligible.find((t) => t.triggerType === "inactivity_gap");
  if (plans.length === 0 && inactivity) {
    const ch = pickChannel(usedChannels);
    if (settings.allowListingPosts && reAssets.bestListing && reAssets.bestListingSource) {
      addPlan({
        reasonCode: "inactivity_listing",
        templateType: "featured_property",
        channel: ch,
        dataItemId: reAssets.bestListingSource.id,
        guidance: channelGuidanceVariation(ch, `Feature a property to keep content flowing.`, "listing"),
        sourceType: "listing",
        triggerType: "inactivity_gap",
      });
    } else if (settings.allowMilestonePosts && reAssets.bestMilestone && reAssets.bestMilestoneSource) {
      addPlan({
        reasonCode: "inactivity_milestone",
        templateType: "milestone_celebration",
        channel: ch,
        dataItemId: reAssets.bestMilestoneSource.id,
        guidance: channelGuidanceVariation(ch, "Create a 'Just Sold' post to maintain consistency.", "milestone"),
        sourceType: "milestone",
        triggerType: "inactivity_gap",
      });
    } else if (settings.allowTestimonialPosts && reAssets.reviews?.length > 0) {
      addPlan({
        reasonCode: "inactivity_review",
        templateType: "client_testimonial",
        channel: ch,
        guidance: channelGuidanceVariation(ch, "Create a testimonial post to maintain consistency.", "review"),
        sourceType: "review",
        triggerType: "inactivity_gap",
      });
    } else if (settings.allowFallbackPosts) {
      addPlan({
        reasonCode: "inactivity_fallback",
        templateType: "market_update",
        channel: ch,
        guidance: channelGuidanceVariation(ch, "Create a real estate market insight to maintain consistency.", "fallback"),
        sourceType: "fallback",
        triggerType: "inactivity_gap",
      });
    }
  }

  return plans;
}

// ── Draft execution ──────────────────────────────────────────────────────

/**
 * Execute a single draft plan. Returns the formatted draft or null on failure.
 */
async function executeDraftPlan(workspaceId, plan, runMode) {
  // Duplicate asset check (48h window)
  if (plan.dataItemId) {
    const recentDupe = await prisma.draft.findFirst({
      where: {
        clientId: workspaceId,
        createdBy: "system:autopilot",
        createdAt: { gte: new Date(Date.now() - 2 * DAY_MS) },
        warnings: { hasSome: [`autopilot_asset: ${plan.dataItemId}`] },
      },
    });
    if (recentDupe) return null;
  }

  try {
    const draft = await generateDraft({
      clientId: workspaceId,
      kind: "POST",
      channel: plan.channel,
      guidance: plan.guidance,
      templateType: plan.templateType,
      createdBy: "system:autopilot",
      dataItemId: plan.dataItemId,
      recommendationId: `autopilot_${plan.reasonCode}`,
      contentAngle: plan.contentAngle,
    });

    const autopilotWarnings = [
      "autopilot: true",
      `autopilot_trigger: ${plan.triggerType}`,
      `autopilot_reason: ${plan.reasonCode}`,
      `autopilot_channel: ${plan.channel}`,
      `autopilot_mode: ${runMode}`,
      ...(plan.dataItemId ? [`autopilot_asset: ${plan.dataItemId}`] : []),
      ...(plan.contentAngle ? [`autopilot_angle: ${plan.contentAngle.key}`, `autopilot_angle_label: ${plan.contentAngle.label}`] : []),
    ];

    await prisma.draft.update({
      where: { id: draft.id },
      data: { warnings: [...(draft.warnings ?? []), ...autopilotWarnings] },
    });

    const updated = await prisma.draft.findUnique({ where: { id: draft.id } });
    return formatDraft(updated);
  } catch {
    return null;
  }
}

// ── Run orchestration (v1 event-driven, preserved) ───────────────────────

/**
 * Run autopilot evaluation for a workspace (event-driven or manual).
 * Creates at most one draft.
 */
export async function runAutopilot(workspaceId, { mode = "event" } = {}) {
  const preamble = await loadAutopilotContext(workspaceId);
  if (preamble.action === "no_action") return preamble;

  const { settings, reAssets, enabledChannels } = preamble;

  // v1 trigger evaluation
  const triggers = await evaluateTriggers(workspaceId, reAssets, settings);

  // v1 single-decision engine
  const eligible = triggers.filter((t) => t.eligible);
  if (eligible.length === 0) {
    return { action: "no_action", reason: "No eligible triggers", triggers, mode };
  }

  // Use the coverage-aware planner but cap at 1 for event-driven runs
  const coverage = await evaluateContentCoverage(workspaceId, enabledChannels, reAssets, settings);
  const plans = planMultiDraft({ triggers, coverage, reAssets, settings, enabledChannels, maxPlans: 1 });

  if (plans.length === 0) {
    return { action: "no_action", reason: "No suitable action found", triggers, coverage: summarizeCoverage(coverage), mode };
  }

  const draft = await executeDraftPlan(workspaceId, plans[0], mode);
  if (!draft) {
    return { action: "no_action", reason: "Draft generation skipped (duplicate or failed)", triggers, mode };
  }

  return {
    action: "generated",
    drafts: [draft],
    draftsCreated: 1,
    reason: `Generated ${plans[0].templateType} for ${plans[0].channel}`,
    triggers,
    plans,
    coverage: summarizeCoverage(coverage),
    mode,
  };
}

// ── Scheduled run (v2) ───────────────────────────────────────────────────

/**
 * Run a scheduled autopilot evaluation.
 * May create up to maxDraftsPerScheduledRun drafts (default 2).
 * Uses content coverage for diversified planning.
 */
export async function runScheduledAutopilot(workspaceId) {
  const preamble = await loadAutopilotContext(workspaceId);
  if (preamble.action === "no_action") return preamble;

  const { settings, reAssets, enabledChannels, guardrail } = preamble;
  const maxPlans = Math.min(settings.maxDraftsPerScheduledRun ?? 2, guardrail.remaining);

  if (maxPlans <= 0) {
    return { action: "no_action", reason: guardrail.reason ?? "No capacity remaining", mode: "scheduled" };
  }

  // Evaluate triggers + coverage
  const triggers = await evaluateTriggers(workspaceId, reAssets, settings);
  const coverage = await evaluateContentCoverage(workspaceId, enabledChannels, reAssets, settings);

  // Plan multi-draft batch
  const plans = planMultiDraft({ triggers, coverage, reAssets, settings, enabledChannels, maxPlans });

  if (plans.length === 0) {
    return {
      action: "no_action",
      reason: "No suitable actions — content coverage is adequate",
      triggers,
      coverage: summarizeCoverage(coverage),
      mode: "scheduled",
    };
  }

  // Execute plans sequentially (respect spacing — but within a batch run, allow adjacent)
  const drafts = [];
  for (const plan of plans) {
    const draft = await executeDraftPlan(workspaceId, plan, "scheduled");
    if (draft) drafts.push(draft);
  }

  if (drafts.length === 0) {
    return {
      action: "no_action",
      reason: "All plans skipped (duplicate assets or generation failures)",
      triggers,
      plans,
      coverage: summarizeCoverage(coverage),
      mode: "scheduled",
    };
  }

  return {
    action: "generated",
    drafts,
    draftsCreated: drafts.length,
    reason: `Scheduled run created ${drafts.length} draft${drafts.length === 1 ? "" : "s"}`,
    triggers,
    plans,
    coverage: summarizeCoverage(coverage),
    mode: "scheduled",
  };
}

// ── Evaluate all enabled workspaces (for external cron/scheduler) ────────

/**
 * Find all real estate workspaces with autopilot enabled and run scheduled
 * evaluation for each. Returns summary results.
 */
export async function evaluateAllAutopilotWorkspaces() {
  const rows = await prisma.workspaceTechStackConnection.findMany({
    where: { providerKey: AUTOPILOT_PROVIDER_KEY },
    select: { workspaceId: true, metadataJson: true },
  });

  const enabled = rows.filter((r) => r.metadataJson?.enabled && r.metadataJson?.mode !== "off");
  const results = [];

  for (const row of enabled) {
    try {
      const result = await runScheduledAutopilot(row.workspaceId);
      results.push({ workspaceId: row.workspaceId, ...result });
    } catch (err) {
      results.push({ workspaceId: row.workspaceId, action: "error", reason: err.message });
    }
  }

  return {
    evaluated: enabled.length,
    results,
    generatedTotal: results.reduce((n, r) => n + (r.draftsCreated ?? 0), 0),
  };
}

// ── Shared setup ─────────────────────────────────────────────────────────

async function loadAutopilotContext(workspaceId) {
  const client = await prisma.client.findUnique({
    where: { id: workspaceId },
    select: { industryKey: true },
  });
  if (!client || client.industryKey !== "real_estate") {
    return { action: "no_action", reason: "Autopilot is only available for real estate workspaces" };
  }

  const settings = await getAutopilotSettings(workspaceId);
  if (!settings.enabled || settings.mode === "off") {
    return { action: "no_action", reason: "Autopilot is disabled" };
  }

  const guardrail = await checkGuardrails(workspaceId, settings);
  if (!guardrail.allowed) {
    return { action: "no_action", reason: guardrail.reason };
  }

  let reContext, reAssets;
  try {
    reContext = await resolveRealEstateContext(workspaceId);
  } catch {
    return { action: "no_action", reason: "Failed to resolve real estate context" };
  }
  try {
    reAssets = await loadRealEstateGenerationAssets(workspaceId, reContext);
  } catch {
    return { action: "no_action", reason: "Failed to load real estate assets" };
  }

  const channelRows = await prisma.channelSettings.findMany({
    where: { clientId: workspaceId, isEnabled: true },
    select: { channel: true },
  });
  const enabledChannels = channelRows.map((c) => c.channel);
  if (enabledChannels.length === 0) {
    return { action: "no_action", reason: "No channels enabled" };
  }

  return { settings, reContext, reAssets, enabledChannels, guardrail };
}

// ── Coverage summary helper ──────────────────────────────────────────────

function summarizeCoverage(coverage) {
  return {
    totalRecentDrafts: coverage.totalRecentDrafts,
    channelsWithContent: coverage.channelsWithContent,
    channelsWithoutContent: coverage.channelsWithoutContent,
    hasRecentListingPost: coverage.hasRecentListingPost,
    hasRecentTestimonialPost: coverage.hasRecentTestimonialPost,
    hasRecentMilestonePost: coverage.hasRecentMilestonePost,
    hasRecentFallbackPost: coverage.hasRecentFallbackPost,
    tooManyListings: coverage.tooManyListings,
    gaps: coverage.gaps.map((g) => g.reason),
  };
}

// ── Status (for dashboard) ───────────────────────────────────────────────

export async function getAutopilotStatus(workspaceId) {
  const settings = await getAutopilotSettings(workspaceId);

  const dayOfWeek = new Date().getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date();
  weekStart.setUTCDate(weekStart.getUTCDate() - mondayOffset);
  weekStart.setUTCHours(0, 0, 0, 0);

  const [draftsThisWeek, lastAction] = await Promise.all([
    prisma.draft.count({
      where: { clientId: workspaceId, createdBy: "system:autopilot", createdAt: { gte: weekStart } },
    }),
    prisma.draft.findFirst({
      where: { clientId: workspaceId, createdBy: "system:autopilot" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, warnings: true, channel: true },
    }),
  ]);

  // Parse last action metadata from warnings
  let lastActionType = null;
  let lastRunMode = null;
  if (lastAction?.warnings) {
    const triggerW = lastAction.warnings.find((w) => w.startsWith("autopilot_trigger:"));
    if (triggerW) lastActionType = triggerW.split(":")[1]?.trim();
    const modeW = lastAction.warnings.find((w) => w.startsWith("autopilot_mode:"));
    if (modeW) lastRunMode = modeW.split(":")[1]?.trim();
  }

  // Lightweight coverage gaps (only if enabled)
  let coverageGaps = [];
  if (settings.enabled && settings.mode !== "off") {
    try {
      const channelRows = await prisma.channelSettings.findMany({
        where: { clientId: workspaceId, isEnabled: true },
        select: { channel: true },
      });
      const enabledChannels = channelRows.map((c) => c.channel);
      if (enabledChannels.length > 0) {
        // Quick coverage check (reuse evaluator with minimal asset load)
        const coverage = await evaluateContentCoverage(
          workspaceId, enabledChannels,
          { listingCount: 0, reviewCount: 0 }, // counts don't matter for gap detection
          settings,
        );
        coverageGaps = coverage.gaps.map((g) => g.reason);
      }
    } catch {
      // Non-critical
    }
  }

  return {
    enabled: settings.enabled && settings.mode !== "off",
    mode: settings.mode,
    maxDraftsPerWeek: settings.maxDraftsPerWeek,
    draftsThisWeek,
    lastActionAt: lastAction?.createdAt?.toISOString() ?? null,
    lastActionType,
    lastActionChannel: lastAction?.channel ?? null,
    lastRunMode,
    coverageGaps,
  };
}
