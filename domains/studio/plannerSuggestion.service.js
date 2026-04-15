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

const OPTIMAL_HOURS = [9, 12, 15, 18];
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
  }

  const allAngleCategories = ["listing", "buyer", "lifestyle", "authority"];
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

  // Distribute suggestions across gap days at optimal hours
  const distributed = [];
  let gapIdx = 0;
  let hourIdx = 0;
  const daySlotCount = {}; // track how many suggestions per day

  for (const suggestion of suggestions) {
    if (gapIdx >= coverage.gapDays.length) break;

    const targetDay = coverage.gapDays[gapIdx];
    daySlotCount[targetDay] = (daySlotCount[targetDay] ?? 0) + 1;

    const { angleLabel, angleCategory } = resolveAngleLabel(suggestion.angle);

    distributed.push({
      id: `ps_${Date.now()}_${distributed.length}`,
      suggestedDate: targetDay,
      suggestedHour: OPTIMAL_HOURS[hourIdx % OPTIMAL_HOURS.length],
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

  return {
    suggestions: distributed,
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

  // Re-derive coverageGaps from missingAngleCategories
  const coverageGaps = [];
  if (coverage.missingAngleCategories.includes("listing")) coverageGaps.push("No listing content");
  if (coverage.missingAngleCategories.includes("authority")) coverageGaps.push("No authority/insight content");
  if (coverage.missingAngleCategories.includes("lifestyle")) coverageGaps.push("No lifestyle content");
  if (coverage.missingAngleCategories.includes("buyer")) coverageGaps.push("No buyer-focused content");

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
      suggestedHour: OPTIMAL_HOURS[0],
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
