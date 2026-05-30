// industry-03 — generic site/page templates.
//
// Used when an industry doesn't supply its own template list.
// Block sequences are deliberately conservative — they work for
// any vertical (service business, e-commerce, content site,
// consulting, etc.). The page-gen prompt biases toward these
// when no template is selected explicitly.

export const GENERIC_SITE_TEMPLATES = [
  {
    key: "landing_page",
    label: "Landing page",
    intent: "Convert visitors into inquiries or sign-ups",
    blocks: ["hero", "paragraph", "key_details", "cta", "lead_form"],
  },
  {
    key: "lead_capture",
    label: "Lead capture",
    intent: "Collect contact info in exchange for a clear next step",
    blocks: ["hero", "paragraph", "lead_form", "testimonial"],
  },
  {
    key: "announcement",
    label: "Announcement",
    intent: "Share news, an event, or a launch",
    blocks: ["hero", "paragraph", "image", "cta"],
  },
  {
    key: "services_overview",
    label: "Services overview",
    intent: "Explain what you offer and how to engage",
    blocks: ["hero", "paragraph", "key_details", "testimonial", "cta", "lead_form"],
  },
];
