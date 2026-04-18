// GBP Review Analysis Service — AI extraction layer.
//
// Processes reviews through gpt-4o-mini to extract structured insights:
// themes, sentiment, use cases, location mentions, and strong quotes.
// Results are stored in each review's dataJson and aggregated into
// connection metadata for dashboard display and content generation.

import { prisma } from "../../prisma.js";
import { generateStructuredContent } from "./generation/openai.provider.js";

const BATCH_SIZE = 10;

// ── LLM Extraction ──────────────────────────────────────────────────────

const REVIEW_ANALYSIS_SCHEMA = {
  name: "review_analysis",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      reviews: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            index: { type: "number", description: "Review index from the input list (1-based)." },
            extractedThemes: {
              type: "array",
              items: { type: "string" },
              description: "1-5 short themes (e.g. 'great communication', 'fast closing', 'negotiation skills').",
            },
            sentiment: {
              type: "string",
              enum: ["positive", "neutral", "negative"],
              description: "Overall sentiment of the review.",
            },
            useCases: {
              type: "array",
              items: { type: "string" },
              description: "Client type or use case (e.g. 'first-time buyer', 'luxury seller', 'investor').",
            },
            locationMentions: {
              type: "array",
              items: { type: "string" },
              description: "Neighborhoods, cities, or areas mentioned in the review.",
            },
            strongQuotes: {
              type: "array",
              items: { type: "string" },
              description: "1-3 short, compelling direct quotes from the review (verbatim fragments).",
            },
          },
          required: ["index", "extractedThemes", "sentiment", "useCases", "locationMentions", "strongQuotes"],
        },
      },
    },
    required: ["reviews"],
  },
};

const SYSTEM_PROMPT = `You are a review analyst for a local business. Extract structured insights from each review.
For each review, identify:
- extractedThemes: 1-5 short keyword themes (e.g. "great communication", "fast closing")
- sentiment: "positive", "neutral", or "negative"
- useCases: client type or scenario (e.g. "first-time buyer", "relocation")
- locationMentions: any neighborhoods, cities, or areas mentioned
- strongQuotes: 1-3 short, compelling verbatim fragments that would work in marketing

Be concise. Use lowercase for themes and useCases. Only extract what is clearly present — do not fabricate.`;

/**
 * Batch-analyze up to 10 reviews per LLM call.
 *
 * @param {Array<{ comment: string, author: string, rating: number }>} reviews
 * @returns {Promise<Array<{ extractedThemes: string[], sentiment: string, useCases: string[], locationMentions: string[], strongQuotes: string[] }>>}
 */
export async function analyzeReviews(reviews) {
  if (!reviews || reviews.length === 0) return [];

  const batches = [];
  for (let i = 0; i < reviews.length; i += BATCH_SIZE) {
    batches.push(reviews.slice(i, i + BATCH_SIZE));
  }

  const allResults = [];

  for (const batch of batches) {
    const numbered = batch
      .map((r, i) => `#${i + 1}: "${r.comment || "(no comment)"}" — ${r.author || "Anonymous"} (${r.rating || 0}★)`)
      .join("\n");

    const { parsed } = await generateStructuredContent({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt: `Analyze these ${batch.length} reviews:\n\n${numbered}`,
      taskType: "lightweight",
      temperature: 0.3,
      responseFormat: { type: "json_schema", json_schema: REVIEW_ANALYSIS_SCHEMA },
    });

    // Map results back by index, falling back to empty for any missing
    for (let i = 0; i < batch.length; i++) {
      const match = parsed.reviews?.find((r) => r.index === i + 1);
      allResults.push(
        match
          ? {
              extractedThemes: match.extractedThemes || [],
              sentiment: match.sentiment || "neutral",
              useCases: match.useCases || [],
              locationMentions: match.locationMentions || [],
              strongQuotes: match.strongQuotes || [],
            }
          : { extractedThemes: [], sentiment: "neutral", useCases: [], locationMentions: [], strongQuotes: [] }
      );
    }
  }

  return allResults;
}

// ── Aggregation ─────────────────────────────────────────────────────────

/**
 * Compute cross-review aggregates from individual analyses.
 *
 * @param {Array<{ extractedThemes: string[], sentiment: string, useCases: string[], locationMentions: string[] }>} analyses
 * @returns {{ topThemes: Array<{theme: string, count: number}>, sentimentBreakdown: {positive: number, neutral: number, negative: number}, topUseCases: string[], commonLocations: string[], analyzedAt: string }}
 */
