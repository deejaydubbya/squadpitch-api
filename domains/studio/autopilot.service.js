// Real Estate Autopilot v1.
//
// A controlled system that watches listings, reviews, cadence, and connected
// channels, then automatically creates ready-to-review drafts when simple
// rules indicate a good post opportunity.
//
// What Autopilot v1 does:
//   - Evaluates triggers (new listing, inactivity, new review, channel gap)
//   - Makes rule-based decisions (priority-ordered, guardrail-checked)
//   - Generates DRAFT-status content via the existing generation pipeline
//   - Labels every draft with transparent metadata (trigger, reason, asset)
//
// What Autopilot v1 does NOT do:
//   - No auto-publish — all output is DRAFT status
//   - No black-box strategy engine — every decision is explainable
//   - No uncontrolled posting — hard weekly/daily limits enforced
//   - No other industries — real estate only in this version

import { prisma } from "../../prisma.js";
import { resolveRealEstateContext } from "../industry/techStack.service.js";
import { loadRealEstateGenerationAssets } from "../industry/realEstateGeneration.js";
import { generateDraft } from "./generation/aiGenerationService.js";
import { formatDraft } from "./draft.service.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const AUTOPILOT_PROVIDER_KEY = "_autopilot_settings";

// ── Default settings ─────────────────────────────────────────────────────

const DEFAULT_SETTINGS = {
  enabled: false,
  mode: "off",                  // "off" | "draft_assist"
  preferredChannels: [],        // e.g. ["FACEBOOK", "INSTAGRAM"]
  maxDraftsPerWeek: 3,
  minimumHoursBetweenDrafts: 24,
  allowListingPosts: true,
  allowTestimonialPosts: true,
  allowFallbackPosts: true,
};

// ── Settings CRUD ────────────────────────────────────────────────────────

/**
 * @param {string} workspaceId
 * @returns {Promise<typeof DEFAULT_SETTINGS>}
 */
export async function getAutopilotSettings(workspaceId) {
  const row = await prisma.workspaceTechStackConnection.findUnique({
    where: { workspaceId_providerKey: { workspaceId, providerKey: AUTOPILOT_PROVIDER_KEY } },
  });
  return { ...DEFAULT_SETTINGS, ...(row?.metadataJson ?? {}) };
}

/**
 * @param {string} workspaceId
 * @param {Partial<typeof DEFAULT_SETTINGS>} patch
 */
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

// ── Trigger evaluation ───────────────────────────────────────────────────

/**
 * @typedef {{ triggerType: string, reason: string, eligible: boolean, supportingData?: object }} TriggerResult
 */

/**
 * Evaluate all autopilot triggers for a real estate workspace.
 *
 * @param {string} workspaceId
 * @param {object} reAssets - from loadRealEstateGenerationAssets
 * @param {object} settings - autopilot settings
 * @returns {Promise<TriggerResult[]>}
 */
