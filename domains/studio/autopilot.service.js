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
import { getGBPSignals } from "./gbpSync.service.js";
import {
  upsertRecommendation,
  expireStaleRecommendations,
} from "./autopilotCampaignRecommendation.service.js";
import { recordRun } from "./autopilotRun.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const AUTOPILOT_PROVIDER_KEY = "_autopilot_settings";

// ── Default settings ─────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  enabled: false,
  mode: "off",                  // "off" | "draft_only" (Phase 1 — see docs/AUTOPILOT_PRODUCT_AUDIT.md)
  preferredChannels: [],        // e.g. ["FACEBOOK", "INSTAGRAM"]
  maxDraftsPerWeek: 3,
  maxDraftsPerDay: 2,
  maxDraftsPerScheduledRun: 2,
  minimumHoursBetweenDrafts: 24,
  requireApprovalBeforePublish: true,
  quietHoursStart: null,
  quietHoursEnd: null,
  skipChannelsWithoutMedia: true,
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
  const merged = { ...DEFAULT_SETTINGS, ...(row?.metadataJson ?? {}) };
  // Backward compat — map legacy / removed mode names to the
  // current ladder. Spinstr01:
  // - draft_only (Phase-1 MVP name) → draft_on_click (same behavior)
  // - draft_assist (pre-MVP) → draft_on_click
  // - schedule_approved / auto_publish (pre-Phase-1, never wired)
  //   → draft_on_click (safest fallback)
  // - auto_publish_guarded (Coming Soon; schema rejects on save —
  //   only reachable if a row was hand-edited) → draft_on_click
  const LEGACY_MODE_REMAP = {
    draft_only: "draft_on_click",
    draft_assist: "draft_on_click",
    schedule_approved: "draft_on_click",
    auto_publish: "draft_on_click",
    auto_publish_guarded: "draft_on_click",
  };
  if (merged.mode in LEGACY_MODE_REMAP) {
    merged.mode = LEGACY_MODE_REMAP[merged.mode];
  }
  return merged;
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
    // Include unreplied review count from GBP signals if available
    let unrepliedCount = 0;
    try {
      const gbpSignals = await getGBPSignals(workspaceId);
      unrepliedCount = gbpSignals.unrepliedCount || 0;
    } catch { /* non-critical */ }

    triggers.push({
      triggerType: "new_review",
      reason: recentNewReviews > 0
        ? `${recentNewReviews} new review${recentNewReviews === 1 ? "" : "s"} added recently`
        : `${reAssets.reviewCount} review${reAssets.reviewCount === 1 ? "" : "s"} available`,
      eligible: recentNewReviews > 0,
      supportingData: { newCount: recentNewReviews, totalCount: reAssets.reviewCount, unrepliedCount },
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
  return runEvaluatorAndRecord(workspaceId, mode === "scheduled" ? "SCHEDULED" : mode === "event" ? "EVENT" : "MANUAL", mode);
}

// ── Scheduled run (v2) ───────────────────────────────────────────────────

/**
 * Run a scheduled autopilot evaluation.
 * May create up to maxDraftsPerScheduledRun drafts (default 2).
 * Uses content coverage for diversified planning.
 */
export async function runScheduledAutopilot(workspaceId) {
  return runEvaluatorAndRecord(workspaceId, "SCHEDULED", "scheduled");
}

// Shared evaluator body — same logic, single AutopilotRun row.
// Captures preamble decisions (no_action / skipped) as run rows
// too, so the activity feed can explain why Autopilot didn't act.
async function runEvaluatorAndRecord(workspaceId, triggerSource, modeForResponse) {
  return recordRun(
    { clientId: workspaceId, triggerSource },
    async () => {
      const preamble = await loadAutopilotContext(workspaceId);
      if (preamble.action === "no_action") {
        return {
          status: "SKIPPED",
          reason: preamble.reason ?? "Preamble blocked the run.",
          recommendationsCreated: 0,
          recommendationsUpdated: 0,
          recommendationsExpired: 0,
          _runResponse: preamble,
        };
      }
      const { reAssets, enabledChannels, settings } = preamble;
      const triggers = await evaluateTriggers(workspaceId, reAssets, settings);
      const expired = await expireStaleRecommendations(workspaceId);
      const detectResult = await detectAndPersistRecommendations({
        workspaceId,
        reAssets,
        enabledChannels,
      });
      const detectSummary = detectResult.summary ?? null;

      // Spinstr01 — auto_generate_drafts mode. After persisting
      // recommendations, walk NEEDS_REVIEW rows that meet the
      // high-confidence bar and call generateDraftsForRecommendation
      // for each. Already-generated recs are skipped by the
      // generator's own idempotency check. Skip reasons are
      // recorded in the run metadata so the activity feed can
      // explain why a rec stayed at NEEDS_REVIEW.
      let autoGen = null;
      if (settings.mode === "auto_generate_drafts") {
        autoGen = await autoGenerateForHighConfidence(workspaceId);
      }

      const totalSurfaced = detectResult.recommendationsCreated + detectResult.recommendationsUpdated;
      const status =
        detectResult.recommendationsCreated > 0
          ? "CREATED_RECOMMENDATIONS"
          : detectResult.recommendationsUpdated > 0
            ? "UPDATED_RECOMMENDATIONS"
            : "NO_ACTION";
      const reason =
        totalSurfaced > 0
          ? `Surfaced ${totalSurfaced} campaign opportunit${totalSurfaced === 1 ? "y" : "ies"}`
          : detectSummary?.noActionReason ?? "No new opportunities detected";

      // Spinstr04 — bundle the detect summary + autoGenerate result
      // into the run's metadata blob. listRuns whitelists these
      // top-level keys; the activity panel reads them for richer
      // plain-English copy.
      const runMetadata = {};
      if (detectSummary) runMetadata.summary = detectSummary;
      if (autoGen) runMetadata.autoGenerate = autoGen;

      return {
        status,
        reason,
        recommendationsCreated: detectResult.recommendationsCreated,
        recommendationsUpdated: detectResult.recommendationsUpdated,
        recommendationsExpired: expired,
        metadata: Object.keys(runMetadata).length > 0 ? runMetadata : null,
        // Carry the user-facing response shape out via a private
        // key the recordRun helper ignores; finishRun won't try
        // to serialize it.
        _runResponse: {
          action: totalSurfaced > 0 ? "recommended" : "no_action",
          drafts: [],
          draftsCreated: 0,
          recommendationsCreated: detectResult.recommendationsCreated,
          recommendationsUpdated: detectResult.recommendationsUpdated,
          recommendationsExpired: expired,
          autoGeneratedDrafts: autoGen?.draftsCreated ?? 0,
          autoGenerateSkipped: autoGen?.skipped ?? [],
          reason,
          triggers,
          mode: modeForResponse,
        },
      };
    },
  ).then((outcome) => outcome?._runResponse ?? null);
}

// ── auto_generate_drafts post-detect step ────────────────────────────
//
// Walks workspace's NEEDS_REVIEW recs and tries to auto-generate
// drafts for the ones that pass the "high confidence" bar:
//   - has a concrete sourceDataItemId (not workspace-scoped like
//     INACTIVITY_GAP, where the rec body would have to invent
//     content from nothing)
//   - has a non-generic propertyTitle/Address (so the draft has
//     something to talk about)
//   - triggerType is in the high-confidence set
//
// Each call to generateDraftsForRecommendation is itself
// idempotent (re-click on a rec with generatedDraftIds returns
// the existing drafts unchanged), so repeated scheduler runs
// don't duplicate drafts. Errors per rec are captured and
// returned alongside the success count — they DON'T abort the
// whole loop.
async function autoGenerateForHighConfidence(workspaceId) {
  const candidates = await prisma.autopilotCampaignRecommendation.findMany({
    where: {
      clientId: workspaceId,
      status: "NEEDS_REVIEW",
      // Idempotency: skip rows that already have drafts.
      generatedDraftIds: { isEmpty: true },
    },
    take: 10,
  });

  const HIGH_CONFIDENCE_TRIGGERS = new Set([
    "NEW_LISTING",
    "OPEN_HOUSE",
    "PRICE_DROP",
    "JUST_SOLD",
    "NEW_REVIEW",
  ]);
  const skipped = [];
  const generated = [];

  const { generateDraftsForRecommendation } = await import(
    "./autopilotCampaignRecommendation.service.js"
  );

  for (const rec of candidates) {
    if (!HIGH_CONFIDENCE_TRIGGERS.has(rec.triggerType)) {
      skipped.push({
        recommendationId: rec.id,
        reason: `Trigger ${rec.triggerType} is not eligible for auto-generation`,
      });
      continue;
    }
    const payload =
      rec.payloadJson && typeof rec.payloadJson === "object" ? rec.payloadJson : {};
    if (typeof payload.sourceDataItemId !== "string" || payload.sourceDataItemId.length === 0) {
      skipped.push({
        recommendationId: rec.id,
        reason: "Missing sourceDataItemId — would generate generic copy",
      });
      continue;
    }
    const title = typeof payload.propertyTitle === "string" ? payload.propertyTitle.trim() : "";
    if (!title || /^your (new )?listing$/i.test(title)) {
      skipped.push({
        recommendationId: rec.id,
        reason: "Property title is generic — would generate generic copy",
      });
      continue;
    }
    try {
      const result = await generateDraftsForRecommendation({
        clientId: workspaceId,
        recommendationId: rec.id,
        userId: "system:autopilot",
      });
      if (result.status === "noop" && result.alreadyGenerated) {
        skipped.push({
          recommendationId: rec.id,
          reason: "Already generated (idempotent)",
        });
      } else if (result.status === "failed") {
        skipped.push({
          recommendationId: rec.id,
          reason: result.reason ?? "Generation failed",
        });
      } else {
        generated.push({
          recommendationId: rec.id,
          draftIds: result.drafts.map((d) => d.id),
        });
      }
    } catch (err) {
      console.warn("[autopilot.auto-gen] generation threw:", {
        recommendationId: rec.id,
        err: err?.message,
      });
      skipped.push({
        recommendationId: rec.id,
        reason: err?.message ?? "Generation error",
      });
    }
  }
  return {
    draftsCreated: generated.reduce((n, g) => n + g.draftIds.length, 0),
    recommendationsGenerated: generated.length,
    skipped,
  };
}

// ── Phase 2 detector — opportunities → recommendations ────────────────
//
// One detection pass per workspace. Each detector emits via
// upsertRecommendation (idempotent on clientId × triggerType ×
// triggerObjectId), so re-runs on the same opportunity touch
// updatedAt + payload rather than duplicating the row.
//
// Wired triggers today:
//   - NEW_LISTING     (per listing item)
//   - OPEN_HOUSE      (per listing with a future open_house event)
//   - NEW_REVIEW      (per recent review)
//   - INACTIVITY_GAP  (workspace-scoped fallback)
//
// Planned, documented in docs/AUTOPILOT_PRODUCT_AUDIT.md §5 but
// not yet wired:
//   - PRICE_DROP      (needs listing priceHistory tracking)
//   - STALE_LISTING   (needs last-engagement tracking)
//   - JUST_SOLD       (needs status-flip event tracking)
//   - MARKET_UPDATE   (needs cadence rules)
//   - SEASONAL        (needs calendar)
const REC_LISTING_LOOKBACK_MS = 14 * DAY_MS;
const REC_INACTIVITY_THRESHOLD_MS = 14 * DAY_MS;
const REC_OPEN_HOUSE_WINDOW_MS = 7 * DAY_MS;
const REC_REVIEW_LOOKBACK_MS = 14 * DAY_MS;
// Cap on how many fresh listing recommendations a single
// evaluator tick may emit. Without this, a workspace importing
// 30 listings in one pass would flood the Inbox. Existing recs
// stay visible across runs — only new emissions are capped.
const REC_MAX_NEW_LISTINGS_PER_RUN = 3;

// Normalize address-like strings so two records pointing at the
// same real-world property collapse onto the same dedup key.
// Lowercased, alphanumerics + spaces only, single-spaced. Keeps
// "508 King George Court" and "508  king  george court," the
// same.
function normalizeAddressKey(value) {
  if (typeof value !== "string") return "";
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Pull the street-address chunk out of a title like
// "508 King George Court, Springboro, OH, 45066" so two records
// — one with the address in dataJson, one with the address only
// in item.title — collapse onto the same dedup key. Returns the
// first comma-separated chunk, or the whole string when there
// are no commas.
function streetFromTitle(title) {
  if (typeof title !== "string" || title.trim().length === 0) return "";
  const first = title.split(",")[0];
  return first.trim();
}

// Build the dedup key for a listing. Strongest signal first:
// MLS / external id, then bare street address (so a record
// missing city/state still collapses with a richer record at
// the same street), then full normalized title.
function listingDedupKey(item) {
  const data = (item?.dataJson && typeof item.dataJson === "object") ? item.dataJson : {};
  const ext = data.externalListingId ?? data.mlsId ?? data.mls_id ?? data.external_id;
  if (typeof ext === "string" && ext.length > 0) return `ext:${ext}`;
  if (typeof ext === "number") return `ext:${ext}`;
  // Prefer the street-address-only key over a full city/state/zip
  // composite. Different records of the same property may carry
  // different levels of address detail (just street vs. full
  // postal), and we want all of them to collapse.
  const street =
    normalizeAddressKey(data.address) ||
    normalizeAddressKey(streetFromTitle(item?.title)) ||
    normalizeAddressKey(streetFromTitle(data.title));
  if (street) return `addr:${street}`;
  const titleKey = normalizeAddressKey(item?.title) || normalizeAddressKey(data.title);
  if (titleKey) return `title:${titleKey}`;
  return null;
}

// Score a listing for "richness" — used to pick which duplicate
// wins. Higher = better. Photos are the biggest signal because
// the channel-intersection step in generate drops Instagram
// without an image.
function listingRichnessScore(item) {
  const data = (item?.dataJson && typeof item.dataJson === "object") ? item.dataJson : {};
  let score = 0;
  if (typeof data.imageUrl === "string" && data.imageUrl.length > 0) score += 10;
  if (Array.isArray(data.images) && data.images.length > 0) score += 5;
  if (data.price != null) score += 2;
  if (data.bedrooms != null || data.beds != null) score += 1;
  if (data.bathrooms != null || data.baths != null) score += 1;
  if (data.sqft != null || data.squareFeet != null) score += 1;
  if (typeof data.description === "string" && data.description.length > 40) score += 1;
  return score;
}

// Build a launch headline + whatWeNoticed for a listing, using
// the address whenever present. Falls back through:
//   dataJson.address → item.title → dataJson.title → null
// item.title is the top-level WorkspaceDataItem.title column —
// the property-importer puts the full address ("508 King George
// Court, Springboro, OH, 45066") there even when dataJson is
// sparse.
function listingTitleFor(item) {
  const data = (item?.dataJson && typeof item.dataJson === "object") ? item.dataJson : {};
  if (typeof data.address === "string" && data.address.trim()) return data.address.trim();
  if (typeof item?.title === "string" && item.title.trim()) return item.title.trim();
  if (typeof data.title === "string" && data.title.trim()) return data.title.trim();
  return null;
}

async function detectAndPersistRecommendations({ workspaceId, reAssets, enabledChannels }) {
  let created = 0;
  let updated = 0;
  const channels = Array.isArray(enabledChannels) ? enabledChannels : [];

  // Spinstr04 — summary metadata for the activity panel. These
  // counts get persisted under metadata.summary on the AutopilotRun
  // row so the FE can render "Skipped 2 duplicates; capped at 3" or
  // similar instead of just "no new opportunities."
  const summary = {
    eligibleListings: 0,
    duplicatesSuppressed: 0,
    listingsCappedByRunLimit: 0,
    openHouseCandidates: 0,
    openHouseEmitted: 0,
    reviewsConsidered: 0,
    reviewsEmitted: 0,
    inactivityEmitted: false,
    noActionReason: null,
  };

  // Helper: bump counters off the upsert result.
  const tally = (res) => {
    if (!res) return;
    if (res.status === "created") created += 1;
    else if (res.status === "updated") updated += 1;
  };

  const now = Date.now();
  const listings = Array.isArray(reAssets?.listings) ? reAssets.listings : [];

  // ── NEW_LISTING ─────────────────────────────────────────────
  //
  // Three-step funnel:
  //   1. Filter to listings created in the lookback window.
  //   2. Group by dedup key (MLS id / normalized address / title)
  //      and pick the richest record in each group.
  //   3. Rank by richness desc, then by createdAt desc.
  //   4. Cap at REC_MAX_NEW_LISTINGS_PER_RUN.
  const recentListings = [];
  for (const entry of listings) {
    const item = entry?.source;
    if (!item?.id) continue;
    const ts = item.createdAt ? new Date(item.createdAt).getTime() : 0;
    if (!ts || now - ts > REC_LISTING_LOOKBACK_MS) continue;
    recentListings.push({ item, ts });
  }
  // Group by dedup key; pick the richest item per key. A null
  // dedup key (no address/title/mls) gets its own slot keyed
  // by item.id so it isn't lost.
  const byKey = new Map();
  for (const { item, ts } of recentListings) {
    const key = listingDedupKey(item) ?? `id:${item.id}`;
    const richness = listingRichnessScore(item);
    const existing = byKey.get(key);
    if (!existing || richness > existing.richness) {
      byKey.set(key, { item, ts, richness, dedupKey: key });
    }
  }
  // Rank: richness desc, then newest first.
  const ranked = [...byKey.values()].sort((a, b) => {
    if (b.richness !== a.richness) return b.richness - a.richness;
    return b.ts - a.ts;
  });
  const newListingPicks = ranked.slice(0, REC_MAX_NEW_LISTINGS_PER_RUN);
  summary.eligibleListings = ranked.length;
  summary.duplicatesSuppressed = recentListings.length - byKey.size;
  summary.listingsCappedByRunLimit = Math.max(0, ranked.length - newListingPicks.length);

  for (const pick of newListingPicks) {
    const item = pick.item;
    const data = (item.dataJson && typeof item.dataJson === "object") ? item.dataJson : {};
    const title = listingTitleFor(item) ?? "your new listing";
    const priceText =
      typeof data.price === "string" || typeof data.price === "number"
        ? ` (listed at ${data.price})`
        : "";
    const channelsForCopy = channels.slice(0, 4);
    const channelText =
      channelsForCopy.length > 0
        ? channelsForCopy.join(", ")
        : "your connected social channels";
    tally(
      await upsertRecommendation({
        clientId: workspaceId,
        triggerType: "NEW_LISTING",
        triggerObjectType: "listing",
        // Use the dedup key as the trigger object id so two
        // workspace data items pointing at the same property
        // collapse onto one recommendation. The richer record
        // wins the headline + payload.
        triggerObjectId: pick.dedupKey,
        headline: `New Listing: ${title}`,
        whatWeNoticed: `Autopilot noticed ${title}${priceText} is an active listing that hasn't been promoted yet.`,
        whyItMatters: `A launch campaign now can drive buyer interest while the listing is still fresh. Autopilot can prepare drafts for ${channelText} with a clear showing CTA.`,
        recommendedChannels: channelsForCopy,
        recommendedAngles: [
          "Just listed announcement",
          "Property highlight reel",
          "Neighborhood + price hook",
        ],
        expiresAt: new Date(pick.ts + REC_LISTING_LOOKBACK_MS),
        payloadJson: {
          propertyTitle: title,
          propertyAddress:
            typeof data.address === "string"
              ? data.address
              : typeof item.title === "string"
                ? item.title
                : null,
          propertyCity: typeof data.city === "string" ? data.city : null,
          propertyState: typeof data.state === "string" ? data.state : null,
          propertyZip:
            typeof data.zip === "string"
              ? data.zip
              : typeof data.zipCode === "string"
                ? data.zipCode
                : typeof data.postalCode === "string"
                  ? data.postalCode
                  : null,
          propertyPrice: data.price ?? null,
          propertyBeds: data.bedrooms ?? data.beds ?? null,
          propertyBaths: data.bathrooms ?? data.baths ?? null,
          propertySqft: data.sqft ?? data.squareFeet ?? null,
          propertyImageUrl:
            typeof data.imageUrl === "string" && data.imageUrl.length > 0
              ? data.imageUrl
              : Array.isArray(data.images) && typeof data.images[0] === "string"
                ? data.images[0]
                : null,
          propertyData: data,
          sourceDataItemId: item.id,
          dedupKey: pick.dedupKey,
          confidence: "high",
        },
      }),
    );
  }

  // ── OPEN_HOUSE ──────────────────────────────────────────────
  // Same dedup approach as NEW_LISTING so two property records
  // for the same address don't both spawn an open-house rec.
  const openHouseCandidates = [];
  for (const entry of listings) {
    const item = entry?.source;
    if (!item?.id) continue;
    const data = (item.dataJson && typeof item.dataJson === "object") ? item.dataJson : {};
    const events = Array.isArray(data.events) ? data.events : [];
    const upcoming = events.find((e) => {
      if (!e || typeof e !== "object") return false;
      if (e.type !== "open_house") return false;
      const t = e.date ? new Date(e.date).getTime() : 0;
      return t && t > now && t - now < REC_OPEN_HOUSE_WINDOW_MS;
    });
    if (!upcoming) continue;
    openHouseCandidates.push({ item, event: upcoming, richness: listingRichnessScore(item) });
  }
  summary.openHouseCandidates = openHouseCandidates.length;
  const byOpenHouseKey = new Map();
  for (const c of openHouseCandidates) {
    const key = listingDedupKey(c.item) ?? `id:${c.item.id}`;
    const existing = byOpenHouseKey.get(key);
    if (!existing || c.richness > existing.richness) {
      byOpenHouseKey.set(key, { ...c, dedupKey: key });
    }
  }
  summary.openHouseEmitted = byOpenHouseKey.size;
  for (const pick of byOpenHouseKey.values()) {
    const item = pick.item;
    const data = (item.dataJson && typeof item.dataJson === "object") ? item.dataJson : {};
    const title = listingTitleFor(item) ?? "your listing";
    const dateLabel = new Date(pick.event.date).toLocaleDateString();
    const channelsForCopy = channels.slice(0, 4);
    const channelText =
      channelsForCopy.length > 0
        ? channelsForCopy.join(", ")
        : "your connected social channels";
    tally(
      await upsertRecommendation({
        clientId: workspaceId,
        triggerType: "OPEN_HOUSE",
        triggerObjectType: "listing",
        triggerObjectId: pick.dedupKey,
        headline: `Open House: ${title}`,
        whatWeNoticed: `${title} has an open house scheduled for ${dateLabel}.`,
        whyItMatters: `Open-house posts shared 3–5 days out drive the most foot traffic. Autopilot can prepare reminder drafts for ${channelText}.`,
        recommendedChannels: channelsForCopy,
        recommendedAngles: [
          "Open-house invite + map",
          "What to expect on the tour",
          "Reminder post day-of",
        ],
        expiresAt: new Date(new Date(pick.event.date).getTime() + DAY_MS),
        payloadJson: {
          propertyTitle: title,
          propertyAddress:
            typeof data.address === "string"
              ? data.address
              : typeof item.title === "string"
                ? item.title
                : null,
          propertyImageUrl:
            typeof data.imageUrl === "string" && data.imageUrl.length > 0
              ? data.imageUrl
              : Array.isArray(data.images) && typeof data.images[0] === "string"
                ? data.images[0]
                : null,
          propertyData: data,
          sourceDataItemId: item.id,
          openHouseDate: pick.event.date,
          dedupKey: pick.dedupKey,
          confidence: "high",
        },
      }),
    );
  }

  // ── NEW_REVIEW ──────────────────────────────────────────────
  const reviews = Array.isArray(reAssets?.reviews) ? reAssets.reviews : [];
  for (const review of reviews) {
    if (!review?.id && !review?.reviewId) continue;
    const reviewId = String(review.id ?? review.reviewId);
    const createdAt = review.createdAt ? new Date(review.createdAt).getTime() : 0;
    if (createdAt && now - createdAt > REC_REVIEW_LOOKBACK_MS) continue;
    summary.reviewsConsidered += 1;
    const stars =
      typeof review.starRating === "number" && review.starRating >= 4
        ? review.starRating
        : null;
    if (!stars) continue;
    summary.reviewsEmitted += 1;
    const reviewerName =
      typeof review.reviewer === "string"
        ? review.reviewer
        : typeof review.reviewerName === "string"
          ? review.reviewerName
          : "A recent client";
    const channelsForCopy = channels.slice(0, 3);
    const channelText =
      channelsForCopy.length > 0
        ? channelsForCopy.join(", ")
        : "your connected social channels";
    tally(
      await upsertRecommendation({
        clientId: workspaceId,
        triggerType: "NEW_REVIEW",
        triggerObjectType: "review",
        triggerObjectId: reviewId,
        headline: `Testimonial: ${stars}-star review from ${reviewerName}`,
        whatWeNoticed: `${reviewerName} left a ${stars}-star review for your business.`,
        whyItMatters: `Testimonial posts build trust at the top of the funnel. Autopilot can prepare a social-proof draft for ${channelText} that quotes the review without revealing private client details.`,
        recommendedChannels: channelsForCopy,
        recommendedAngles: ["Testimonial quote graphic", "Thank-you reply post"],
        expiresAt: new Date(now + 30 * DAY_MS),
        payloadJson: {
          reviewerName,
          stars,
          confidence: "medium",
        },
      }),
    );
  }

  // ── INACTIVITY_GAP (workspace-scoped) ───────────────────────
  // Fallback so the Inbox never sits empty for long. Idempotent
  // by the fallback object id baked into upsertRecommendation.
  const lastDraft = await prisma.draft.findFirst({
    where: {
      clientId: workspaceId,
      status: { in: ["APPROVED", "SCHEDULED", "PUBLISHED"] },
    },
    orderBy: { createdAt: "desc" },
    select: { createdAt: true },
  });
  const lastPostMs = lastDraft?.createdAt ? new Date(lastDraft.createdAt).getTime() : 0;
  if (!lastPostMs || now - lastPostMs > REC_INACTIVITY_THRESHOLD_MS) {
    summary.inactivityEmitted = true;
    const days = lastPostMs ? Math.round((now - lastPostMs) / DAY_MS) : null;
    const channelsForCopy = channels.slice(0, 3);
    const channelText =
      channelsForCopy.length > 0
        ? channelsForCopy.join(", ")
        : "your connected social channels";
    tally(
      await upsertRecommendation({
        clientId: workspaceId,
        triggerType: "INACTIVITY_GAP",
        triggerObjectType: null,
        triggerObjectId: null,
        headline: "Re-engagement post — your audience hasn't heard from you",
        whatWeNoticed: days
          ? `It's been ${days} days since your last approved or published post.`
          : "We haven't seen any approved or published posts from this workspace yet.",
        whyItMatters: `Audiences quickly forget brands that go quiet. Autopilot can prepare an evergreen draft for ${channelText} to get you back in the feed without inventing property details.`,
        recommendedChannels: channelsForCopy,
        recommendedAngles: [
          "Catch-up market update",
          "Spotlight a best-selling listing",
          "Reintroduce yourself + your services",
        ],
        expiresAt: new Date(now + 7 * DAY_MS),
        payloadJson: {
          daysSinceLastPost: days,
          confidence: "low",
        },
      }),
    );
  }

  if (created === 0 && updated === 0) {
    if (summary.eligibleListings === 0 && summary.reviewsConsidered === 0 && !summary.inactivityEmitted) {
      summary.noActionReason = "No fresh listings, reviews, or inactivity signals in the lookback window.";
    } else if (summary.duplicatesSuppressed > 0 || summary.listingsCappedByRunLimit > 0) {
      summary.noActionReason = "Eligible listings were already represented by existing recommendations.";
    } else {
      summary.noActionReason = "Eligible signals exist, but every recommendation has already been recorded.";
    }
  }

  return {
    recommendationsCreated: created,
    recommendationsUpdated: updated,
    summary,
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

// ── Readiness check ──────────────────────────────────────────────────────

/** @param {string} workspaceId */
export async function getAutopilotReadiness(workspaceId) {
  const [channels, dataCount, client] = await Promise.all([
    prisma.channelSettings.findMany({
      where: { clientId: workspaceId, isEnabled: true },
      select: { channel: true },
    }),
    prisma.workspaceDataItem.count({
      where: { clientId: workspaceId, status: { not: "ARCHIVED" } },
    }),
    prisma.client.findUnique({
      where: { id: workspaceId },
      select: { brandProfile: true, voiceProfile: true },
    }),
  ]);

  const connectedChannels = channels;

  const checks = [
    {
      id: "channels",
      label: "At least 1 connected channel",
      met: connectedChannels.length > 0,
      fix: "Connect a publishing channel in Settings → Channels",
    },
    {
      id: "data",
      label: "Business data available",
      met: dataCount > 0,
      fix: "Add data sources in Sources",
    },
    {
      id: "brand",
      label: "Brand profile configured",
      met: !!client?.brandProfile,
      fix: "Set up your brand in Settings → Brand",
    },
  ];

  const ready = checks.every((c) => c.met);
  // Spinstr01 — full mode ladder. auto_publish_guarded is
  // intentionally NOT included in availableModes; the UI
  // renders it as a locked Coming Soon card and the schema
  // rejects it on save.
  const availableModes = [
    "off",
    "recommend_only",
    "draft_on_click",
    "auto_generate_drafts",
    "schedule_after_approval",
  ];

  return {
    ready,
    checks,
    availableModes,
    connectedChannels: connectedChannels.map((c) => c.channel),
    totalDataItems: dataCount,
  };
}

// ── Activity feed ────────────────────────────────────────────────────────

/** Parse autopilot metadata from warnings array. */
function parseWarningsMeta(warnings) {
  const meta = { trigger: null, reason: null, angle: null };
  if (!warnings) return meta;
  for (const w of warnings) {
    if (w.startsWith("autopilot_trigger:")) meta.trigger = w.split(":")[1]?.trim() ?? null;
    if (w.startsWith("autopilot_reason:")) meta.reason = w.split(":")[1]?.trim() ?? null;
    if (w.startsWith("autopilot_angle_label:")) meta.angle = w.split(":")[1]?.trim() ?? null;
  }
  return meta;
}

/** @param {string} workspaceId @param {number} [limit=20] */
export async function getAutopilotActivity(workspaceId, limit = 20) {
  const drafts = await prisma.draft.findMany({
    where: {
      clientId: workspaceId,
      OR: [
        { createdBy: "system:autopilot" },
        { createdBy: "system:auto_generate" },
      ],
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      channel: true,
      status: true,
      body: true,
      createdAt: true,
      publishedAt: true,
      warnings: true,
    },
  });

  return drafts.map((d) => {
    const meta = parseWarningsMeta(d.warnings);
    return {
      id: d.id,
      eventType:
        d.status === "PUBLISHED" ? "published"
          : d.status === "REJECTED" ? "skipped"
          : d.status === "FAILED" ? "failed"
          : d.status === "SCHEDULED" ? "scheduled"
          : "generated",
      channel: d.channel,
      status: d.status,
      body: d.body?.substring(0, 120) ?? null,
      trigger: meta.trigger,
      reason: meta.reason,
      angle: meta.angle,
      createdAt: d.createdAt?.toISOString(),
      publishedAt: d.publishedAt?.toISOString() ?? null,
    };
  });
}
