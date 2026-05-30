// industry-03 — generic campaign type options.
//
// Used by the assistant's chip picker for no-industry workspaces
// and as the fallback for industries that haven't extracted their
// own campaign-type list. Mirrors the web-side
// GENERIC_CAMPAIGN_TYPE_OPTIONS in lib/assistant/defaults.ts so
// the two stay in sync; if you change one, change the other.

export const GENERIC_CAMPAIGN_TYPES = [
  {
    value: "awareness",
    label: "Awareness",
    description: "Get in front of new audiences and introduce your brand.",
  },
  {
    value: "lead_generation",
    label: "Lead Generation",
    description: "Drive inquiries, sign-ups, or DM conversations.",
  },
  {
    value: "educational",
    label: "Educational",
    description: "Teach your audience something useful over a sequence.",
  },
  {
    value: "promotion_offer",
    label: "Promotion / Offer",
    description: "Highlight a deal, discount, or limited-time offer.",
  },
  {
    value: "social_proof",
    label: "Testimonial / Social Proof",
    description: "Spotlight reviews, client results, or case studies.",
  },
  {
    value: "event_announcement",
    label: "Event / Announcement",
    description: "Promote an upcoming event or news moment.",
  },
];
