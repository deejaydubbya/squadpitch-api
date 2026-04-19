// Google Business Profile Sync Service
//
// Fetches business info + reviews from GBP and normalizes them into
// WorkspaceDataItems. Reviews become TESTIMONIAL type assets that feed
// into content generation, recommendations, and autopilot.
//
// Data flow:
//   GBP API → normalize → deduplicate → WorkspaceDataItems
//   Business info → WorkspaceTechStackConnection metadata

import { prisma } from "../../prisma.js";
import * as gbpProvider from "../integrations/providers/gbpProvider.js";
import { stampSourceAttribution, RE_SOURCE_TYPES } from "../industry/realEstateAssets.js";
import { analyzeAndStoreReviews } from "./gbpReviewAnalysis.service.js";

// ── Sync ────────────────────────────────────────────────────────────────

/**
 * Full sync: fetch business info + reviews from GBP.
 *
 * @param {string} clientId — workspace ID
 * @returns {Promise<{ reviewsImported: number, reviewsUpdated: number, businessInfo: object | null }>}
 */
export async function syncGBP(clientId) {
  // Get stored connection config
  const connection = await prisma.workspaceTechStackConnection.findUnique({
    where: { workspaceId_providerKey: { workspaceId: clientId, providerKey: "google_business_profile" } },
  });

  if (!connection || connection.connectionStatus !== "connected") {
    throw Object.assign(new Error("GBP not connected"), { status: 400 });
  }

  const config = connection.metadataJson || {};
  if (!config.accessToken) {
    throw Object.assign(new Error("GBP connection incomplete — reconnect required"), { status: 400 });
  }

  // Auto-discover account + location if missing (happens when listing API
  // failed silently during the OAuth callback).
  if (!config.accountId || !config.locationId) {
    try {
      const accounts = await gbpProvider.listAccounts(config);
      if (accounts.length === 0) {
        throw Object.assign(new Error("No Google Business Profile accounts found for this Google account"), { status: 400 });
      }
      config.accountId = accounts[0].name;
      const locations = await gbpProvider.listLocations(config, config.accountId);
      if (locations.length === 0) {
        throw Object.assign(new Error("No locations found in your Google Business Profile — add a location in Google first"), { status: 400 });
      }
      config.locationId = locations[0].name;
      config.locationName = locations[0].title;
      // Persist discovered values so future syncs don't need to re-discover
      await prisma.workspaceTechStackConnection.update({
        where: { id: connection.id },
        data: { metadataJson: { ...config } },
      });
    } catch (err) {
      if (err.status) throw err;
      throw Object.assign(new Error("GBP connection incomplete — reconnect required"), { status: 400 });
    }
  }

  let businessInfo = null;
  let reviewsImported = 0;
  let reviewsUpdated = 0;

  try {
    // 1. Fetch business info
    businessInfo = await gbpProvider.fetchBusinessInfo(config, config.accountId, config.locationId);

    // 2. Fetch all reviews (paginated)
    const allReviews = [];
    let pageToken = undefined;
    let pages = 0;
    const MAX_PAGES = 5; // Safety cap

    do {
      const result = await gbpProvider.fetchReviews(config, config.accountId, config.locationId, { pageToken });
      allReviews.push(...result.reviews);
      pageToken = result.nextPageToken;
      pages++;
    } while (pageToken && pages < MAX_PAGES);

    // 3. Get or create data source for GBP
    const dataSource = await getOrCreateGBPSource(clientId);

    // 4. Process each review
    for (const review of allReviews) {
      const result = await upsertReview(clientId, dataSource.id, review, businessInfo);
      if (result === "created") reviewsImported++;
      else if (result === "updated") reviewsUpdated++;
    }

    // 5. Fire-and-forget AI analysis on newly created reviews
    if (reviewsImported > 0) {
      const sixtySecondsAgo = new Date(Date.now() - 60_000);
      const recentItems = await prisma.workspaceDataItem.findMany({
        where: {
          clientId,
          type: "TESTIMONIAL",
          status: "ACTIVE",
          tags: { hasSome: ["gbp"] },
          createdAt: { gte: sixtySecondsAgo },
        },
      });
      const unanalyzed = recentItems.filter((item) => !item.dataJson?.analyzedAt);
      if (unanalyzed.length > 0) {
        analyzeAndStoreReviews(clientId, unanalyzed).catch((err) => {
          console.error("[GBP] Review analysis failed (non-blocking):", err.message);
        });
      }
    }

    // 7. Compute review stats
    const unrepliedReviewCount = allReviews.filter((r) => !r.reply).length;
    const newAverageRating = allReviews.length > 0
      ? (allReviews.reduce((sum, r) => sum + (r.starRating || 0), 0) / allReviews.length).toFixed(1)
      : null;

    // 7. Update connection metadata
    await prisma.workspaceTechStackConnection.update({
      where: { id: connection.id },
      data: {
        metadataJson: {
          ...config,
          lastSyncedAt: new Date().toISOString(),
          reviewCount: allReviews.length,
          previousAverageRating: config.averageRating || null,
          averageRating: newAverageRating,
          unrepliedReviewCount,
          businessName: businessInfo?.name || config.businessName,
          businessDescription: businessInfo?.description || config.businessDescription || "",
          businessPhone: businessInfo?.phone || config.businessPhone || null,
          businessWebsite: businessInfo?.website || config.businessWebsite || null,
          businessAddress: businessInfo?.address || config.businessAddress || null,
          businessHours: businessInfo?.hours || config.businessHours || null,
          businessCategories: businessInfo?.categories || [],
        },
      },
    });
  } catch (err) {
    // Mark connection as errored if permanent failure
    if (err.permanent) {
      await prisma.workspaceTechStackConnection.update({
        where: { id: connection.id },
        data: {
          connectionStatus: "error",
          lastError: err.message,
          metadataJson: { ...config, lastSyncedAt: new Date().toISOString() },
        },
      });
    }
    throw err;
  }

  return { reviewsImported, reviewsUpdated, businessInfo };
}

