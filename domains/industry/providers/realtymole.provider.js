// RealtyMole Property Enrichment Provider
//
// Uses the RealtyMole API for property data lookup by address.
// Requires REALTYMOLE_API_KEY environment variable.
// Gracefully returns null on any failure.

const PROVIDER_NAME = "realtymole";
const API_BASE = "https://realtymole.com/api/v1/property";
const TIMEOUT_MS = 10000;

export const realtymoleProvider = {
  name: PROVIDER_NAME,

  isAvailable() {
    return Boolean(process.env.REALTYMOLE_API_KEY);
  },

  /**
   * Look up property data by address.
   *
   * @param {{ street?: string, city?: string, state?: string, zip?: string }} address
   * @returns {Promise<object|null>}
   */
  async lookupByAddress({ street, city, state, zip }) {
    if (!process.env.REALTYMOLE_API_KEY) return null;

    const addressParts = [street, city, state, zip].filter(Boolean);
    if (addressParts.length < 2) return null;

    const encoded = encodeURIComponent(addressParts.join(", "));
    const url = `${API_BASE}?address=${encoded}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(url, {
        method: "GET",
        headers: {
          "x-api-key": process.env.REALTYMOLE_API_KEY,
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        console.warn(`[PropertyEnrichment:realtymole] API responded ${response.status}`);
        return null;
      }

      const data = await response.json();
      return mapResponse(data);
    } catch (err) {
      if (err.name === "AbortError") {
        console.warn("[PropertyEnrichment:realtymole] Request timed out");
      } else {
        console.warn("[PropertyEnrichment:realtymole] Request failed:", err.message);
      }
      return null;
    }
  },
};

/**
 * Map RealtyMole API response to our EnrichmentResult shape.
 */
function mapResponse(data) {
  if (!data || typeof data !== "object") return null;

  const result = { provider: PROVIDER_NAME };

  if (data.bedrooms != null) result.bedrooms = Number(data.bedrooms) || null;
  if (data.bathrooms != null) result.bathrooms = Number(data.bathrooms) || null;
  if (data.squareFootage != null) result.sqft = Number(data.squareFootage) || null;
  if (data.lotSize != null) result.lotSize = String(data.lotSize);
  if (data.yearBuilt != null) result.yearBuilt = Number(data.yearBuilt) || null;
  if (data.garageSpaces != null) result.garage = Number(data.garageSpaces) || null;
  if (data.propertyType) result.propertyType = normalizePropertyType(data.propertyType);
  if (data.features && Array.isArray(data.features)) result.features = data.features;

  // Value fields
  if (data.price != null) result.estimatedValue = Number(data.price) || null;
  if (data.assessedValue != null) result.taxAssessedValue = Number(data.assessedValue) || null;
  if (data.lastSalePrice != null) result.lastSalePrice = Number(data.lastSalePrice) || null;
  if (data.lastSaleDate) result.lastSaleDate = String(data.lastSaleDate);

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
