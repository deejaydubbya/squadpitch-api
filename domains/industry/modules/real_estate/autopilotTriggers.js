// industry-03 — real estate autopilot trigger types.
//
// Mirrors the values currently in the AutopilotTriggerType enum
// in prisma/schema.prisma. All 9 values are real-estate-specific
// (NEW_LISTING / PRICE_DROP / OPEN_HOUSE / JUST_SOLD /
// STALE_LISTING / NEW_REVIEW / MARKET_UPDATE / SEASONAL /
// INACTIVITY_GAP). The autopilot service uses
// industry-01's assertRealEstateWorkspace gate to refuse non-RE
// workspaces; later prompts (industry-07) may collapse these into
// per-industry trigger registries.

export const REAL_ESTATE_AUTOPILOT_TRIGGER_TYPES = [
  "NEW_LISTING",
  "PRICE_DROP",
  "OPEN_HOUSE",
  "JUST_SOLD",
  "STALE_LISTING",
  "NEW_REVIEW",
  "MARKET_UPDATE",
  "SEASONAL",
  "INACTIVITY_GAP",
];