// ── Review Processing ───────────────────────────────────────────────────

/**
 * Upsert a single review as a TESTIMONIAL WorkspaceDataItem.
 * Deduplicates by GBP review ID stored in dataJson._externalId.
 *
 * @returns {"created" | "updated" | "skipped"}
 */
async function upsertReview(clientId, dataSourceId, review, businessInfo) {
  if (!review.comment && !review.starRating) return "skipped";

  // Check for existing by external ID
  const existing = await prisma.workspaceDataItem.findFirst({
    where: {
      clientId,
      type: "TESTIMONIAL",
      status: "ACTIVE",
      dataJson: { path: ["_externalId"], equals: review.reviewId },
    },
  });

  const dataJson = stampSourceAttribution(
    {
      quote: review.comment || "",
      author: review.reviewer,
      rating: review.starRating,
      reviewDate: review.createTime,
      reply: review.reply,
      _externalId: review.reviewId,
      businessName: businessInfo?.name || null,
    },
    RE_SOURCE_TYPES.GBP,
    {}
  );

  const title = review.starRating
    ? `${review.starRating}-star review from ${review.reviewer}`
    : `Review from ${review.reviewer}`;

  const summary = review.comment
    ? review.comment.slice(0, 200)
    : `${review.starRating || 0}-star rating`;

  const tags = ["review", "gbp"];
  if (review.starRating >= 4) tags.push("positive");
  if (review.starRating <= 2) tags.push("negative");

  // Priority: 5-star = 8, 4-star = 6, 3-star = 3, below = 1
  const priority = review.starRating >= 5 ? 8 : review.starRating >= 4 ? 6 : review.starRating >= 3 ? 3 : 1;

  if (existing) {
    await prisma.workspaceDataItem.update({
      where: { id: existing.id },
      data: { title, summary, dataJson, tags, priority },
    });
    return "updated";
  }

  await prisma.workspaceDataItem.create({
    data: {
      clientId,
      dataSourceId,
      type: "TESTIMONIAL",
      title,
      summary,
      dataJson,
      tags,
      priority,
    },
  });
  return "created";
}

// ── Helpers ─────────────────────────────────────────────────────────────

/**
 * Get stored GBP reviews from WorkspaceDataItems (no API call).
 *
 * @param {string} clientId
 * @param {{ limit?: number, offset?: number }} [opts]
 * @returns {Promise<{ reviews: Array, total: number, unrepliedCount: number }>}
 */
