// industry-04 — real estate URL extractor.
//
// Thin wrapper around the existing listingIngestion service so
// the registry can dispatch URL handling per industry without
// having to import service code from urlCampaignIntake. Keeps
// the seam thin until industry-07 (when listingIngestion.service
// guts may move into this module entirely).
//
// listingIngestion's entry points already enforce the
// industry-01 real-estate gate (assertRealEstateWorkspace) as
// defense-in-depth; the dispatch in urlCampaignIntake also
// checks industryKey before calling here, so these wrappers
// stay simple.

import {
  ingestUrlListing,
  confirmUrlListing,
} from "../../../studio/listingIngestion.service.js";

export const realEstateUrlExtraction = {
  kind: "real_estate_listing",
  /**
   * Extract listing data from a single URL.
   * @param {string} clientId
   * @param {string} url
   * @returns {Promise<{ preview: object|null, normalized: object, quality: object }>}
   */
  async analyze(clientId, url) {
    return await ingestUrlListing(clientId, url);
  },
  /**
   * Persist a (possibly user-edited) listing as a
   * WorkspaceDataItem. Returns { listing, created, existingId? }.
   * @param {string} clientId
   * @param {object} listing
   */
  async confirm(clientId, listing) {
    return await confirmUrlListing(clientId, listing);
  },
};
