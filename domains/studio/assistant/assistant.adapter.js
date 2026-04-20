// Industry adapter interface + real estate implementation for the AI Content Assistant.
// Wraps existing domain services without duplicating logic.

import { getRealEstateListings } from "../../industry/realEstateAssets.js";
import { listAssets } from "../mediaGeneration.service.js";
import { getIndustryProfile } from "../../industry/registry.js";
import { resolveRealEstateContext } from "../../industry/realEstateContext.js";
import * as campaignIntelligence from "./campaignIntelligence.js";

/**
 * @typedef {Object} IndustryAdapter
 * @property {(workspaceId: string, opts?: object) => Promise<any[]>} getAvailableProperties
 * @property {(clientId: string, opts?: object) => Promise<any[]>} getAutoSelectedMedia
 * @property {(campaignType: string) => string[]} getDefaultChannels
 * @property {() => object} getProfile
 * @property {(workspaceId: string) => Promise<object>} getWorkspaceContext
 */

/**
 * Create an adapter for real estate industry.
 * @returns {IndustryAdapter}
 */
export function createRealEstateAdapter() {
  return {
    /**
     * Fetch available listings for property selection.
     * @param {string} workspaceId
     * @param {{ limit?: number, orderBy?: string }} [opts]
     */
    async getAvailableProperties(workspaceId, opts = {}) {
      return getRealEstateListings(workspaceId, {
        limit: opts.limit || 20,
        orderBy: opts.orderBy || "newest",
      });
    },

    /**
     * Fetch recent ready media assets for auto-selection.
     * @param {string} clientId
     * @param {{ limit?: number, assetType?: string }} [opts]
     */
    async getAutoSelectedMedia(clientId, opts = {}) {
      return listAssets({
        clientId,
        status: "READY",
        assetType: opts.assetType || "image",
        limit: opts.limit || 10,
      });
    },

    /**
     * Get default channels for a campaign type.
     * @param {string} campaignType
     * @returns {string[]}
     */
    getDefaultChannels(campaignType) {
      const defaults = {
        just_listed: ["INSTAGRAM", "FACEBOOK", "LINKEDIN"],
        open_house: ["INSTAGRAM", "FACEBOOK"],
        price_drop: ["INSTAGRAM", "FACEBOOK"],
        general_promotion: ["INSTAGRAM", "FACEBOOK", "LINKEDIN"],
      };
      return defaults[campaignType] || ["INSTAGRAM", "FACEBOOK"];
    },

    /**
     * Get the industry profile configuration.
     * @returns {object}
     */
    getProfile() {
      return getIndustryProfile("real_estate");
    },

    /**
     * Resolve full workspace context (channels, assets, capabilities).
     * @param {string} workspaceId
     */
    async getWorkspaceContext(workspaceId) {
      return resolveRealEstateContext(workspaceId);
    },

    /**
     * Get campaign intelligence functions for recommendations.
     * @returns {typeof campaignIntelligence}
     */
    getIntelligence() {
      return campaignIntelligence;
    },
  };
}

/**
 * Factory to get the adapter for a given industry key.
 * @param {string} industryKey
 * @returns {IndustryAdapter | null}
 */
export function getIndustryAdapter(industryKey) {
  switch (industryKey) {
    case "real_estate":
      return createRealEstateAdapter();
    default:
      return null;
  }
}
