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
// industry-04 — neutral URL analyzer. Returns title / description /
// siteName / ogImage / etc. with no property/listing fields.
import { analyzeGenericUrl } from "./urlExtraction.js";

/** @type {import("../types.js").IndustryModule} */
export const genericIndustryModule = {
  key: "generic",
  label: "Generic (no industry)",
  campaignTypes: GENERIC_CAMPAIGN_TYPES,
  siteTemplates: GENERIC_SITE_TEMPLATES,
  // No autopilot until an industry implements its trigger
  // detectors. Empty array = feature disabled.
  autopilotTriggerTypes: [],
  promptAddons: {
    getCampaignTypeInstructions,
    getFactsLlmMayNotFabricate,
  },
  // industry-04 — every industry gets a generic page analyzer via
  // the fallback module. Industry-specific modules (real_estate)
  // override with their own extraction shape.
  urlExtraction: {
    kind: "generic_url",
    analyze: analyzeGenericUrl,
    // No confirm — saving generic URLs as data items is out of
    // scope until a later prompt. The FE routes to "use as idea"
    // for now.
    confirm: null,
  },
  leadFields: [],
  dashboardWidgets: [],
  onboardingQuestions: [],
};
