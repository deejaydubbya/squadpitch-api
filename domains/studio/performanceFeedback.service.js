// Performance Feedback Service.
//
// Stores user-submitted performance ratings on published drafts
// and aggregates patterns to adapt content generation and recommendations.
//
// Three core functions:
//   rateDraft             — store a HIGH/AVERAGE/LOW rating on a published draft
//   getPerformanceProfile — aggregate patterns for generation prompt injection
//   getPerformanceInsights — lightweight user-facing insights

import { prisma } from "../../prisma.js";

const VALID_RATINGS = ["HIGH", "AVERAGE", "LOW"];

// ── rateDraft ────────────────────────────────────────────────────────────

export async function rateDraft(draftId, { rating }) {
  if (!VALID_RATINGS.includes(rating)) {
    throw Object.assign(new Error(`Invalid rating: ${rating}`), { status: 400 });
  }

  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    select: { id: true, status: true },
  });
  if (!draft) {
    throw Object.assign(new Error("Draft not found"), { status: 404 });
  }
  if (draft.status !== "PUBLISHED") {
    throw Object.assign(new Error("Can only rate published drafts"), { status: 409 });
  }

  return prisma.draft.update({
    where: { id: draftId },
    data: {
      performanceRating: rating,
      ratedAt: new Date(),
    },
  });
}

// ── getPerformanceProfile ──────────────────────────────────────────────

/**
 * Aggregates performance ratings across a workspace's published drafts
 * to build a performance profile used by generation prompts.
 *
 * Returns:
 * - topContentTypes:     content types/angles that got HIGH ratings
 * - weakContentTypes:    content types/angles that got LOW ratings
 * - topChannels:         channels with best performance
 * - topHookStyles:       hook patterns from highly-rated drafts
 * - totalRated:          how many drafts have been rated
 * - ratingDistribution:  { HIGH, AVERAGE, LOW } counts
 */
export async function getPerformanceProfile(clientId) {
  const ratedDrafts = await prisma.draft.findMany({
    where: {
      clientId,
      status: "PUBLISHED",
      performanceRating: { not: null },
    },
    select: {
      id: true,
      channel: true,
      kind: true,
      generationGuidance: true,
      warnings: true,
      hooks: true,
      scoredHooks: true,
      performanceRating: true,
      body: true,
    },
    orderBy: { ratedAt: "desc" },
    take: 100, // cap to prevent huge aggregation
  });

  if (ratedDrafts.length === 0) {
    return {
      topContentTypes: [],
      weakContentTypes: [],
      topChannels: [],
      topHookStyles: [],
      totalRated: 0,
      ratingDistribution: { HIGH: 0, AVERAGE: 0, LOW: 0 },
    };
  }

  // Rating distribution
  const ratingDistribution = { HIGH: 0, AVERAGE: 0, LOW: 0 };
  for (const d of ratedDrafts) {
    ratingDistribution[d.performanceRating]++;
  }

  // ── Content type analysis ──
  // Derive content type from warnings (angle labels, content type markers)
  const contentTypeScores = {};
  const channelScores = {};

  for (const d of ratedDrafts) {
    const score = d.performanceRating === "HIGH" ? 2 : d.performanceRating === "AVERAGE" ? 0 : -2;

    // Channel scoring
    if (!channelScores[d.channel]) channelScores[d.channel] = { total: 0, count: 0 };
    channelScores[d.channel].total += score;
    channelScores[d.channel].count++;

    // Content type from warnings
    const contentType = extractContentType(d);
    if (contentType) {
      if (!contentTypeScores[contentType]) contentTypeScores[contentType] = { total: 0, count: 0, highCount: 0, lowCount: 0 };
      contentTypeScores[contentType].total += score;
      contentTypeScores[contentType].count++;
      if (d.performanceRating === "HIGH") contentTypeScores[contentType].highCount++;
      if (d.performanceRating === "LOW") contentTypeScores[contentType].lowCount++;
    }
  }

  // Top/weak content types (need at least 2 ratings to be meaningful)
  const MIN_RATINGS = 2;
  const topContentTypes = Object.entries(contentTypeScores)
    .filter(([, s]) => s.count >= MIN_RATINGS && s.total > 0)
    .sort((a, b) => b[1].total - a[1].total)
    .slice(0, 3)
    .map(([type, s]) => ({ type, avgScore: s.total / s.count, highRate: s.highCount / s.count }));

  const weakContentTypes = Object.entries(contentTypeScores)
    .filter(([, s]) => s.count >= MIN_RATINGS && s.total < 0)
    .sort((a, b) => a[1].total - b[1].total)
    .slice(0, 3)
    .map(([type, s]) => ({ type, avgScore: s.total / s.count, lowRate: s.lowCount / s.count }));

  // Top channels
  const topChannels = Object.entries(channelScores)
    .filter(([, s]) => s.count >= MIN_RATINGS)
    .sort((a, b) => b[1].total / b[1].count - a[1].total / a[1].count)
    .slice(0, 3)
    .map(([channel, s]) => ({ channel, avgScore: s.total / s.count }));

  // Hook style analysis — look at hooks from HIGH-rated drafts
  const highDrafts = ratedDrafts.filter((d) => d.performanceRating === "HIGH");
  const topHookStyles = extractTopHookPatterns(highDrafts);

  return {
    topContentTypes,
    weakContentTypes,
    topChannels,
    topHookStyles,
    totalRated: ratedDrafts.length,
    ratingDistribution,
  };
}

// ── getPerformanceInsights ─────────────────────────────────────────────

