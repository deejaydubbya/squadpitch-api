// industry-03 — real estate site/page templates.
//
// Mirrors what currently lives inline in
// sites.generation.service.js's SITE_TEMPLATES map. Templates are
// referenced by `key` from the page-gen prompt + the FE template
// picker.

export const REAL_ESTATE_SITE_TEMPLATES = [
  {
    key: "property_listing",
    label: "Property listing",
    intent: "Showcase a single listing with photos + details + CTA",
    blocks: ["hero", "gallery", "key_details", "paragraph", "cta", "lead_form"],
  },
  {
    key: "open_house",
    label: "Open house",
    intent: "Drive RSVPs for an upcoming open house",
    blocks: ["hero", "key_details", "paragraph", "cta", "lead_form"],
  },
  {
    key: "just_sold",
    label: "Just sold",
    intent: "Celebrate a recently-closed deal as proof / lead magnet",
    blocks: ["hero", "paragraph", "testimonial", "cta", "lead_form"],
  },
  {
    key: "seller_lead",
    label: "Seller lead capture",
    intent: "Convert visitors thinking about selling into inquiries",
    blocks: ["hero", "paragraph", "lead_form", "testimonial"],
  },
  {
    key: "buyer_lead",
    label: "Buyer lead capture",
    intent: "Convert visitors looking to buy into inquiries",
    blocks: ["hero", "paragraph", "lead_form", "testimonial"],
  },
  {
    key: "neighborhood_guide",
    label: "Neighborhood guide",
    intent: "Position the agent as a local expert; capture buyer leads",
    blocks: ["hero", "paragraph", "key_details", "lead_form"],
  },
];
