// industry-03 — generic prompt config.
//
// Used when industryKey is null, unknown, or a registered industry
// that doesn't override these surfaces. Every entry is
// deliberately industry-agnostic — no real-estate / e-commerce /
// restaurant assumptions.

// Cross-industry campaign type instructions. Pre-industry-03 these
// lived alongside the real-estate entries in promptBuilder.js's
// CAMPAIGN_TYPE_INSTRUCTIONS map. Now the generic module owns the
// neutral set; the real_estate module ships its own additions
// (just_listed, open_house, etc.).
export const GENERIC_CAMPAIGN_TYPE_INSTRUCTIONS = {
  awareness: `CAMPAIGN TYPE: AWARENESS
- Tone: Inviting, top-of-funnel, conversational
- Goal: Make new people aware of the brand, topic, or offer
- CTA: "Follow for more", "Save for later", "Send this to someone who needs it"
- Urgency: Low — focus on intrigue, not pressure
- Lead with a clear hook that explains why this matters`,

  lead_generation: `CAMPAIGN TYPE: LEAD GENERATION
- Tone: Direct, helpful, confidence-inspiring
- Goal: Convert viewers into inquiries, sign-ups, or DM conversations
- CTA: "DM me to get started", "Link in bio", "Comment 'YES' for details"
- Urgency: Medium — make the next step easy and obvious
- Every post needs an unmistakable call-to-action`,

  educational: `CAMPAIGN TYPE: EDUCATIONAL
- Tone: Authoritative but accessible, generous, teacher-like
- Goal: Teach the audience something useful over a sequence
- CTA: "Save this", "Follow for more tips", "Send this to a friend"
- Urgency: None — value-first, no hard sell
- Each post should leave the viewer smarter than they started`,

  promotion_offer: `CAMPAIGN TYPE: PROMOTION / OFFER
- Tone: Value-driven, energetic, time-aware
- Goal: Highlight a deal, discount, or limited-time offer
- CTA: "Claim yours", "Use code at checkout", "Tap link to redeem"
- Urgency: High — make the deadline / scarcity explicit
- Lead with the offer; don't bury it`,

  social_proof: `CAMPAIGN TYPE: TESTIMONIAL / SOCIAL PROOF
- Tone: Genuine, story-led, trust-building
- Goal: Spotlight reviews, client results, or case studies
- CTA: "Be next", "Read the full story", "Book a chat"
- Urgency: Low — focus on credibility, not pressure
- Quote the customer directly when possible; never invent quotes`,

  event_announcement: `CAMPAIGN TYPE: EVENT / ANNOUNCEMENT
- Tone: Excited, inviting, attendance-focused
- Goal: Promote an upcoming event or news moment
- CTA: "RSVP now", "Mark your calendar", "Join us", "Spread the word"
- Urgency: Medium-high — make the date/time unmistakable
- Repeat key event details (date/time/where) across posts`,
};

// industry-02 split lived inline in sites.generation.service.js;
// industry-03 moves it into the module so future industries can
// add their own no-fabrication rules without touching core.
export const GENERIC_FACTS_LLM_MAY_NOT_FABRICATE = [
  "prices, fees, or financial terms not present in the supplied data",
  "specific addresses, locations, or distances not in the data",
  "named third parties (businesses, people, awards, certifications) not in the data",
  "statistics, ratings, or numerical claims not in the data",
];

export function getCampaignTypeInstructions(typeKey) {
  if (!typeKey) return null;
  return GENERIC_CAMPAIGN_TYPE_INSTRUCTIONS[typeKey] ?? null;
}

export function getFactsLlmMayNotFabricate() {
  return GENERIC_FACTS_LLM_MAY_NOT_FABRICATE;
}
