// RentCast Property Enrichment Provider
//
// Uses the RentCast API for property data lookup by address.
// API key comes from per-workspace tech stack connection (encrypted in DB).
// Gracefully returns null on any failure.

const PROVIDER_NAME = "rentcast";
const API_BASE = "https://api.rentcast.io/v1";
const TIMEOUT_MS = 10000;

export const rentcastProvider = {
  name: PROVIDER_NAME,

  isAvailable(apiKey) {
    return Boolean(apiKey);
  },

  /**
   * Look up property data by address.
   *
   * @param {{ street?: string, city?: string, state?: string, zip?: string }} address
   * @param {string} apiKey
   * @returns {Promise<object|null>}
   */
  async lookupByAddress({ street, city, state, zip }, apiKey) {
    if (!apiKey) return null;

    if (!street) return null;
    const params = new URLSearchParams();
    params.set("address", [street, city, state, zip].filter(Boolean).join(", "));

    const url = `${API_BASE}/properties?${params}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(url, {
        method: "GET",
        headers: {
          "X-Api-Key": apiKey,
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        console.warn(`[PropertyEnrichment:rentcast] API responded ${response.status}`);
        return null;
      }

      const data = await response.json();
      return mapResponse(data);
    } catch (err) {
      if (err.name === "AbortError") {
        console.warn("[PropertyEnrichment:rentcast] Request timed out");
      } else {
        console.warn("[PropertyEnrichment:rentcast] Request failed:", err.message);
      }
      return null;
    }
  },
};

/**
 * Map RentCast API response to our EnrichmentResult shape.
 */
function mapResponse(data) {
  // RentCast returns an array of matches
  const prop = Array.isArray(data) ? data[0] : data;
  if (!prop || typeof prop !== "object") return null;

  const result = { provider: PROVIDER_NAME };

  if (prop.bedrooms != null) result.bedrooms = Number(prop.bedrooms) || null;
  if (prop.bathrooms != null) result.bathrooms = Number(prop.bathrooms) || null;
  if (prop.squareFootage != null) result.sqft = Number(prop.squareFootage) || null;
  if (prop.lotSize != null) result.lotSize = String(prop.lotSize);
  if (prop.yearBuilt != null) result.yearBuilt = Number(prop.yearBuilt) || null;
  if (prop.garageSpaces != null) result.garage = Number(prop.garageSpaces) || null;
  if (prop.propertyType) result.propertyType = normalizePropertyType(prop.propertyType);

  // Value fields
  if (prop.price != null) result.estimatedValue = Number(prop.price) || null;
  if (prop.assessedValue != null) result.taxAssessedValue = Number(prop.assessedValue) || null;
  if (prop.lastSalePrice != null) result.lastSalePrice = Number(prop.lastSalePrice) || null;
  if (prop.lastSaleDate) result.lastSaleDate = String(prop.lastSaleDate);

  // Features
  const features = [];
  if (prop.features && Array.isArray(prop.features)) {
    features.push(...prop.features);
  }
  if (features.length > 0) result.features = features;

  return result;
}

function normalizePropertyType(type) {
  if (!type) return null;
  const lower = String(type).toLowerCase();
  if (lower.includes("single") || lower.includes("house")) return "single_family";
  if (lower.includes("condo")) return "condo";
  if (lower.includes("town")) return "townhouse";
  if (lower.includes("multi") || lower.includes("duplex")) return "multi_family";
  if (lower.includes("land") || lower.includes("lot")) return "land";
  if (lower.includes("commercial")) return "commercial";
  if (lower.includes("apartment")) return "apartment";
  return "other";
}