export async function getGBPReviews(clientId, { limit = 20, offset = 0 } = {}) {
  const where = {
    clientId,
    type: "TESTIMONIAL",
    status: "ACTIVE",
    tags: { hasSome: ["gbp"] },
  };

  const [items, total] = await Promise.all([
    prisma.workspaceDataItem.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: offset,
      take: limit,
    }),
    prisma.workspaceDataItem.count({ where }),
  ]);

  const reviews = items.map((item) => ({
    id: item.dataJson?._externalId || item.id,
    reviewer: item.dataJson?.author || "Anonymous",
    rating: item.dataJson?.rating || null,
    comment: item.dataJson?.quote || "",
    reviewDate: item.dataJson?.reviewDate || null,
    reply: item.dataJson?.reply || null,
    dataItemId: item.id,
    extractedThemes: item.dataJson?.extractedThemes || [],
    sentiment: item.dataJson?.sentiment || null,
    useCases: item.dataJson?.useCases || [],
    locationMentions: item.dataJson?.locationMentions || [],
    strongQuotes: item.dataJson?.strongQuotes || [],
    analyzedAt: item.dataJson?.analyzedAt || null,
  }));

  const unrepliedCount = reviews.filter((r) => !r.reply).length;

  return { reviews, total, unrepliedCount };
}

/**
 * Get stored GBP business profile from connection metadata (no API call).
 *
 * @param {string} clientId
 * @returns {Promise<object|null>}
 */
export async function getGBPBusinessProfile(clientId) {
  const connection = await prisma.workspaceTechStackConnection.findUnique({
    where: { workspaceId_providerKey: { workspaceId: clientId, providerKey: "google_business_profile" } },
  });

  if (!connection || connection.connectionStatus !== "connected") return null;

  const meta = connection.metadataJson || {};
  return {
    businessName: meta.businessName || "",
    description: meta.businessDescription || "",
    categories: meta.businessCategories || [],
    address: meta.businessAddress || null,
    phone: meta.businessPhone || null,
    website: meta.businessWebsite || null,
    reviewCount: meta.reviewCount || 0,
    averageRating: meta.averageRating || null,
    lastSyncedAt: meta.lastSyncedAt || null,
  };
}

/**
 * Get GBP signals for recommendation engine.
 *
 * @param {string} clientId
 * @returns {Promise<object>}
 */
export async function getGBPSignals(clientId) {
  const connection = await prisma.workspaceTechStackConnection.findUnique({
    where: { workspaceId_providerKey: { workspaceId: clientId, providerKey: "google_business_profile" } },
  });

  if (!connection || connection.connectionStatus !== "connected") {
    return { hasGBP: false, reviewCount: 0, averageRating: null, unrepliedCount: 0, recentNewReviews: 0, ratingDelta: 0, lastSyncedAt: null };
  }

  const meta = connection.metadataJson || {};

  // Count reviews added in the last 7 days
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const recentNewReviews = await prisma.workspaceDataItem.count({
    where: {
      clientId,
      type: "TESTIMONIAL",
      status: "ACTIVE",
      tags: { hasSome: ["gbp"] },
      createdAt: { gte: sevenDaysAgo },
    },
  });

  const ratingDelta = meta.previousAverageRating && meta.averageRating
    ? Number(meta.averageRating) - Number(meta.previousAverageRating)
    : 0;

  return {
    hasGBP: true,
    reviewCount: meta.reviewCount || 0,
    averageRating: meta.averageRating ? Number(meta.averageRating) : null,
    unrepliedCount: meta.unrepliedReviewCount || 0,
    recentNewReviews,
    ratingDelta,
    lastSyncedAt: meta.lastSyncedAt || null,
    topThemes: meta.reviewInsights?.topThemes || [],
    sentimentBreakdown: meta.reviewInsights?.sentimentBreakdown || null,
    topUseCases: meta.reviewInsights?.topUseCases || [],
  };
}

/**
 * Get aggregate review insights from connection metadata.
 *
 * @param {string} clientId
 * @returns {Promise<object|null>}
 */
export async function getGBPInsights(clientId) {
  const connection = await prisma.workspaceTechStackConnection.findUnique({
    where: { workspaceId_providerKey: { workspaceId: clientId, providerKey: "google_business_profile" } },
  });

  if (!connection || connection.connectionStatus !== "connected") return null;

  const meta = connection.metadataJson || {};
  return meta.reviewInsights || null;
}

// ── Helpers ─────────────────────────────────────────────────────────────

async function getOrCreateGBPSource(clientId) {
  const existing = await prisma.workspaceDataSource.findFirst({
    where: { clientId, type: "URL", name: "Google Business Profile" },
  });
  if (existing) return existing;
  return prisma.workspaceDataSource.create({
    data: { clientId, type: "URL", name: "Google Business Profile" },
  });
}
