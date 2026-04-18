// RentCast PropertyDataProvider — full property data implementation.
//
// Implements the provider interface used by propertyData.service.js.
// Covers all 4 RentCast endpoint categories: properties, AVM value,
// AVM rent, and markets.

import { env } from "../../../../config/env.js";
import { rentcastRequest } from "./rentcast.client.js";
import {
  mapProperty,
  mapListing,
  mapValuation,
  mapRentEstimate,
  mapMarketData,
} from "./rentcast.mappers.js";

export const rentcastPropertyProvider = {
  name: "rentcast",

  /** @returns {boolean} */
  isAvailable() {
    return Boolean(env.RENTCAST_API_KEY);
  },

  /**
   * Look up property records by address.
   * @param {string} address - Full address string
   * @returns {Promise<import('../../propertyData.types.js').UnifiedProperty | null>}
   */
  async lookupProperty(address) {
    try {
      const data = await rentcastRequest("/properties", { address });
      const raw = Array.isArray(data) ? data[0] : data;
      return mapProperty(raw);
    } catch (err) {
      console.warn(`[RentCast:lookupProperty] ${err.message}`);
      return null;
    }
  },

  /**
   * Search active sale listings.
   * @param {import('../../propertyData.types.js').PropertySearchParams} params
   * @returns {Promise<import('../../propertyData.types.js').UnifiedListing[]>}
   */
  async searchListings(params) {
    try {
      const query = {};
      if (params.address) query.address = params.address;
      if (params.city) query.city = params.city;
      if (params.state) query.state = params.state;
      if (params.zipCode) query.zipCode = params.zipCode;
      if (params.latitude) query.latitude = params.latitude;
      if (params.longitude) query.longitude = params.longitude;
      if (params.radius) query.radius = params.radius;
      if (params.propertyType) query.propertyType = params.propertyType;
      if (params.limit) query.limit = params.limit;
      if (params.offset) query.offset = params.offset;

      const data = await rentcastRequest("/listings/sale", query);
      const items = Array.isArray(data) ? data : [];
      return items.map(mapListing).filter(Boolean);
    } catch (err) {
      console.warn(`[RentCast:searchListings] ${err.message}`);
      return [];
    }
  },

  /**
   * Get AVM property valuation.
   * @param {string} address
   * @returns {Promise<import('../../propertyData.types.js').PropertyValuation | null>}
   */
  async getPropertyValue(address) {
    try {
      const data = await rentcastRequest("/avm/value", { address });
      return mapValuation(data);
    } catch (err) {
      console.warn(`[RentCast:getPropertyValue] ${err.message}`);
      return null;
    }
  },

  /**
   * Get long-term rent estimate.
   * @param {string} address
   * @returns {Promise<import('../../propertyData.types.js').RentEstimate | null>}
   */
  async getRentEstimate(address) {
    try {
      const data = await rentcastRequest("/avm/rent/long-term", { address });
      return mapRentEstimate(data);
    } catch (err) {
      console.warn(`[RentCast:getRentEstimate] ${err.message}`);
      return null;
    }
  },

  /**
   * Get market statistics for a zip code.
   * @param {string} zipCode
   * @returns {Promise<import('../../propertyData.types.js').MarketSnapshot | null>}
   */
  async getMarketData(zipCode) {
    try {
      const data = await rentcastRequest("/markets", { zipCode });
      return mapMarketData(data, zipCode);
    } catch (err) {
      console.warn(`[RentCast:getMarketData] ${err.message}`);
      return null;
    }
  },
};
