// Estated Property Enrichment Provider
//
// Uses the Estated API for property data lookup by address.
// Requires ESTATED_API_KEY environment variable.
// Gracefully returns null on any failure.

const PROVIDER_NAME = "estated";
const API_BASE = "https://apis.estated.com/v4/property";
const TIMEOUT_MS = 10000;

export const estatedProvider = {
  name: PROVIDER_NAME,

  isAvailable() {
    return Boolean(process.env.ESTATED_API_KEY);
  },

  /**
   * Look up property data by address.
   *
   * @param {{ street?: string, city?: string, state?: string, zip?: string }} address
   * @returns {Promise<object|null>}
   */
  async lookupByAddress({ street, city, state, zip }) {
    if (!process.env.ESTATED_API_KEY) return null;

    if (!street) return null;
    const params = new URLSearchParams();
    params.set("token", process.env.ESTATED_API_KEY);
    params.set("street_address", street);
    if (city) params.set("city", city);
    if (state) params.set("state", state);
    if (zip) params.set("zip_code", zip);

    const url = `${API_BASE}?${params}`;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        console.warn(`[PropertyEnrichment:estated] API responded ${response.status}`);
        return null;
      }

      const data = await response.json();
      return mapResponse(data);
    } catch (err) {
      if (err.name === "AbortError") {
        console.warn("[PropertyEnrichment:estated] Request timed out");
      } else {
        console.warn("[PropertyEnrichment:estated] Request failed:", err.message);
      }
      return null;
    }
  },
};

/**
 * Map Estated API response to our EnrichmentResult shape.
 */
function mapResponse(data) {
  if (!data?.data) return null;

  const prop = data.data;
  const structure = prop.structure || {};
  const parcel = prop.parcel || {};
  const assessments = prop.assessments?.[0] || {};
  const deeds = prop.deeds?.[0] || {};

  const result = { provider: PROVIDER_NAME };

  if (structure.beds_count != null) result.bedrooms = Number(structure.beds_count) || null;
  if (structure.baths != null) result.bathrooms = Number(structure.baths) || null;
  if (structure.total_area_sq_ft != null) result.sqft = Number(structure.total_area_sq_ft) || null;
  if (parcel.area_sq_ft != null) result.lotSize = String(parcel.area_sq_ft);
  if (structure.year_built != null) result.yearBuilt = Number(structure.year_built) || null;
  if (structure.parking_spaces_count != null) result.garage = Number(structure.parking_spaces_count) || null;
  if (prop.property_type) result.propertyType = normalizePropertyType(prop.property_type);

  // Value fields
  if (prop.valuation?.value != null) result.estimatedValue = Number(prop.valuation.value) || null;
  if (assessments.total_value != null) result.taxAssessedValue = Number(assessments.total_value) || null;
  if (deeds.sale_price != null) result.lastSalePrice = Number(deeds.sale_price) || null;
  if (deeds.sale_date) result.lastSaleDate = String(deeds.sale_date);

  // Features
  const features = [];
  if (structure.fireplaces_count > 0) features.push("Fireplace");
  if (structure.pool_type) features.push(`Pool: ${structure.pool_type}`);
  if (structure.air_conditioning_type) features.push(`AC: ${structure.air_conditioning_type}`);
  if (structure.heating_type) features.push(`Heat: ${structure.heating_type}`);
  if (structure.roof_material_type) features.push(`Roof: ${structure.roof_material_type}`);
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
