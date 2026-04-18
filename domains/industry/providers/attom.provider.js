// ATTOM Data Property Enrichment Provider
//
// Uses the ATTOM Data API for property data lookup by address.
// Requires ATTOM_API_KEY environment variable.
// Gracefully returns null on any failure.

const PROVIDER_NAME = "attom";
const API_BASE = "https://api.gateway.attomdata.com/propertyapi/v1.0.0";
const TIMEOUT_MS = 10000;

export const attomProvider = {
  name: PROVIDER_NAME,

  isAvailable() {
    return Boolean(process.env.ATTOM_API_KEY);
  },

  /**
   * Look up property data by address.
   *
   * @param {{ street?: string, city?: string, state?: string, zip?: string }} address
   * @returns {Promise<object|null>}
   */
  async lookupByAddress({ street, city, state, zip }) {
    if (!process.env.ATTOM_API_KEY) return null;

    if (!street) return null;
    const params = new URLSearchParams();
    params.set("address1", street);
    if (city) params.set("address2", [city, state, zip].filter(Boolean).join(", "));

    const url = `${API_BASE}/property/detail?${params}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(url, {
        method: "GET",
        headers: {
          apikey: process.env.ATTOM_API_KEY,
          Accept: "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        console.warn(`[PropertyEnrichment:attom] API responded ${response.status}`);
        return null;
      }

      const data = await response.json();
      return mapResponse(data);
    } catch (err) {
      if (err.name === "AbortError") {
        console.warn("[PropertyEnrichment:attom] Request timed out");
      } else {
        console.warn("[PropertyEnrichment:attom] Request failed:", err.message);
      }
      return null;
    }
  },
};

/**
 * Map ATTOM API response to our EnrichmentResult shape.
 */
function mapResponse(data) {
  if (!data?.property?.[0]) return null;

  const prop = data.property[0];
  const building = prop.building || {};
  const lot = prop.lot || {};
  const summary = building.summary || {};
  const assessment = prop.assessment || {};
  const sale = prop.sale || {};

  const result = { provider: PROVIDER_NAME };

  if (summary.beds != null) result.bedrooms = Number(summary.beds) || null;
  if (summary.baths != null) result.bathrooms = Number(summary.baths) || null;
  if (summary.livingSize != null) result.sqft = Number(summary.livingSize) || null;
  if (lot.lotSize1 != null) result.lotSize = String(lot.lotSize1);
  if (summary.yearBuilt != null) result.yearBuilt = Number(summary.yearBuilt) || null;
  if (building.parking?.garageSpaces != null) result.garage = Number(building.parking.garageSpaces) || null;
  if (summary.propType) result.propertyType = normalizePropertyType(summary.propType);

  // Value fields
  if (assessment.assessed?.assdTtlValue != null) result.taxAssessedValue = Number(assessment.assessed.assdTtlValue) || null;
  if (sale.saleAmountData?.saleAmt != null) result.lastSalePrice = Number(sale.saleAmountData.saleAmt) || null;
  if (sale.saleAmountData?.saleRecDate) result.lastSaleDate = String(sale.saleAmountData.saleRecDate);

  // Features
  const features = [];
  if (building.interior?.fplcCount > 0) features.push("Fireplace");
  if (building.summary?.pool === "Y") features.push("Pool");
  if (building.summary?.airCond) features.push(`AC: ${building.summary.airCond}`);
  if (building.summary?.heating) features.push(`Heat: ${building.summary.heating}`);
  if (features.length > 0) result.features = features;

  return result;
}

function normalizePropertyType(type) {
  if (!type) return null;
  const lower = String(type).toLowerCase();
  if (lower.includes("sfr") || lower.includes("single")) return "single_family";
  if (lower.includes("condo")) return "condo";
  if (lower.includes("town")) return "townhouse";
  if (lower.includes("multi") || lower.includes("duplex")) return "multi_family";
  if (lower.includes("land") || lower.includes("lot")) return "land";
  if (lower.includes("commercial")) return "commercial";
  if (lower.includes("apartment")) return "apartment";
  return "other";
}
