// industry-03 — real estate prompt config.
//
// Owns the real-estate-specific campaign-type instructions and
// fabrication rules that pre-industry-03 lived inline in
// promptBuilder.js + sites.generation.service.js. Generic keys
// fall through to the generic module so RE workspaces can still
// run any cross-industry campaign type (Awareness, Lead Gen, etc.)
// without duplicating the strings here.

import {
  getCampaignTypeInstructions as getGenericCampaignTypeInstructions,
  GENERIC_FACTS_LLM_MAY_NOT_FABRICATE,
} from "../generic/prompts.js";

// Real-estate-only campaign type instructions. Mirrors what was
// in promptBuilder.js CAMPAIGN_TYPE_INSTRUCTIONS pre-industry-03.
const REAL_ESTATE_CAMPAIGN_TYPE_INSTRUCTIONS = {
  just_listed: `CAMPAIGN TYPE: JUST LISTED
- Tone: Excitement, fresh-to-market energy
- Emphasize unique features and first-look exclusivity
- CTA: "Schedule a showing", "See it before it's gone", "DM for details"
- Urgency: Fresh-to-market, don't wait
- Every channel should convey the thrill of a brand-new listing`,

  open_house: `CAMPAIGN TYPE: OPEN HOUSE
- Tone: Event-focused, inviting, warm
- Include date/time if provided, emphasize attendance
- CTA: "Join us", "Mark your calendar", "RSVP", "Stop by"
- Urgency: Limited-time event, specific date/time
- Make the reader feel personally invited`,

  price_drop: `CAMPAIGN TYPE: PRICE DROP
- Tone: Value-driven, opportunity-focused
- Lead with the new price or savings amount
- CTA: "New price", "Now within reach", "Don't miss this value"
- Urgency: Price won't last, act-now energy
- Frame as an opportunity, not a sign of desperation`,

  just_sold: `CAMPAIGN TYPE: JUST SOLD
- Tone: Celebration, confidence, proof of results
- Highlight speed of sale, final price if appropriate
- CTA: "Thinking of selling?", "Ready to be next?", "Let's talk about your home"
- Urgency: None — this is trust-building, not time-pressure
- Position the agent as effective and reliable`,

  listing_spotlight: `CAMPAIGN TYPE: LISTING SPOTLIGHT
- Tone: Lifestyle/showcase, aspirational, storytelling
- Focus on the neighborhood, lifestyle, and emotional appeal
- CTA: "Imagine living here", "Discover this home", "Learn more"
- Urgency: Low — focus on aspiration and desire
- Paint a picture of life in this home and neighborhood`,
};

// industry-02 split: neutral baseline + RE additions. Lived
// inline in sites.generation.service.js until industry-03
// moved it here so future industries can extend the same way.
const REAL_ESTATE_FACTS_LLM_MAY_NOT_FABRICATE = [
  ...GENERIC_FACTS_LLM_MAY_NOT_FABRICATE,
  "market statistics (median price, days on market, inventory)",
  "school ratings, school districts, or school names",
  "walkability or transit scores",
  "specific neighborhood amenities (parks, restaurants, businesses) not in the provided data",
  "exact sale prices for sold listings unless they appear in the data",
  "financing terms, mortgage rates, or down-payment specifics",
];

export function getCampaignTypeInstructions(typeKey) {
  if (!typeKey) return null;
  const real = REAL_ESTATE_CAMPAIGN_TYPE_INSTRUCTIONS[typeKey];
  if (real) return real;
  // Fall through to generic for cross-industry types (awareness,
  // lead_generation, educational, etc.). RE workspaces use the
  // same neutral instructions for those.
  return getGenericCampaignTypeInstructions(typeKey);
}

export function getFactsLlmMayNotFabricate() {
  return REAL_ESTATE_FACTS_LLM_MAY_NOT_FABRICATE;
}
