// Property Data Service — provider-agnostic facade with Redis caching.
//
// The rest of the app calls this service. It delegates to the active
// provider, caches results in Redis, and deduplicates concurrent requests.
//
// ── Caching Policy (TTLs in seconds) ──
//
//  Data type          │ TTL     │ Rationale
//  ───────────────────┼─────────┼────────────────────────────────────────
//  Property lookup    │ 6 hours │ Core data changes infrequently
//  Listing search     │ 1 hour  │ Inventory updates throughout the day
//  Nearby listings    │ 1 hour  │ Same as search — ZIP-based queries
//  Valuation (AVM)    │ 12 hrs  │ AVMs update daily at most
//  Rent estimate      │ 12 hrs  │ Same cadence as valuations
//  Market snapshot    │ 24 hrs  │ Aggregate stats are slow-moving
//
// Cache keys are normalized (lowercased, whitespace-collapsed, sorted
// params) so "123 Main St" and "123  main  st" hit the same entry.
//
// ── Adding a new provider (e.g. ATTOM) ──
//
// 1. Create providers/attom/attom.provider.js implementing PropertyDataProvider
// 2. Import and append to the `providers` array below
// 3. Add env vars (ATTOM_API_KEY, ATTOM_API_BASE) to config/env.js
// 4. Set PROPERTY_DATA_PROVIDER=attom or keep "rentcast" — ATTOM falls
//    back automatically when RentCast is unavailable.
//
// Caching is provider-agnostic — cache keys use the prefix "sp:propdata:"
// and do NOT include the provider name. If the provider changes, cached
// results still serve until TTL expires, then the new provider fills them.

import { env } from "../../config/env.js";
import { redisGet, redisSet } from "../../redis.js";
import { rentcastPropertyProvider } from "./providers/rentcast/rentcast.provider.js";

// ── Provider Registry ─────────────────────────────────────────────────────
//
// Ordered by fallback priority. When the configured provider is unavailable,
// getProvider() walks this list and returns the first available one.
//
// To add ATTOM:
//   import { attomPropertyProvider } from "./providers/attom/attom.provider.js";
//   const providers = [rentcastPropertyProvider, attomPropertyProvider];

const providers = [rentcastPropertyProvider];

/**
 * Resolve the provider to use for a given call.
 *
 * Resolution order:
 *   1. Exact match on PROPERTY_DATA_PROVIDER env var, if available
 *   2. Fallback: first provider in `providers` whose isAvailable() is true
 *   3. null — no provider configured or available
 *
 * @returns {import('./propertyData.types.js').PropertyDataProvider | null}
 */
function getProvider() {
  const name = env.PROPERTY_DATA_PROVIDER;

  const configured = providers.find((p) => p.name === name);
  if (configured?.isAvailable()) return configured;

  if (configured && !configured.isAvailable()) {
    console.warn(`[PropertyData] Provider "${name}" unavailable (missing key?), trying fallback`);
  } else if (!configured) {
    console.warn(`[PropertyData] Unknown provider "${name}", trying fallback`);
  }

  const fallback = providers.find((p) => p.isAvailable());
  if (fallback) console.info(`[PropertyData] Falling back to "${fallback.name}"`);
  return fallback ?? null;
}

/** @returns {string} Active provider name or "none" */
export function getActivePropertyDataProviderName() {
  return getProvider()?.name ?? "none";
}

// ── TTL Configuration ─────────────────────────────────────────────────────

const TTL = {
  PROPERTY_LOOKUP: 6 * 3600,   // 6 hours
  LISTING_SEARCH:  3600,        // 1 hour
  VALUATION:       12 * 3600,   // 12 hours
  RENT_ESTIMATE:   12 * 3600,   // 12 hours
  MARKET_DATA:     24 * 3600,   // 24 hours
};

// ── Cache Helpers ─────────────────────────────────────────────────────────

/**
 * Normalize a string for cache key use.
 * Lowercase, collapse whitespace, strip trailing/leading spaces.
 */
