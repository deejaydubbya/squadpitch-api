// Real Estate Generation Assets — normalizes listings and reviews into
// generation-ready shapes for the prompt builder. Isolated, reusable,
// and independent of the prompt/AI layer.
//
// Consumers: aiGenerationService.js (loads assets), promptBuilder.js (formats them).
//
// Data flow: reads listing/review data through the canonical asset access
// layer (realEstateAssets.js) or directly from WorkspaceDataItems. All
// content-driving assets live in WorkspaceDataItems — this module never
// reads raw tech stack connection metadata for content.

import { getRealEstateListings, getRealEstateTestimonials } from "./realEstateAssets.js";

// ── Listing normalization ───────────────────────────────────────────────

/**
 * Normalize a CUSTOM WorkspaceDataItem (listing) into a generation-ready shape.
 * Does NOT invent missing fields — only maps what's present.
 *
 * @param {object} dataItem — WorkspaceDataItem with type=CUSTOM
 * @returns {{ title, price, address, beds, baths, sqft, imageUrl, listingUrl, locationSummary, highlights, completenessScore }}
 */
export function normalizeListing(dataItem) {
  if (!dataItem?.dataJson) return null;
  const d = dataItem.dataJson;

  const title = dataItem.title || d.address || d.title || null;
  const price = parseNumeric(d.price);
  const address = d.address || d.street || null;
  const beds = parseNumeric(d.bedrooms || d.beds);
  const baths = parseNumeric(d.bathrooms || d.baths);
  const sqft = parseNumeric(d.sqft || d.squareFootage || d.square_footage);
  const imageUrl = d.imageUrl || d.image || d.photo || null;
  const listingUrl = d.listingUrl || d.url || d.link || null;

  const city = d.city || d.location || null;
  const state = d.state || null;
  const neighborhood = d.neighborhood || null;
  const locationParts = [neighborhood, city, state].filter(Boolean);
  const locationSummary = locationParts.length > 0 ? locationParts.join(", ") : null;

  const highlights = [];
  if (sqft) highlights.push(`${sqft.toLocaleString()} sq ft`);
  if (d.yearBuilt) highlights.push(`Built in ${d.yearBuilt}`);
  if (d.lotSize) highlights.push(`${d.lotSize} lot`);
  if (d.garage) highlights.push(`${d.garage}-car garage`);
  if (d.features) {
    const feats = extractList(d.features);
    highlights.push(...feats.slice(0, 3));
  }
  if (d.description && highlights.length < 3) {
    const sentences = d.description
      .split(/[.!?]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 10 && s.length < 80);
    highlights.push(...sentences.slice(0, 3 - highlights.length));
  }

  // Completeness score: count populated core fields (0-10)
  let completenessScore = 0;
  if (title) completenessScore++;
  if (price) completenessScore++;
  if (address) completenessScore++;
  if (beds) completenessScore++;
  if (baths) completenessScore++;
  if (sqft) completenessScore++;
  if (imageUrl) completenessScore++;
  if (listingUrl) completenessScore++;
  if (locationSummary) completenessScore++;
  if (highlights.length > 0) completenessScore++;

  return {
    title,
    price,
    address,
    beds,
    baths,
    sqft,
    imageUrl,
    listingUrl,
    locationSummary,
    highlights: highlights.slice(0, 5),
    completenessScore,
  };
}

// ── Review normalization ────────────────────────────────────────────────

/**
 * Normalize a TESTIMONIAL WorkspaceDataItem into a generation-ready review shape.
 *
 * @param {object} dataItem — WorkspaceDataItem with type=TESTIMONIAL
 * @returns {{ quote, author, rating, context } | null}
 */
export function normalizeReview(dataItem) {
  if (!dataItem) return null;
  const d = dataItem.dataJson ?? {};

  const quote = d.quote || d.testimonial || d.review || dataItem.summary || null;
  if (!quote) return null;

  return {
    quote,
    author: d.author || d.name || d.client || null,
    rating: parseNumeric(d.rating || d.stars),
    context: d.result || d.outcome || d.context || null,
  };
}

// ── Selection ───────────────────────────────────────────────────────────

/**
 * Select the best listing from an array of normalized listings.
 * Prefers highest completeness, breaks ties by price presence.
 *
 * @param {Array} normalizedListings
 * @returns {object | null} — best normalized listing
 */
export function selectBestListing(normalizedListings) {
  if (!normalizedListings?.length) return null;
  return normalizedListings.reduce((best, current) => {
    if (current.completenessScore > best.completenessScore) return current;
    if (current.completenessScore === best.completenessScore && current.price && !best.price) return current;
    return best;
  });
}

// ── Asset loader ────────────────────────────────────────────────────────

/**
 * Load real estate generation assets for a workspace.
 * Returns normalized listings + reviews ready for prompt injection.
 * Uses rotation logic: prefers least-used listings with decent completeness.
 *
 * @param {string} workspaceId
 * @param {object} realEstateContext — from resolveRealEstateContext()
 * @returns {Promise<{ bestListing, bestListingSource, reviews, listingCount, reviewCount, businessProfile, rotationApplied }>}
 */
export async function loadRealEstateGenerationAssets(workspaceId, realEstateContext) {
  // Read through canonical asset access layer
  const [listingItems, reviewItems] = await Promise.all([
    getRealEstateListings(workspaceId, { orderBy: "rotation", limit: 20 }),
    getRealEstateTestimonials(workspaceId, { limit: 10 }),
  ]);

  // Normalize all listings
  const normalizedListings = listingItems
    .map((item) => ({ normalized: normalizeListing(item), source: item }))
    .filter((r) => r.normalized && r.normalized.completenessScore >= 2);

  // Rotation: pick best listing from the least-used tier
  const selectedEntry = selectWithRotation(normalizedListings);

  // Normalize reviews
  const reviews = reviewItems
    .map(normalizeReview)
    .filter(Boolean)
    .slice(0, 5);

  return {
    bestListing: selectedEntry?.normalized ?? null,
    bestListingSource: selectedEntry?.source ?? null,
    reviews,
    listingCount: normalizedListings.length,
    reviewCount: reviews.length,
    businessProfile: realEstateContext?.businessProfile ?? null,
    rotationApplied: selectedEntry?.rotated ?? false,
  };
}

/**
 * Select a listing with rotation logic.
 * 1. Find the minimum usageCount among candidates
 * 2. Among those with min usage, pick highest completeness
 * 3. If all have been used, fall back to highest completeness overall
 *
 * @returns {{ normalized, source, rotated: boolean } | null}
 */
function selectWithRotation(normalizedListings) {
  if (!normalizedListings.length) return null;
  if (normalizedListings.length === 1) {
    return { ...normalizedListings[0], rotated: false };
  }

  const minUsage = Math.min(...normalizedListings.map((e) => e.source.usageCount ?? 0));
  const leastUsed = normalizedListings.filter((e) => (e.source.usageCount ?? 0) === minUsage);

  // Among least-used, pick highest completeness
  const best = leastUsed.reduce((a, b) =>
    b.normalized.completenessScore > a.normalized.completenessScore ? b : a);

  // Rotation was applied if we skipped higher-completeness listings that were more used
  const overallBest = normalizedListings.reduce((a, b) =>
    b.normalized.completenessScore > a.normalized.completenessScore ? b : a);

  const rotated = best.source.id !== overallBest.source.id;

  return { ...best, rotated };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function parseNumeric(value) {
  if (value == null) return null;
  if (typeof value === "number") return value;
  const cleaned = String(value).replace(/[^0-9.]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function extractList(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") {
    return value.split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
  }
  return [];
}
