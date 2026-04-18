// RentCast Property Enrichment Provider
//
// Uses the shared RentCast client for property data lookup by address.
// Returns the enrichment-specific result shape (not the full unified model).
// Gracefully returns null on any failure.

import { rentcastRequest } from "./rentcast/rentcast.client.js";
import { normalizePropertyType } from "./rentcast/rentcast.mappers.js";

const PROVIDER_NAME = "rentcast";

export const rentcastProvider = {
  name: PROVIDER_NAME,

  isAvailable() {
    return Boolean(process.env.RENTCAST_API_KEY);
  },

  /**
   * Look up property data by address.
   *
   * @param {{ street?: string, city?: string, state?: string, zip?: string }} address
   * @returns {Promise<object|null>}
   */
  async lookupByAddress({ street, city, state, zip }) {
    if (!street) return null;

    const address = [street, city, state, zip].filter(Boolean).join(", ");

    try {
      const data = await rentcastRequest("/properties", { address });
      return mapResponse(data);
    } catch (err) {
      console.warn("[PropertyEnrichment:rentcast] Request failed:", err.message);
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
