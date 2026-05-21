// industry-03 — real estate IndustryModule.
//
// Composed from the real-estate-specific config files that
// pre-industry-03 lived inline in promptBuilder.js +
// sites.generation.service.js + the autopilot service. Each
// import is a pure data file — no DB reads.

import {
  getCampaignTypeInstructions,
  getFactsLlmMayNotFabricate,
} from "./prompts.js";
import { REAL_ESTATE_CAMPAIGN_TYPES } from "./campaignTypes.js";
import { REAL_ESTATE_SITE_TEMPLATES } from "./siteTemplates.js";
import { REAL_ESTATE_AUTOPILOT_TRIGGER_TYPES } from "./autopilotTriggers.js";
// industry-04 — RE-specific URL extraction. Wraps the existing
// listingIngestion service so urlCampaignIntake can dispatch per
// industry instead of hard-coding the listing extractor call.
import { realEstateUrlExtraction } from "./urlExtraction.js";

/** @type {import("../types.js").IndustryModule} */
export const realEstateIndustryModule = {
  key: "real_estate",
  label: "Real Estate",
  campaignTypes: REAL_ESTATE_CAMPAIGN_TYPES,
  siteTemplates: REAL_ESTATE_SITE_TEMPLATES,
  autopilotTriggerTypes: REAL_ESTATE_AUTOPILOT_TRIGGER_TYPES,
  promptAddons: {
    getCampaignTypeInstructions,
    getFactsLlmMayNotFabricate,
  },
  urlExtraction: realEstateUrlExtraction,
  // leadFields + dashboardWidgets + onboardingQuestions are
  // placeholders for the future industry-07 work.
  leadFields: [],
  dashboardWidgets: [],
  onboardingQuestions: [],
};
