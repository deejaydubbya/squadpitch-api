// Property Enrichment Service — provider abstraction + three-tier merge logic.
//
// Enrichment fills gaps only — never overwrites user-provided or extracted data.
// Field sources are tracked in _fieldSources for auditability.
//
// Merge priority (field-level):
//   Tier 1 (highest): user-provided ("manual")
//   Tier 2: extracted ("url", "csv", "listing_feed")
//   Tier 3 (lowest): API-enriched ("realtymole", "mock")

import { prisma } from "../../prisma.js";
import { mockProvider } from "./providers/mock.provider.js";
import { realtymoleProvider } from "./providers/realtymole.provider.js";
import { attomProvider } from "./providers/attom.provider.js";
import { estatedProvider } from "./providers/estated.provider.js";
import { rentcastProvider } from "./providers/rentcast.provider.js";

// Fields that can be enriched from property APIs
const ENRICHABLE_FIELDS = [
  "bedrooms", "bathrooms", "sqft", "lotSize", "yearBuilt", "garage",
  "propertyType", "features", "estimatedValue", "taxAssessedValue",
  "lastSalePrice", "lastSaleDate",
];

// Source tier ranking (lower = higher priority)
const SOURCE_TIERS = {
  manual: 1,
  url: 2,
  csv: 2,
  listing_feed: 2,
  realtymole: 3,
  attom: 3,
  estated: 3,
  rentcast: 3,
  mock: 3,
};

// ── Provider Registry ────────────────────────────────────────────────────

const providers = [realtymoleProvider, attomProvider, estatedProvider, rentcastProvider, mockProvider];

function getActiveProvider() {
  const configured = process.env.PROPERTY_API_PROVIDER || "mock";

  // Try the configured provider first
  for (const p of providers) {
    if (p.name === configured && p.isAvailable()) return p;
  }

  // Fall back to mock
  return mockProvider;
}

/**
 * Get the name of the currently active enrichment provider.
 * @returns {string}
 */
export function getActiveProviderName() {
  return getActiveProvider().name;
}

// ── Merge Logic ──────────────────────────────────────────────────────────

/**
 * Three-tier field-level merge. Enrichment fills gaps only.
 * Never overwrites a field that has a higher-tier source.
 *
 * @param {object} existingDataJson — current dataJson from the listing
 * @param {object} enrichmentResult — result from provider lookup
 * @returns {{ mergedDataJson: object, fieldsAdded: string[] }}
 */
export function mergeListing(existingDataJson, enrichmentResult) {
  const merged = { ...existingDataJson };
  const fieldSources = { ...(existingDataJson._fieldSources || {}) };
  const fieldsAdded = [];
  const providerName = enrichmentResult.provider || "mock";
  const providerTier = SOURCE_TIERS[providerName] || 3;

  for (const field of ENRICHABLE_FIELDS) {
    const enrichedValue = enrichmentResult[field];
    if (enrichedValue == null) continue;

    // Skip empty arrays
    if (Array.isArray(enrichedValue) && enrichedValue.length === 0) continue;

    const existingValue = merged[field];
    const existingSource = fieldSources[field];
    const existingTier = existingSource ? (SOURCE_TIERS[existingSource] || 3) : Infinity;

    // Only fill if: no existing value, or existing value is from a lower-priority (higher number) tier
    if (existingValue == null || existingValue === "" || existingValue === 0) {
      merged[field] = enrichedValue;
      fieldSources[field] = providerName;
      fieldsAdded.push(field);
    } else if (field === "features" && Array.isArray(existingValue) && Array.isArray(enrichedValue)) {
      // Special merge for features: append new unique features
      const existing = new Set(existingValue.map((f) => f.toLowerCase()));
      const newFeatures = enrichedValue.filter((f) => !existing.has(f.toLowerCase()));
      if (newFeatures.length > 0) {
        merged[field] = [...existingValue, ...newFeatures];
        fieldsAdded.push(field);
        // Keep original source since we're appending
      }
    }
    // If existingValue is present and from a higher-tier source, do not overwrite
  }

  merged._fieldSources = fieldSources;
  merged._enrichedAt = new Date().toISOString();
  merged._enrichmentProvider = providerName;

  return { mergedDataJson: merged, fieldsAdded };
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Enrich a data item with property API data.
 * Looks up the address via the active provider, merges, and persists.
 *
 * @param {object} dataItem — WorkspaceDataItem record (must include id, dataJson)
 * @returns {Promise<{ enriched: boolean, fieldsAdded: string[], provider: string }>}
 */
export async function enrichListing(dataItem) {
  const dj = dataItem.dataJson || {};
  const provider = getActiveProvider();

  // Build address from dataJson fields
  const address = {
    street: dj.street || dj.address || null,
    city: dj.city || null,
    state: dj.state || null,
    zip: dj.zip || null,
  };

  // Need at least a street to look up
  if (!address.street) {
    return { enriched: false, fieldsAdded: [], provider: provider.name };
  }

  let result;
  try {
    result = await provider.lookupByAddress(address);
  } catch (err) {
    console.error(`[PropertyEnrichment] Provider ${provider.name} error:`, err.message);
    return { enriched: false, fieldsAdded: [], provider: provider.name };
  }

  if (!result) {
    return { enriched: false, fieldsAdded: [], provider: provider.name };
  }

  const { mergedDataJson, fieldsAdded } = mergeListing(dj, result);

  if (fieldsAdded.length > 0) {
    await prisma.workspaceDataItem.update({
      where: { id: dataItem.id },
      data: { dataJson: mergedDataJson },
    });
  }

  return { enriched: fieldsAdded.length > 0, fieldsAdded, provider: provider.name };
}

/**
 * Convenience wrapper — enrich by clientId + dataItemId.
 *
 * @param {string} clientId
 * @param {string} dataItemId
 * @returns {Promise<{ enriched: boolean, fieldsAdded: string[], provider: string }>}
 */
export async function enrichListingById(clientId, dataItemId) {
  const item = await prisma.workspaceDataItem.findFirst({
    where: { id: dataItemId, clientId, status: "ACTIVE" },
  });

  if (!item) {
    throw Object.assign(new Error("Listing not found"), { status: 404 });
  }

  return enrichListing(item);
}

/**
 * Bulk-enrich up to `limit` listings that haven't been enriched yet.
 *
 * @param {string} clientId
 * @param {number} [limit=20]
 * @returns {Promise<{ enriched: number, skipped: number, results: object[] }>}
 */
export async function enrichAllListings(clientId, limit = 20) {
  const items = await prisma.workspaceDataItem.findMany({
    where: {
      clientId,
      type: { in: ["PROPERTY", "CUSTOM"] },
      status: "ACTIVE",
    },
    orderBy: { createdAt: "desc" },
    take: limit * 2, // Fetch extra to filter enriched ones
  });

  // Filter to items that haven't been enriched, or were enriched > 7 days ago
  const ENRICHMENT_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
  const now = Date.now();
  const unenriched = items
    .filter((item) => {
      const enrichedAt = item.dataJson?._enrichedAt;
      if (!enrichedAt) return true; // Never enriched
      return (now - new Date(enrichedAt).getTime()) > ENRICHMENT_FRESHNESS_MS;
    })
    .slice(0, limit);

  const results = [];
  let enriched = 0;
  let skipped = 0;

  for (const item of unenriched) {
    const result = await enrichListing(item);
    if (result.enriched) {
      enriched++;
    } else {
      skipped++;
    }
    results.push({ id: item.id, ...result });
  }

  return { enriched, skipped, results };
}
