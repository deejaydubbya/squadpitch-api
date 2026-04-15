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
  if (!config.accessToken || !config.accountId || !config.locationId) {
    throw Object.assign(new Error("GBP connection incomplete — reconnect required"), { status: 400 });
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

    // 5. Update connection metadata
    await prisma.workspaceTechStackConnection.update({
      where: { id: connection.id },
      data: {
        metadataJson: {
          ...config,
          lastSyncedAt: new Date().toISOString(),
          reviewCount: allReviews.length,
          averageRating: allReviews.length > 0
            ? (allReviews.reduce((sum, r) => sum + (r.starRating || 0), 0) / allReviews.length).toFixed(1)
            : null,
          businessName: businessInfo?.name || config.businessName,
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

async function getOrCreateGBPSource(clientId) {
  const existing = await prisma.workspaceDataSource.findFirst({
    where: { clientId, type: "URL", name: "Google Business Profile" },
  });
  if (existing) return existing;
  return prisma.workspaceDataSource.create({
    data: { clientId, type: "URL", name: "Google Business Profile" },
  });
}