function norm(s) {
  return (s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Build a stable cache key from a prefix and parts.
 * Normalizes all parts so equivalent queries share the same key.
 */
function cacheKey(prefix, ...parts) {
  const normalized = parts
    .map((p) => (typeof p === "object" ? JSON.stringify(p, Object.keys(p).sort()) : norm(String(p ?? ""))))
    .filter(Boolean)
    .join("|");
  return `sp:propdata:${prefix}:${normalized}`;
}

/**
 * Get a cached value. Returns null on miss or Redis error.
 * @param {string} key
 * @returns {Promise<any>}
 */
async function getCached(key) {
  try {
    const raw = await redisGet(key);
    if (raw) {
      console.debug(`[PropertyData:cache] HIT ${key.slice(0, 60)}`);
      return JSON.parse(raw);
    }
    console.debug(`[PropertyData:cache] MISS ${key.slice(0, 60)}`);
    return null;
  } catch {
    return null;
  }
}

/**
 * Set a cached value. Failures are non-critical.
 * @param {string} key
 * @param {any} value
 * @param {number} ttl — seconds
 */
async function setCache(key, value, ttl) {
  try {
    await redisSet(key, JSON.stringify(value), ttl);
  } catch {
    // Non-critical — next call is a cache miss
  }
}

// ── In-flight Request Deduplication ───────────────────────────────────────
//
// If two callers request the same data simultaneously, only one provider
// call is made. The second caller awaits the same promise.

/** @type {Map<string, Promise<any>>} */
const inflight = new Map();

/**
 * Deduplicate concurrent requests. If a request with the same key is
 * already in flight, return its promise instead of starting a new one.
 *
 * @param {string} key — dedup key (same as cache key)
 * @param {() => Promise<any>} fn — the actual work
 * @returns {Promise<any>}
 */
async function dedup(key, fn) {
  const existing = inflight.get(key);
  if (existing) {
    console.debug(`[PropertyData:dedup] Sharing in-flight request for ${key.slice(0, 60)}`);
    return existing;
  }

  const promise = fn().finally(() => inflight.delete(key));
  inflight.set(key, promise);
  return promise;
}

// ── Public API ────────────────────────────────────────────────────────────

/**
 * Look up a property by address (cached 6h).
 * @param {string} address
 * @returns {Promise<import('./propertyData.types.js').UnifiedProperty | null>}
 */
export async function lookupProperty(address) {
  const key = cacheKey("prop", address);

  const cached = await getCached(key);
  if (cached) return cached;

  const provider = getProvider();
  if (!provider) return null;

  return dedup(key, async () => {
    const result = await provider.lookupProperty(address);
    if (result) await setCache(key, result, TTL.PROPERTY_LOOKUP);
    return result;
  });
}

/**
 * Search active sale listings (cached 1h).
 * @param {import('./propertyData.types.js').PropertySearchParams} params
 * @returns {Promise<import('./propertyData.types.js').UnifiedListing[]>}
 */
export async function searchListings(params) {
  // Build stable cache key from sorted params
  const keyParts = {};
  for (const k of Object.keys(params).sort()) {
    if (params[k] != null && params[k] !== "") keyParts[k] = params[k];
  }
  const key = cacheKey("search", keyParts);

  const cached = await getCached(key);
  if (cached) return cached;

  const provider = getProvider();
  if (!provider) return [];

  return dedup(key, async () => {
    const result = await provider.searchListings(params);
    if (result.length > 0) await setCache(key, result, TTL.LISTING_SEARCH);
    return result;
  });
}

/**
 * Get AVM property valuation (cached 12h).
 * @param {string} address
 * @returns {Promise<import('./propertyData.types.js').PropertyValuation | null>}
 */
export async function getPropertyValue(address) {
  const key = cacheKey("val", address);

  const cached = await getCached(key);
  if (cached) return cached;

  const provider = getProvider();
  if (!provider) return null;

  return dedup(key, async () => {
    const result = await provider.getPropertyValue(address);
    if (result) await setCache(key, result, TTL.VALUATION);
    return result;
  });
}

/**
 * Get long-term rent estimate (cached 12h).
 * @param {string} address
 * @returns {Promise<import('./propertyData.types.js').RentEstimate | null>}
 */
export async function getRentEstimate(address) {
  const key = cacheKey("rent", address);

  const cached = await getCached(key);
  if (cached) return cached;

  const provider = getProvider();
  if (!provider) return null;

  return dedup(key, async () => {
    const result = await provider.getRentEstimate(address);
    if (result) await setCache(key, result, TTL.RENT_ESTIMATE);
    return result;
  });
}

/**
 * Get market statistics for a zip code (cached 24h).
 * @param {string} zipCode
 * @returns {Promise<import('./propertyData.types.js').MarketSnapshot | null>}
 */
export async function getMarketData(zipCode) {
  const key = cacheKey("mkt", zipCode);

  const cached = await getCached(key);
  if (cached) return cached;

  const provider = getProvider();
  if (!provider) return null;

  return dedup(key, async () => {
    const result = await provider.getMarketData(zipCode);
    if (result) await setCache(key, result, TTL.MARKET_DATA);
    return result;
  });
}
