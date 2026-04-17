// Planner suggestion service — composes existing autopilot + opportunity services
// to provide ghost suggestions for the calendar planner.
//
// Three functions:
//   getPlannerSuggestions — identify gap days, get ranked suggestions, assign to days
//   planMyWeek           — generate + schedule drafts for all gaps in one click
//   swapSuggestion       — replace a dismissed suggestion with a fresh one

import { prisma } from "../../prisma.js";
import { previewAutopilot, executeAutopilot } from "./dataAwareAutopilot.service.js";
import { CONTENT_ANGLES } from "./contentAngles.js";
import { getOptimalHours } from "./postTiming.js";
import { getRecommendations } from "./recommendationEngine.service.js";

const DEFAULT_OPTIMAL_HOURS = [9, 12, 15, 18];
const WEEKLY_TARGET = 5;
const MAX_PER_DAY = 2;

// ── Helpers ──────────────────────────────────────────────────────────────

function toDateKey(date) {
  const d = new Date(date);
  return d.toISOString().slice(0, 10); // "2026-04-16"
}

function daysBetween(start, end) {
  const days = [];
  const cur = new Date(start);
  const last = new Date(end);
  while (cur <= last) {
    days.push(toDateKey(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

function resolveAngleLabel(angleKey) {
  if (!angleKey) return { angleLabel: null, angleCategory: null };
  const angle = CONTENT_ANGLES[angleKey];
  if (!angle) return { angleLabel: null, angleCategory: null };
  return { angleLabel: angle.label, angleCategory: angle.category };
}

// ── Coverage evaluation (lightweight planner version) ────────────────────

async function evaluatePlannerCoverage(clientId, weekStart, weekEnd) {
  const drafts = await prisma.draft.findMany({
    where: {
      clientId,
      status: { not: "FAILED" },
      OR: [
        { scheduledFor: { gte: new Date(weekStart), lte: new Date(weekEnd) } },
        { publishedAt: { gte: new Date(weekStart), lte: new Date(weekEnd) } },
      ],
    },
    select: {
      id: true,
      channel: true,
      scheduledFor: true,
      publishedAt: true,
      status: true,
      warnings: true,
    },
  });

  // Group by day
  const draftsByDay = {};
  for (const d of drafts) {
    const date = d.scheduledFor ?? d.publishedAt;
    if (!date) continue;
    const key = toDateKey(date);
    if (!draftsByDay[key]) draftsByDay[key] = [];
    draftsByDay[key].push(d);
  }

  // Count published vs scheduled
  const published = drafts.filter((d) => d.status === "PUBLISHED").length;
  const scheduled = drafts.filter((d) => d.status === "SCHEDULED").length;

  // Channel coverage
  const channelSet = new Set(drafts.map((d) => d.channel));

  // Content type coverage via warnings
  const angleCategories = new Set();
  for (const d of drafts) {
    const ws = d.warnings ?? [];
    if (ws.some((w) => w.includes("listing"))) angleCategories.add("listing");
    if (ws.some((w) => w.includes("testimonial") || w.includes("review"))) angleCategories.add("social_proof");
    if (ws.some((w) => w.includes("fallback") || w.includes("market"))) angleCategories.add("authority");
    if (ws.some((w) => w.includes("growth") || w.includes("Type: growth"))) angleCategories.add("growth");
  }

  const allAngleCategories = ["listing", "buyer", "lifestyle", "authority", "growth"];
  const missingAngleCategories = allAngleCategories.filter((c) => !angleCategories.has(c));

  // Find gap days (< MAX_PER_DAY posts)
  const allDays = daysBetween(weekStart, weekEnd);
  const gapDays = allDays.filter((day) => (draftsByDay[day]?.length ?? 0) < MAX_PER_DAY);

  return {
    draftsByDay,
    published,
    scheduled,
    channelSet,
    missingAngleCategories,
    gapDays,
    totalDrafts: drafts.length,
  };
}

// ── getPlannerSuggestions ─────────────────────────────────────────────────

export async function getPlannerSuggestions(clientId, { weekStart, weekEnd }) {
  const coverage = await evaluatePlannerCoverage(clientId, weekStart, weekEnd);

  // How many suggestions do we need?
  const suggestionsNeeded = Math.max(0, WEEKLY_TARGET - coverage.totalDrafts);
  if (suggestionsNeeded === 0) {
    return {
      suggestions: [],
      weekSummary: buildWeekSummary(coverage, 0),
    };
  }

  // Get ranked suggestions from existing autopilot preview
  let suggestions = [];
  try {
    const result = await previewAutopilot(clientId, { count: suggestionsNeeded });
    suggestions = result.suggestions ?? [];
  } catch {
    // No data items or opportunities — return empty with summary
    return {
      suggestions: [],
      weekSummary: buildWeekSummary(coverage, 0),
    };
  }

  // Distribute suggestions across gap days at channel-aware optimal hours
  const distributed = [];
  let gapIdx = 0;
  let hourIdx = 0;
  const daySlotCount = {}; // track how many suggestions per day

  // Use channel-aware timing when possible, fall back to defaults
  const primaryChannel = coverage.channelSet.size > 0
    ? [...coverage.channelSet][0]
    : null;
  const optimalHours = primaryChannel
    ? getOptimalHours(primaryChannel, 4)
    : DEFAULT_OPTIMAL_HOURS;

  for (const suggestion of suggestions) {
    if (gapIdx >= coverage.gapDays.length) break;

    const targetDay = coverage.gapDays[gapIdx];
    daySlotCount[targetDay] = (daySlotCount[targetDay] ?? 0) + 1;

    const { angleLabel, angleCategory } = resolveAngleLabel(suggestion.angle);

    distributed.push({
      id: `ps_${Date.now()}_${distributed.length}`,
      suggestedDate: targetDay,
      suggestedHour: optimalHours[hourIdx % optimalHours.length],
      rank: suggestion.rank,
      dataItem: suggestion.dataItem,
      blueprint: suggestion.blueprint,
      opportunityScore: suggestion.opportunityScore,
      adjustedScore: suggestion.adjustedScore,
      angle: suggestion.angle ?? null,
      angleLabel,
      angleCategory,
      reasoning: suggestion.reasoning,
      channel: null, // will be resolved by client if workspace has preferred channels
    });

    hourIdx++;
    // Move to next gap day after MAX_PER_DAY slots
    if (daySlotCount[targetDay] >= MAX_PER_DAY) {
      gapIdx++;
      hourIdx = 0;
    }
  }

  // ── Fetch campaign + action recommendations from unified engine ─────
  let campaignSuggestions = [];
  let engineInsights = null;
  try {
    const { recommendations: engineRecs, summary } = await getRecommendations(clientId, {
      surface: "planner",
      limit: 4,
    });

    // Separate campaign recommendations from other signals
    const campaignTypes = new Set([
      "listing_campaign", "milestone_campaign",
      "open_house_campaign", "price_drop_campaign",
    ]);

    campaignSuggestions = engineRecs
      .filter((r) => campaignTypes.has(r.type))
      .slice(0, 2)
      .map((r) => ({
        id: `pc_${Date.now()}_${r.id}`,
        type: r.type,
        title: r.title,
        description: r.description,
        sourceId: r.sourceId,
        sourceLabel: r.sourceLabel,
        priorityScore: r.priorityScore,
        confidence: r.confidence,
        actionLabel: r.actionLabel,
        actionPayload: r.actionPayload,
        suggestedCampaignType: r.suggestedCampaignType,
        reasons: r.reasons,
      }));

    // Extract engine insights for content mix health
    engineInsights = {
      growthScore: summary.growthScore ?? null,
      daysSinceLastGeneration: summary.daysSinceLastGeneration ?? null,
      contentMixHealth: summary.publishedThisWeek >= 3 ? "healthy" : summary.publishedThisWeek >= 1 ? "fair" : "low",
    };
  } catch {
    // Non-critical — planner works without engine intelligence
  }

  return {
    suggestions: distributed,
    campaignSuggestions,
    engineInsights,
    weekSummary: buildWeekSummary(coverage, distributed.length),
  };
}

function buildWeekSummary(coverage, projected) {
  const total = coverage.published + coverage.scheduled + projected;
  const gap = Math.max(0, WEEKLY_TARGET - (coverage.published + coverage.scheduled));

  let status;
  if (coverage.published + coverage.scheduled >= WEEKLY_TARGET) status = "ahead";
  else if (total >= WEEKLY_TARGET) status = "on_track";
  else status = "below";

  // Re-derive coverageGaps with auto-fill suggestions
  const GAP_SUGGESTIONS = {
    listing: {
      label: "No listing content",
      suggestion: "Feature a property listing",
      guidance: "Create a listing spotlight post featuring a property with key details, photos, and a showing CTA",
      contentType: "listing",
    },
    authority: {
      label: "No authority/insight content",
      suggestion: "Share a market insight",
      guidance: "Create a market update post sharing current trends and data that demonstrates your local expertise",
      contentType: "market_update",
    },
    lifestyle: {
      label: "No lifestyle content",
      suggestion: "Highlight a neighborhood",
      guidance: "Create a neighborhood lifestyle post painting a picture of what it's like to live in a specific area",
      contentType: "personal",
    },
    buyer: {
      label: "No buyer-focused content",
      suggestion: "Post a buyer tip",
      guidance: "Create an educational post with practical tips for home buyers — first-time buyer advice or investment insights",
      contentType: "educational",
    },
    growth: {
      label: "No growth/discovery content",
      suggestion: "Create a curiosity-driven post",
      guidance: "[Type: growth] Create a post designed to attract new followers — use a curiosity hook, share surprising value, and include a follow CTA",
      contentType: "growth",
    },
  };

  const coverageGaps = coverage.missingAngleCategories.map((cat) => {
    const config = GAP_SUGGESTIONS[cat];
    if (!config) return { label: `No ${cat} content`, category: cat };
    return {
      label: config.label,
      category: cat,
      suggestion: config.suggestion,
      guidance: config.guidance,
      contentType: config.contentType,
    };
  });

  return {
    published: coverage.published,
    scheduled: coverage.scheduled,
    projected: total,
    target: WEEKLY_TARGET,
    gap,
    gapDays: coverage.gapDays,
    coverageGaps,
    missingAngleCategories: coverage.missingAngleCategories,
    status,
  };
}

// ── planMyWeek ───────────────────────────────────────────────────────────

export async function planMyWeek(
  clientId,
  actorSub,
  { weekStart, weekEnd, generateDraft, scheduleDraft, checkUsageLimit, incrementUsage, userId }
) {
  // Get suggestions first
  const { suggestions } = await getPlannerSuggestions(clientId, { weekStart, weekEnd });

  if (suggestions.length === 0) {
    return { generated: 0, scheduled: 0, total: 0, results: [] };
  }

  // Map suggestions to the format executeAutopilot expects
  const mapped = suggestions.map((s) => ({
    dataItem: { id: s.dataItem.id },
    blueprint: { id: s.blueprint.id },
  }));

  const result = await executeAutopilot(clientId, actorSub, {
    suggestions: mapped,
    autoSchedule: true,
    generateDraft,
    scheduleDraft,
    checkUsageLimit,
    incrementUsage,
    userId,
  });

  return result;
}

// ── swapSuggestion ───────────────────────────────────────────────────────

export async function swapSuggestion(clientId, { excludeDataItemIds, targetDate, channel }) {
  let suggestions = [];
  try {
    const result = await previewAutopilot(clientId, {
      count: 1,
      channel: channel || undefined,
      excludeDataItemIds: excludeDataItemIds || [],
    });
    suggestions = result.suggestions ?? [];
  } catch {
    return { suggestion: null };
  }

  if (suggestions.length === 0) {
    return { suggestion: null };
  }

  const s = suggestions[0];
  const { angleLabel, angleCategory } = resolveAngleLabel(s.angle);

  return {
    suggestion: {
      id: `ps_${Date.now()}_swap`,
      suggestedDate: targetDate,
      suggestedHour: (channel ? getOptimalHours(channel, 1) : DEFAULT_OPTIMAL_HOURS)[0],
      rank: s.rank,
      dataItem: s.dataItem,
      blueprint: s.blueprint,
      opportunityScore: s.opportunityScore,
      adjustedScore: s.adjustedScore,
      angle: s.angle ?? null,
      angleLabel,
      angleCategory,
      reasoning: s.reasoning,
      channel: channel || null,
    },
  };
}
