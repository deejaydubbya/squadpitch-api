// Real Estate Canonical Asset Access Layer
//
// ┌─────────────────────────────────────────────────────────────────────────┐
// │                    REAL ESTATE DATA FLOW                               │
// │                                                                       │
// │  Tech Stack / Integrations / Manual Sources                           │
// │  (listing_feed, GBP, website, manual entry)                           │
// │          ↓                                                            │
// │  WorkspaceDataItems (canonical content assets)                        │
// │  • listings: type=CUSTOM, dataJson._sourceType="listing_feed"         │
// │  • reviews:  type=TESTIMONIAL, dataJson._sourceType="gbp"|"manual"    │
// │  • other:    type=CUSTOM without _sourceType (manual business data)   │
// │          ↓                                                            │
// │  Generation / Recommendations / Automation / Autopilot                │
// │  (all read via this canonical access layer)                           │
// │                                                                       │
// │  Business Data (BrandProfile, VoiceProfile, MediaProfile)             │
// │  → Static context, fallback enrichment, tone guidance                 │
// │  → Does NOT compete with listings/reviews as content-driving assets   │
// │                                                                       │
// │  Data Ownership Rules:                                                │
// │  • Tech Stack layer owns: connection state, source URLs, sync info    │
// │  • WorkspaceDataItem owns: normalized content assets (listings,       │
// │    reviews, testimonials) — THE canonical source for generation       │
// │  • Business Data owns: brand identity, positioning, tone, services    │
// │    — used for enrichment/fallback only                                │
// │  • RealEstateWorkspaceContext owns: resolved state, capabilities,     │
// │    data counts — used for status/routing decisions                    │
// │                                                                       │
// │  Future integrations should:                                          │
// │  1. Import data → create WorkspaceDataItems with _sourceType tag      │
// │  2. Track sync state in WorkspaceTechStackConnection.metadataJson     │
// │  3. All consumers read through this access layer                      │
// └─────────────────────────────────────────────────────────────────────────┘

import { prisma } from "../../prisma.js";
import { normalizeListing, normalizeReview, selectBestListing } from "./realEstateGeneration.js";

// ── Constants ────────────────────────────────────────────────────────────

/** Source type tags stored in WorkspaceDataItem.dataJson._sourceType */
export const RE_SOURCE_TYPES = {
  LISTING_FEED: "listing_feed",
  GBP: "gbp",
  WEBSITE_EXTRACT: "website_extract",
  MANUAL: "manual",
  ONBOARDING: "onboarding",
};

// ── Canonical read helpers ───────────────────────────────────────────────

/**
 * Get all active listing data items for a workspace.
 * Listings are WorkspaceDataItems with type=CUSTOM that were imported
 * from listing feeds (or manually added as property data).
 *
 * @param {string} workspaceId
 * @param {{ orderBy?: "rotation" | "newest" | "completeness", limit?: number }} [opts]
 * @returns {Promise<import("@prisma/client").WorkspaceDataItem[]>}
 */
export async function getRealEstateListings(workspaceId, opts = {}) {
  const { orderBy = "rotation", limit = 20 } = opts;

  const orderClause = orderBy === "rotation"
    ? [{ usageCount: "asc" }, { createdAt: "desc" }]
    : orderBy === "newest"
      ? [{ createdAt: "desc" }]
      : [{ createdAt: "desc" }]; // completeness is post-filter

  const items = await prisma.workspaceDataItem.findMany({
    where: { clientId: workspaceId, type: "CUSTOM", status: "ACTIVE" },
    orderBy: orderClause,
    take: limit,
  });

  return items;
}

/**
 * Get all active testimonial/review data items for a workspace.
 *
 * @param {string} workspaceId
 * @param {{ limit?: number }} [opts]
 * @returns {Promise<import("@prisma/client").WorkspaceDataItem[]>}
 */
export async function getRealEstateTestimonials(workspaceId, opts = {}) {
  const { limit = 10 } = opts;

  return prisma.workspaceDataItem.findMany({
    where: { clientId: workspaceId, type: "TESTIMONIAL", status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
    take: limit,
  });
}

/**
 * Get listing and review counts for a workspace (lightweight, no full loads).
 *
 * @param {string} workspaceId
 * @returns {Promise<{ listingCount: number, reviewCount: number }>}
 */
export async function getRealEstateAssetCounts(workspaceId) {
  const [listingCount, reviewCount] = await Promise.all([
    prisma.workspaceDataItem.count({
      where: { clientId: workspaceId, type: "CUSTOM", status: "ACTIVE" },
    }),
    prisma.workspaceDataItem.count({
      where: { clientId: workspaceId, type: "TESTIMONIAL", status: "ACTIVE" },
    }),
  ]);
  return { listingCount, reviewCount };
}

/**
 * Count recently added items (for trigger evaluation).
 *
 * @param {string} workspaceId
 * @param {"CUSTOM" | "TESTIMONIAL"} type
 * @param {number} withinMs — time window in milliseconds
 * @returns {Promise<number>}
 */
export async function getRecentAssetCount(workspaceId, type, withinMs) {
  return prisma.workspaceDataItem.count({
    where: {
      clientId: workspaceId,
      type,
      status: "ACTIVE",
      createdAt: { gte: new Date(Date.now() - withinMs) },
    },
  });
}

// ── Source attribution ───────────────────────────────────────────────────

/**
 * Stamp source attribution on a WorkspaceDataItem's dataJson.
 * Call this when creating/importing items to ensure provenance.
 *
 * @param {object} dataJson — existing dataJson
 * @param {string} sourceType — one of RE_SOURCE_TYPES values
 * @param {{ sourceUrl?: string, sourceConnectionId?: string, importedAt?: string }} [extra]
 * @returns {object} — enriched dataJson
 */
export function stampSourceAttribution(dataJson, sourceType, extra = {}) {
  return {
    ...dataJson,
    _sourceType: sourceType,
    ...(extra.sourceUrl && { _sourceUrl: extra.sourceUrl }),
    ...(extra.sourceConnectionId && { _sourceConnectionId: extra.sourceConnectionId }),
    _importedAt: extra.importedAt ?? new Date().toISOString(),
  };
}

/**
 * Read source attribution from a WorkspaceDataItem.
 *
 * @param {object} dataItem
 * @returns {{ sourceType: string | null, sourceUrl: string | null, sourceConnectionId: string | null, importedAt: string | null }}
 */
export function readSourceAttribution(dataItem) {
  const d = dataItem?.dataJson ?? {};
  return {
    sourceType: d._sourceType ?? null,
    sourceUrl: d._sourceUrl ?? null,
    sourceConnectionId: d._sourceConnectionId ?? null,
    importedAt: d._importedAt ?? null,
  };
}
