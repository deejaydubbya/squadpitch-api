// industry-03 — generic IndustryModule.
//
// The fallback module loaded when industryKey is null/unknown or
// when an industry hasn't extracted its own surface yet.

import {
  getCampaignTypeInstructions,
  getFactsLlmMayNotFabricate,
} from "./prompts.js";
import { GENERIC_CAMPAIGN_TYPES } from "./campaignTypes.js";
import { GENERIC_SITE_TEMPLATES } from "./siteTemplates.js";

/** @type {import("../types.js").IndustryModule} */
export const genericIndustryModule = {
  key: "generic",
  label: "Generic (no industry)",
  campaignTypes: GENERIC_CAMPAIGN_TYPES,
  siteTemplates: GENERIC_SITE_TEMPLATES,
  // No autopilot until an industry implements its trigger
  // detectors. Empty array = feature disabled (industry-04 will
  // gate the autopilot UI on this flag).
  autopilotTriggerTypes: [],
  promptAddons: {
    getCampaignTypeInstructions,
    getFactsLlmMayNotFabricate,
  },
  urlExtraction: null,
  leadFields: [],
  dashboardWidgets: [],
  onboardingQuestions: [],
};
