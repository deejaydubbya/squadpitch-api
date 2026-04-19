// Performance scoring service.
//
// Computes a weighted composite score (0-100) for published posts using
// engagement data when available, with a quality-only fallback.
// Formula: Engagement 50% + Quality 30% + Consistency 20%

import { prisma } from '../../prisma.js';
import { extractInternalSignals } from './normalization.service.js';
import { getClientTimezone, getLocalDateString } from '../../lib/timezone.js';

// ── Score Classification ─────────────────────────────────────────────

export function classifyScore(score) {
  if (score == null) return null;
  if (score >= 90) return "exceptional";
  if (score >= 70) return "strong";
  if (score >= 50) return "average";
  if (score >= 30) return "below_average";
  return "needs_attention";
}

// ── Client Channel Benchmarks ────────────────────────────────────────

/**
 * Returns rolling averages from last 50 posts or 90 days for a client+channel.
 */
export async function getClientChannelBenchmarks(clientId, channel) {
  const since = new Date();
  since.setDate(since.getDate() - 90);

  const metrics = await prisma.normalizedMetric.findMany({
    where: {
      clientId,
      channel,
      createdAt: { gte: since },
    },
    select: {
      engagementRate: true,
      reach: true,
      impressions: true,
    },
    orderBy: { createdAt: "desc" },
    take: 50,
  });

  if (metrics.length === 0) {
    return { avgEngagementRate: null, avgReach: null, avgImpressions: null, sampleSize: 0 };
  }

  const rates = metrics.map((m) => m.engagementRate).filter((r) => r != null);
  const reaches = metrics.map((m) => m.reach).filter((r) => r != null);
  const imps = metrics.map((m) => m.impressions).filter((r) => r != null);

  const avg = (arr) => (arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null);

  return {
    avgEngagementRate: avg(rates),
    avgReach: avg(reaches),
    avgImpressions: avg(imps),
    sampleSize: metrics.length,
  };
}

// ── Posting Consistency Score ────────────────────────────────────────

/**
 * Measures how consistently the client posts over a rolling window.
 * Perfect daily consistency = 100, high variance = 0.
 */
export async function getPostingConsistencyScore(clientId, windowDays = 14) {
  const since = new Date();
  since.setDate(since.getDate() - windowDays);

  const [drafts, timezone] = await Promise.all([
    prisma.draft.findMany({
      where: {
        clientId,
        status: "PUBLISHED",
        publishedAt: { gte: since },
      },
      select: { publishedAt: true },
      orderBy: { publishedAt: "asc" },
    }),
    getClientTimezone(clientId),
  ]);

  if (drafts.length === 0) return 0;

  // Group by local date
  const countsByDay = {};
  for (const d of drafts) {
    if (!d.publishedAt) continue;
    const day = getLocalDateString(d.publishedAt, timezone);
    countsByDay[day] = (countsByDay[day] || 0) + 1;
  }

  // Fill zero-days
  const counts = [];
  const cursor = new Date(since);
  for (let i = 0; i < windowDays; i++) {
    const day = getLocalDateString(cursor, timezone);
    counts.push(countsByDay[day] || 0);
    cursor.setDate(cursor.getDate() + 1);
  }

  const totalPosts = counts.reduce((a, b) => a + b, 0);
  const mean = totalPosts / counts.length;

  if (mean === 0) return 0;

  // Coefficient of variation
  const variance = counts.reduce((sum, c) => sum + (c - mean) ** 2, 0) / counts.length;
  const stddev = Math.sqrt(variance);
  const cv = stddev / mean;

  let score = clamp(Math.round((1 - cv / 1.5) * 100), 0, 100);

  // Frequency penalty
  if (totalPosts < 1) return 0;
  if (totalPosts < 3) score = Math.round(score * 0.5);

  return score;
}

