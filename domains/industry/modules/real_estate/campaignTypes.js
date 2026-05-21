// industry-03 — real estate campaign type options.
//
// Mirrors the web realEstateAdapter.campaignTypes list. The web
// adapter is the authoritative source for the UI chip ordering;
// this list exists so future API surfaces (e.g. a "list available
// campaign types for industry" endpoint) don't have to import
// front-end code.

export const REAL_ESTATE_CAMPAIGN_TYPES = [
  {
    value: "just_listed",
    label: "Just Listed",
    description: "Announce a fresh-to-market listing.",
  },
  {
    value: "open_house",
    label: "Open House",
    description: "Promote an upcoming open house event.",
  },
  {
    value: "price_drop",
    label: "Price Drop",
    description: "Highlight a price reduction.",
  },
  {
    value: "just_sold",
    label: "Just Sold",
    description: "Celebrate a recently-closed deal as social proof.",
  },
  {
    value: "listing_spotlight",
    label: "Listing Spotlight",
    description: "Aspirational deep-dive on a listing's lifestyle appeal.",
  },
];