async function evaluateTriggers(workspaceId, reAssets, settings) {
  const triggers = [];

  // Find most recent autopilot draft and most recent draft overall
  const [lastAutopilotDraft, lastAnyDraft, recentNewListings, recentNewReviews] = await Promise.all([
    prisma.draft.findFirst({
      where: { clientId: workspaceId, createdBy: "system:autopilot" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, warnings: true },
    }),
    prisma.draft.findFirst({
      where: { clientId: workspaceId, status: { not: "FAILED" } },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
    // Listings added in last 24 hours
    prisma.workspaceDataItem.count({
      where: {
        clientId: workspaceId,
        type: "CUSTOM",
        status: "ACTIVE",
        createdAt: { gte: new Date(Date.now() - DAY_MS) },
      },
    }),
    // Reviews added in last 48 hours
    prisma.workspaceDataItem.count({
      where: {
        clientId: workspaceId,
        type: "TESTIMONIAL",
        status: "ACTIVE",
        createdAt: { gte: new Date(Date.now() - 2 * DAY_MS) },
      },
    }),
  ]);

  // A. new_listing — recent listing imports exist
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

  // B. inactivity_gap — no content in 3+ days
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

  // C. new_review — recent testimonial/review data added
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

  // D. channel_gap — a connected channel has no recent autopilot content
  const enabledChannels = await prisma.channelSettings.findMany({
    where: { clientId: workspaceId, isEnabled: true },
    select: { channel: true },
  });
  if (enabledChannels.length > 0) {
    const recentChannelDrafts = await prisma.draft.groupBy({
      by: ["channel"],
      where: {
        clientId: workspaceId,
        createdAt: { gte: new Date(Date.now() - 7 * DAY_MS) },
        status: { not: "FAILED" },
      },
      _count: { _all: true },
    });
    const recentChannelSet = new Set(recentChannelDrafts.map((r) => r.channel));
    const gapChannels = enabledChannels
      .map((c) => c.channel)
      .filter((ch) => !recentChannelSet.has(ch));

    if (gapChannels.length > 0) {
      triggers.push({
        triggerType: "channel_gap",
        reason: `${gapChannels.join(", ")} ha${gapChannels.length === 1 ? "s" : "ve"} no content this week`,
        eligible: true,
        supportingData: { gapChannels },
      });
    }
  }

  return triggers;
}

// ── Guardrails ───────────────────────────────────────────────────────────

/**
 * Check if autopilot is allowed to create a draft right now.
 * Returns { allowed: true } or { allowed: false, reason: string }.
 */
async function checkGuardrails(workspaceId, settings) {
  const now = Date.now();
  const minSpacingMs = (settings.minimumHoursBetweenDrafts ?? 24) * 60 * 60 * 1000;

  // Count autopilot drafts this week (Mon-Sun)
  const dayOfWeek = new Date().getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date();
  weekStart.setUTCDate(weekStart.getUTCDate() - mondayOffset);
  weekStart.setUTCHours(0, 0, 0, 0);

  const [weekCount, lastAutopilot] = await Promise.all([
    prisma.draft.count({
      where: {
        clientId: workspaceId,
        createdBy: "system:autopilot",
        createdAt: { gte: weekStart },
      },
    }),
    prisma.draft.findFirst({
      where: { clientId: workspaceId, createdBy: "system:autopilot" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true },
    }),
  ]);

  // Weekly limit
  if (weekCount >= (settings.maxDraftsPerWeek ?? 3)) {
    return { allowed: false, reason: `Weekly limit reached (${weekCount}/${settings.maxDraftsPerWeek ?? 3})` };
  }

  // Minimum spacing
  if (lastAutopilot) {
    const elapsed = now - lastAutopilot.createdAt.getTime();
    if (elapsed < minSpacingMs) {
      const hoursLeft = Math.ceil((minSpacingMs - elapsed) / (60 * 60 * 1000));
      return { allowed: false, reason: `Too soon — next autopilot draft in ~${hoursLeft}h` };
    }
  }

  // Daily limit (hard cap: 1 per day)
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const todayCount = await prisma.draft.count({
    where: {
      clientId: workspaceId,
      createdBy: "system:autopilot",
      createdAt: { gte: todayStart },
    },
  });
  if (todayCount >= 1) {
    return { allowed: false, reason: "Daily autopilot limit reached (1/day)" };
  }

  return { allowed: true };
}

// ── Decision engine ──────────────────────────────────────────────────────

/**
 * @typedef {{ reasonCode: string, templateType: string, channel: string, dataItemId?: string, guidance: string, sourceType: string, triggerType: string }} DraftPlan
 */

/**
 * Make a rule-based decision on what to generate.
 * Returns a draft plan or null (do nothing).
 *
 * @param {TriggerResult[]} triggers
 * @param {object} reAssets
 * @param {object} settings
 * @param {string[]} enabledChannels
 * @returns {DraftPlan | null}
 */
function makeDecision(triggers, reAssets, settings, enabledChannels) {
  const eligible = triggers.filter((t) => t.eligible);
  if (eligible.length === 0) return null;

  // Resolve target channel
  const preferred = settings.preferredChannels?.length > 0
    ? settings.preferredChannels
    : null;
  const channelOrder = ["FACEBOOK", "INSTAGRAM", "LINKEDIN", "X"];
  const pickChannel = () => {
    if (preferred) {
      const match = preferred.find((c) => enabledChannels.includes(c));
      if (match) return match;
    }
    return channelOrder.find((c) => enabledChannels.includes(c)) ?? enabledChannels[0];
  };

  // Priority 1: New listing post
  const newListing = eligible.find((t) => t.triggerType === "new_listing");
  if (newListing && settings.allowListingPosts && reAssets.bestListing && reAssets.bestListingSource) {
    const listingLabel = reAssets.bestListing.title || reAssets.bestListing.address || "property";
    return {
      reasonCode: "listing_import",
      templateType: "listing_post",
      channel: pickChannel(),
      dataItemId: reAssets.bestListingSource.id,
      guidance: `Create a 'just listed' post for ${listingLabel}. Highlight the best features.`,
      sourceType: "listing",
      triggerType: "new_listing",
    };
  }

  // Priority 2: Testimonial post from new review
  const newReview = eligible.find((t) => t.triggerType === "new_review");
  if (newReview && settings.allowTestimonialPosts && reAssets.reviews?.length > 0) {
    return {
      reasonCode: "new_review",
      templateType: "client_testimonial",
      channel: pickChannel(),
      guidance: "Create a testimonial post using a real client review. Quote accurately and build trust.",
      sourceType: "review",
      triggerType: "new_review",
    };
  }

  // Priority 3: Inactivity — use best available asset
  const inactivity = eligible.find((t) => t.triggerType === "inactivity_gap");
  if (inactivity) {
    // Prefer listing if available
    if (settings.allowListingPosts && reAssets.bestListing && reAssets.bestListingSource) {
      const listingLabel = reAssets.bestListing.title || reAssets.bestListing.address || "a property";
      return {
        reasonCode: "inactivity_listing",
        templateType: "featured_property",
        channel: pickChannel(),
        dataItemId: reAssets.bestListingSource.id,
        guidance: `Feature ${listingLabel} to keep content flowing. Highlight value and location.`,
        sourceType: "listing",
        triggerType: "inactivity_gap",
      };
    }
    // Review-based fallback
    if (settings.allowTestimonialPosts && reAssets.reviews?.length > 0) {
      return {
        reasonCode: "inactivity_review",
        templateType: "client_testimonial",
        channel: pickChannel(),
        guidance: "Create a testimonial post to maintain posting consistency.",
        sourceType: "review",
        triggerType: "inactivity_gap",
      };
    }
    // Generic fallback
    if (settings.allowFallbackPosts) {
      return {
        reasonCode: "inactivity_fallback",
        templateType: "market_update",
        channel: pickChannel(),
        guidance: "Create a real estate market insight or tip post to maintain posting consistency.",
        sourceType: "fallback",
        triggerType: "inactivity_gap",
      };
    }
  }

  // Priority 4: Channel gap — fill an underserved channel
  const channelGap = eligible.find((t) => t.triggerType === "channel_gap");
  if (channelGap) {
    const gapChannel = channelGap.supportingData?.gapChannels?.[0];
    if (gapChannel && enabledChannels.includes(gapChannel)) {
      // Use best available asset for the gap channel
      if (settings.allowListingPosts && reAssets.bestListing && reAssets.bestListingSource) {
        return {
          reasonCode: "channel_gap_listing",
          templateType: "listing_post",
          channel: gapChannel,
          dataItemId: reAssets.bestListingSource.id,
          guidance: `Create a listing post for ${gapChannel} — this channel needs fresh content.`,
          sourceType: "listing",
          triggerType: "channel_gap",
        };
      }
      if (settings.allowFallbackPosts) {
        return {
          reasonCode: "channel_gap_fallback",
          templateType: "market_update",
          channel: gapChannel,
          guidance: `Create a real estate post for ${gapChannel} — this channel has had no content this week.`,
          sourceType: "fallback",
          triggerType: "channel_gap",
        };
      }
    }
  }

  return null;
}

// ── Run orchestration ────────────────────────────────────────────────────

/**
 * Run the autopilot evaluation + generation pipeline for a workspace.
 *
 * @param {string} workspaceId
 * @returns {Promise<{ action: "generated" | "no_action", draft?: object, reason: string, triggers: TriggerResult[], decision?: DraftPlan | null }>}
 */
export async function runAutopilot(workspaceId) {
  // 1. Validate workspace is real estate
  const client = await prisma.client.findUnique({
    where: { id: workspaceId },
    select: { industryKey: true },
  });
  if (!client || client.industryKey !== "real_estate") {
    return { action: "no_action", reason: "Autopilot is only available for real estate workspaces", triggers: [] };
  }

  // 2. Load settings
  const settings = await getAutopilotSettings(workspaceId);
  if (!settings.enabled || settings.mode === "off") {
    return { action: "no_action", reason: "Autopilot is disabled", triggers: [] };
  }

  // 3. Check guardrails first
  const guardrail = await checkGuardrails(workspaceId, settings);
  if (!guardrail.allowed) {
    return { action: "no_action", reason: guardrail.reason, triggers: [] };
  }

  // 4. Load real estate context + assets
  let reContext;
  try {
    reContext = await resolveRealEstateContext(workspaceId);
  } catch {
    return { action: "no_action", reason: "Failed to resolve real estate context", triggers: [] };
  }

  let reAssets;
  try {
    reAssets = await loadRealEstateGenerationAssets(workspaceId, reContext);
  } catch {
    return { action: "no_action", reason: "Failed to load real estate assets", triggers: [] };
  }

  // 5. Evaluate triggers
  const triggers = await evaluateTriggers(workspaceId, reAssets, settings);

  // 6. Get enabled channels
  const channelRows = await prisma.channelSettings.findMany({
    where: { clientId: workspaceId, isEnabled: true },
    select: { channel: true },
  });
  const enabledChannels = channelRows.map((c) => c.channel);
  if (enabledChannels.length === 0) {
    return { action: "no_action", reason: "No channels enabled", triggers };
  }

  // 7. Make decision
  const decision = makeDecision(triggers, reAssets, settings, enabledChannels);
  if (!decision) {
    return { action: "no_action", reason: "No suitable action found", triggers, decision: null };
  }

  // 8. Check for duplicate — don't create listing post for same item within 48h
  if (decision.dataItemId) {
    const recentDupe = await prisma.draft.findFirst({
      where: {
        clientId: workspaceId,
        createdBy: "system:autopilot",
        createdAt: { gte: new Date(Date.now() - 2 * DAY_MS) },
        warnings: { hasSome: [`autopilot_asset: ${decision.dataItemId}`] },
      },
    });
    if (recentDupe) {
      return {
        action: "no_action",
        reason: `Skipped — autopilot already used this asset within 48 hours`,
        triggers,
        decision,
      };
    }
  }

  // 9. Generate draft via existing pipeline
  try {
    const draft = await generateDraft({
      clientId: workspaceId,
      kind: "POST",
      channel: decision.channel,
      guidance: decision.guidance,
      templateType: decision.templateType,
      createdBy: "system:autopilot",
      dataItemId: decision.dataItemId,
      recommendationId: `autopilot_${decision.reasonCode}`,
    });

    // 10. Append autopilot-specific warnings for transparency
    const autopilotWarnings = [
      `autopilot: true`,
      `autopilot_trigger: ${decision.triggerType}`,
      `autopilot_reason: ${decision.reasonCode}`,
      `autopilot_channel: ${decision.channel}`,
      ...(decision.dataItemId ? [`autopilot_asset: ${decision.dataItemId}`] : []),
    ];

    // Merge warnings into the draft record
    await prisma.draft.update({
      where: { id: draft.id },
      data: {
        warnings: [...(draft.warnings ?? []), ...autopilotWarnings],
      },
    });

    // Re-read for clean output
    const updated = await prisma.draft.findUnique({ where: { id: draft.id } });

    return {
      action: "generated",
      draft: formatDraft(updated),
      reason: `Generated ${decision.templateType} for ${decision.channel} — trigger: ${decision.triggerType}`,
      triggers,
      decision,
    };
  } catch (err) {
    return {
      action: "no_action",
      reason: `Generation failed: ${err.message ?? "unknown error"}`,
      triggers,
      decision,
    };
  }
}

// ── Status (for dashboard) ───────────────────────────────────────────────

/**
 * Get autopilot status for dashboard display.
 * @param {string} workspaceId
 */
export async function getAutopilotStatus(workspaceId) {
  const settings = await getAutopilotSettings(workspaceId);

  // Weekly boundaries
  const dayOfWeek = new Date().getUTCDay();
  const mondayOffset = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date();
  weekStart.setUTCDate(weekStart.getUTCDate() - mondayOffset);
  weekStart.setUTCHours(0, 0, 0, 0);

  const [draftsThisWeek, lastAction] = await Promise.all([
    prisma.draft.count({
      where: {
        clientId: workspaceId,
        createdBy: "system:autopilot",
        createdAt: { gte: weekStart },
      },
    }),
    prisma.draft.findFirst({
      where: { clientId: workspaceId, createdBy: "system:autopilot" },
      orderBy: { createdAt: "desc" },
      select: { createdAt: true, warnings: true, channel: true },
    }),
  ]);

  // Parse last action type from warnings
  let lastActionType = null;
  if (lastAction?.warnings) {
    const triggerWarning = lastAction.warnings.find((w) => w.startsWith("autopilot_trigger:"));
    if (triggerWarning) lastActionType = triggerWarning.split(":")[1]?.trim();
  }

  return {
    enabled: settings.enabled && settings.mode !== "off",
    mode: settings.mode,
    maxDraftsPerWeek: settings.maxDraftsPerWeek,
    draftsThisWeek,
    lastActionAt: lastAction?.createdAt?.toISOString() ?? null,
    lastActionType,
    lastActionChannel: lastAction?.channel ?? null,
  };
}