// ── Composite Performance Score ──────────────────────────────────────

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Compute a weighted composite score (0-100).
 *
 * With engagement data:
 *   Engagement 50% + Quality 30% + Consistency 20%
 *
 * Without engagement data (internal-only):
 *   Quality 80% + Consistency 20%
 */
export function computePerformanceScore(draft, normalizedMetric, benchmarks, consistencyScore = 50) {
  const { completenessScore } = extractInternalSignals(draft);
  const qualityScore = completenessScore;

  const hasEngagement =
    normalizedMetric?.engagementRate != null && benchmarks?.avgEngagementRate != null;

  if (!hasEngagement) {
    // Quality + consistency fallback
    const compositeScore = clamp(Math.round(qualityScore * 0.8 + consistencyScore * 0.2), 0, 100);
    return { qualityScore, observedScore: null, compositeScore, tier: classifyScore(compositeScore), mode: "internal_only" };
  }

  // Engagement component: relative engagement rate scaled to 0-100
  const relativeEngagement =
    benchmarks.avgEngagementRate > 0
      ? normalizedMetric.engagementRate / benchmarks.avgEngagementRate
      : 1.0;
  const observedScore = clamp(Math.round(relativeEngagement * 50), 0, 100);

  // Weighted composite
  const compositeScore = clamp(Math.round(observedScore * 0.5 + qualityScore * 0.3 + consistencyScore * 0.2), 0, 100);

  return { qualityScore, observedScore, compositeScore, tier: classifyScore(compositeScore), mode: "weighted" };
}

// ── Score Breakdown ─────────────────────────────────────────────────

/**
 * Returns a detailed breakdown of the performance score components.
 */
export function explainPerformanceScoreBreakdown(draft, normalizedMetric, benchmarks, consistencyScore = 50) {
  const { completenessScore } = extractInternalSignals(draft);
  const qualityScore = completenessScore;

  const hasEngagement =
    normalizedMetric?.engagementRate != null && benchmarks?.avgEngagementRate != null;

  if (!hasEngagement) {
    const qualityWeighted = Math.round(qualityScore * 0.8);
    const consistencyWeighted = Math.round(consistencyScore * 0.2);
    const compositeScore = clamp(qualityWeighted + consistencyWeighted, 0, 100);

    return {
      qualityScore,
      observedScore: null,
      compositeScore,
      tier: classifyScore(compositeScore),
      mode: "internal_only",
      components: {
        engagement: null,
        quality: { raw: qualityScore, weight: 0.8, weighted: qualityWeighted },
        consistency: { raw: consistencyScore, weight: 0.2, weighted: consistencyWeighted },
      },
      explanation: `Quality (${qualityWeighted}/80) + Consistency (${consistencyWeighted}/20) = ${compositeScore}`,
    };
  }

  const relativeEngagement =
    benchmarks.avgEngagementRate > 0
      ? normalizedMetric.engagementRate / benchmarks.avgEngagementRate
      : 1.0;
  const observedScore = clamp(Math.round(relativeEngagement * 50), 0, 100);
  const engagementWeighted = Math.round(observedScore * 0.5);
  const qualityWeighted = Math.round(qualityScore * 0.3);
  const consistencyWeighted = Math.round(consistencyScore * 0.2);

  const compositeScore = clamp(engagementWeighted + qualityWeighted + consistencyWeighted, 0, 100);

  return {
    qualityScore,
    observedScore,
    compositeScore,
    tier: classifyScore(compositeScore),
    mode: "weighted",
    components: {
      engagement: { raw: observedScore, weight: 0.5, weighted: engagementWeighted },
      quality: { raw: qualityScore, weight: 0.3, weighted: qualityWeighted },
      consistency: { raw: consistencyScore, weight: 0.2, weighted: consistencyWeighted },
    },
    explanation: `Engagement (${engagementWeighted}/50) + Quality (${qualityWeighted}/30) + Consistency (${consistencyWeighted}/20) = ${compositeScore}`,
  };
}