export function aggregateReviewInsights(analyses) {
  const themeCounts = {};
  const useCaseCounts = {};
  const locationCounts = {};
  let positive = 0;
  let neutral = 0;
  let negative = 0;

  for (const a of analyses) {
    for (const t of a.extractedThemes || []) {
      const key = t.toLowerCase();
      themeCounts[key] = (themeCounts[key] || 0) + 1;
    }
    for (const u of a.useCases || []) {
      const key = u.toLowerCase();
      useCaseCounts[key] = (useCaseCounts[key] || 0) + 1;
    }
    for (const l of a.locationMentions || []) {
      locationCounts[l] = (locationCounts[l] || 0) + 1;
    }
    if (a.sentiment === "positive") positive++;
    else if (a.sentiment === "negative") negative++;
    else neutral++;
  }

  const topThemes = Object.entries(themeCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([theme, count]) => ({ theme, count }));

  const topUseCases = Object.entries(useCaseCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([uc]) => uc);

  const commonLocations = Object.entries(locationCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([loc]) => loc);

  return {
    topThemes,
    sentimentBreakdown: { positive, neutral, negative },
    topUseCases,
    commonLocations,
    analyzedAt: new Date().toISOString(),
  };
}

// ── End-to-End Pipeline ─────────────────────────────────────────────────

/**
 * Analyze reviews, store results in dataJson, update connection metadata aggregates.
 * Skips reviews where dataJson.analyzedAt already exists (idempotent).
 *
 * @param {string} clientId
 * @param {Array<{ id: string, dataJson: object }>} dataItems — WorkspaceDataItem records
 */
export async function analyzeAndStoreReviews(clientId, dataItems) {
  // Filter out already-analyzed reviews
  const unanalyzed = dataItems.filter((item) => !item.dataJson?.analyzedAt);
  if (unanalyzed.length === 0) return;

  // Build the review shape the LLM expects
  const reviewInputs = unanalyzed.map((item) => ({
    comment: item.dataJson?.quote || "",
    author: item.dataJson?.author || "Anonymous",
    rating: item.dataJson?.rating || 0,
  }));

  const analyses = await analyzeReviews(reviewInputs);

  // Store per-review results
  for (let i = 0; i < unanalyzed.length; i++) {
    const item = unanalyzed[i];
    const analysis = analyses[i];
    if (!analysis) continue;

    await prisma.workspaceDataItem.update({
      where: { id: item.id },
      data: {
        dataJson: {
          ...item.dataJson,
          extractedThemes: analysis.extractedThemes,
          sentiment: analysis.sentiment,
          useCases: analysis.useCases,
          locationMentions: analysis.locationMentions,
          strongQuotes: analysis.strongQuotes,
          analyzedAt: new Date().toISOString(),
        },
      },
    });
  }

  // Now re-aggregate across ALL analyzed reviews for this workspace
  const allAnalyzed = await prisma.workspaceDataItem.findMany({
    where: {
      clientId,
      type: "TESTIMONIAL",
      status: "ACTIVE",
      tags: { hasSome: ["gbp"] },
    },
    select: { dataJson: true },
  });

  const allAnalyses = allAnalyzed
    .filter((item) => item.dataJson?.analyzedAt)
    .map((item) => ({
      extractedThemes: item.dataJson.extractedThemes || [],
      sentiment: item.dataJson.sentiment || "neutral",
      useCases: item.dataJson.useCases || [],
      locationMentions: item.dataJson.locationMentions || [],
    }));

  const aggregated = aggregateReviewInsights(allAnalyses);

  // Update connection metadata with aggregates
  const connection = await prisma.workspaceTechStackConnection.findUnique({
    where: { workspaceId_providerKey: { workspaceId: clientId, providerKey: "google_business_profile" } },
  });

  if (connection) {
    await prisma.workspaceTechStackConnection.update({
      where: { id: connection.id },
      data: {
        metadataJson: {
          ...(connection.metadataJson || {}),
          reviewInsights: aggregated,
        },
      },
    });
  }
}

/**
 * On-demand full re-analysis of all GBP reviews for a workspace.
 * Clears analyzedAt on all reviews first so they get re-processed.
 *
 * @param {string} clientId
 * @returns {Promise<{ analyzed: number }>}
 */
export async function reanalyzeAllReviews(clientId) {
  const allReviews = await prisma.workspaceDataItem.findMany({
    where: {
      clientId,
      type: "TESTIMONIAL",
      status: "ACTIVE",
      tags: { hasSome: ["gbp"] },
    },
  });

  if (allReviews.length === 0) return { analyzed: 0 };

  // Clear analyzedAt so analyzeAndStoreReviews processes them all
  for (const item of allReviews) {
    if (item.dataJson?.analyzedAt) {
      await prisma.workspaceDataItem.update({
        where: { id: item.id },
        data: {
          dataJson: {
            ...item.dataJson,
            analyzedAt: undefined,
            extractedThemes: undefined,
            sentiment: undefined,
            useCases: undefined,
            locationMentions: undefined,
            strongQuotes: undefined,
          },
        },
      });
    }
  }

  // Re-fetch after clearing
  const refreshed = await prisma.workspaceDataItem.findMany({
    where: {
      clientId,
      type: "TESTIMONIAL",
      status: "ACTIVE",
      tags: { hasSome: ["gbp"] },
    },
  });

  await analyzeAndStoreReviews(clientId, refreshed);
  return { analyzed: refreshed.length };
}
