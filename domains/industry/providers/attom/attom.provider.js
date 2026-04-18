// ATTOM PropertyDataProvider — full property data implementation (scaffold).
//
// Implements the PropertyDataProvider interface used by propertyData.service.js.
// This is the search/analytics provider (not the enrichment-only provider in
// providers/attom.provider.js which handles lookupByAddress for field merging).
//
// ── Status: NOT YET IMPLEMENTED ──
//
// To activate:
//   1. Set ATTOM_API_KEY and ATTOM_API_BASE in environment
//   2. Implement HTTP calls in attom.client.js
//   3. Implement response mapping in attom.mappers.js
//   4. Uncomment the import in propertyData.service.js and add to providers array
//
// ATTOM API endpoints to map:
//   - /property/detail → lookupProperty() → UnifiedProperty
//   - /sale/snapshot   → searchListings()  → UnifiedListing[]
//   - /avm/detail      → getPropertyValue() → PropertyValuation
//   - /market/snapshot  → getMarketData()   → MarketSnapshot
//   - (no rent endpoint — getRentEstimate returns null, falls through to RentCast)

import { env } from "../../../../config/env.js";

export const attomPropertyProvider = {
  name: "attom",

  /** @returns {boolean} */
  isAvailable() {
    return Boolean(env.ATTOM_API_KEY);
  },

  /**
   * Look up property records by address.
   * @param {string} address
   * @returns {Promise<import('../../propertyData.types.js').UnifiedProperty | null>}
   */
  async lookupProperty(_address) {
    // TODO: Implement via ATTOM /property/detail endpoint + attom.mappers.mapProperty()
    return null;
  },

  /**
   * Search active sale listings.
   * @param {import('../../propertyData.types.js').PropertySearchParams} params
   * @returns {Promise<import('../../propertyData.types.js').UnifiedListing[]>}
   */
  async searchListings(_params) {
    // TODO: Implement via ATTOM /sale/snapshot endpoint + attom.mappers.mapListing()
    return [];
  },

  /**
   * Get AVM property valuation.
   * @param {string} address
   * @returns {Promise<import('../../propertyData.types.js').PropertyValuation | null>}
   */
  async getPropertyValue(_address) {
    // TODO: Implement via ATTOM /avm/detail endpoint + attom.mappers.mapValuation()
    return null;
  },

  /**
   * Get long-term rent estimate.
   * ATTOM does not provide rent estimates — return null so the service
   * can fall back to another provider or return null to the caller.
   * @param {string} _address
   * @returns {Promise<import('../../propertyData.types.js').RentEstimate | null>}
   */
  async getRentEstimate(_address) {
    return null;
  },

  /**
   * Get market statistics for a zip code.
   * @param {string} zipCode
   * @returns {Promise<import('../../propertyData.types.js').MarketSnapshot | null>}
   */
  async getMarketData(_zipCode) {
    // TODO: Implement via ATTOM /market/snapshot endpoint + attom.mappers.mapMarketData()
    return null;
  },
};