/**
 * Returns simple, human-readable insights for display on the dashboard.
 * Examples:
 *   "Your growth posts perform best"
 *   "Curiosity hooks get higher engagement"
 *   "Instagram outperforms Facebook for your content"
 */
export async function getPerformanceInsights(clientId) {
  const profile = await getPerformanceProfile(clientId);

  if (profile.totalRated < 3) {
    return {
      insights: [],
      hasEnoughData: false,
      totalRated: profile.totalRated,
      ratingDistribution: profile.ratingDistribution,
    };
  }

  const insights = [];

  // Best content type
  if (profile.topContentTypes.length > 0) {
    const best = profile.topContentTypes[0];
    const label = CONTENT_TYPE_LABELS[best.type] ?? best.type;
    insights.push({
      id: "top_content_type",
      text: `Your ${label.toLowerCase()} posts perform best`,
      detail: `${Math.round(best.highRate * 100)}% rated high engagement`,
      type: "positive",
    });
  }

  // Weak content type
  if (profile.weakContentTypes.length > 0) {
    const weak = profile.weakContentTypes[0];
    const label = CONTENT_TYPE_LABELS[weak.type] ?? weak.type;
    insights.push({
      id: "weak_content_type",
      text: `${label} content tends to underperform`,
      detail: "Consider adjusting your approach or trying different angles",
      type: "suggestion",
    });
  }

  // Best channel
  if (profile.topChannels.length >= 2) {
    const best = profile.topChannels[0];
    const second = profile.topChannels[1];
    if (best.avgScore > second.avgScore + 0.5) {
      insights.push({
        id: "top_channel",
        text: `${best.channel} outperforms ${second.channel} for your content`,
        detail: "Consider prioritizing this channel",
        type: "positive",
      });
    }
  }

  // Hook style
  if (profile.topHookStyles.length > 0) {
    insights.push({
      id: "top_hook_style",
      text: `${profile.topHookStyles[0]} hooks get higher engagement`,
      detail: "We'll prioritize this style in future generations",
      type: "positive",
    });
  }

  // Variety check — prevent overfitting
  const { HIGH, LOW } = profile.ratingDistribution;
  const total = profile.totalRated;
  if (HIGH / total > 0.7) {
    insights.push({
      id: "high_performer",
      text: "Your content is consistently performing well",
      detail: "Keep experimenting with new angles to maintain freshness",
      type: "positive",
    });
  } else if (LOW / total > 0.5) {
    insights.push({
      id: "needs_improvement",
      text: "Most posts are underperforming — try mixing up your approach",
      detail: "Experiment with different content types and hooks",
      type: "suggestion",
    });
  }

  return {
    insights: insights.slice(0, 4),
    hasEnoughData: true,
    totalRated: profile.totalRated,
    ratingDistribution: profile.ratingDistribution,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────

const CONTENT_TYPE_LABELS = {
  listing: "Listing",
  growth: "Growth",
  authority: "Authority",
  lifestyle: "Lifestyle",
  buyer: "Buyer",
  testimonial: "Testimonial",
  engagement: "Engagement",
  market_update: "Market Update",
  educational: "Educational",
  personal: "Personal",
};

function extractContentType(draft) {
  const warnings = draft.warnings ?? [];
  const guidance = (draft.generationGuidance ?? "").toLowerCase();

  // Check warnings for angle category markers
  for (const w of warnings) {
    if (w.startsWith("autopilot_angle_label:")) {
      const angle = w.slice("autopilot_angle_label:".length).trim().toLowerCase();
      if (angle.includes("listing")) return "listing";
      if (angle.includes("growth") || angle.includes("curiosity") || angle.includes("myth") || angle.includes("value")) return "growth";
      if (angle.includes("authority") || angle.includes("market")) return "authority";
      if (angle.includes("lifestyle") || angle.includes("neighborhood")) return "lifestyle";
      if (angle.includes("buyer") || angle.includes("tip")) return "buyer";
      if (angle.includes("testimonial") || angle.includes("review")) return "testimonial";
    }
  }

  // Check guidance text
  if (guidance.includes("[type: growth]") || guidance.includes("growth")) return "growth";
  if (guidance.includes("listing") || guidance.includes("property")) return "listing";
  if (guidance.includes("market") || guidance.includes("authority")) return "authority";
  if (guidance.includes("neighborhood") || guidance.includes("lifestyle")) return "lifestyle";
  if (guidance.includes("buyer") || guidance.includes("tip")) return "buyer";
  if (guidance.includes("testimonial") || guidance.includes("review")) return "testimonial";

  return null;
}

function extractTopHookPatterns(highDrafts) {
  const patterns = { Curiosity: 0, Question: 0, Statistic: 0, Story: 0, Bold: 0 };

  for (const d of highDrafts) {
    const firstHook = d.hooks?.[0] ?? d.body?.split("\n")[0] ?? "";
    const lower = firstHook.toLowerCase();

    if (lower.includes("?")) patterns.Question++;
    if (lower.includes("did you know") || lower.includes("most people") || lower.includes("secret")) patterns.Curiosity++;
    if (/\d+%|\d+ out of|\$[\d,]+/.test(firstHook)) patterns.Statistic++;
    if (lower.includes("i ") || lower.includes("my ") || lower.includes("we ")) patterns.Story++;
    if (lower.startsWith("stop") || lower.startsWith("don't") || lower.startsWith("never") || lower.startsWith("the truth")) patterns.Bold++;
  }

  return Object.entries(patterns)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([style]) => style);
}
