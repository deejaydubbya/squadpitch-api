export default {
  key: "legal",
  label: "Legal Services",
  description: "Law firms, solo practitioners, and legal service providers.",
  onboarding: {
    websitePlaceholder: "smithlawfirm.com",
    extraContextLabel: "Practice areas or specialties",
    extraContextPlaceholder: "Describe your practice areas, notable cases, or target clients...",
    helperText: "We'll extract your practice areas, attorney profiles, and case results.",
  },
  extraction: {
    hints: "Focus on practice areas (family law, personal injury, business law, etc.), attorney bios and credentials, case results, client testimonials, legal FAQs, and community involvement.",
    priorityDataTypes: ["CUSTOM", "TESTIMONIAL", "FAQ", "TEAM_SPOTLIGHT"],
  },
  content: {
    starterBlueprintSlugs: ["legal-tip", "case-result", "attorney-spotlight"],
    starterChannels: ["LINKEDIN", "FACEBOOK", "INSTAGRAM"],
    starterAngles: [
      "Share a practical legal tip that educates your audience about their rights or common mistakes.",
      "Highlight a case result or settlement that demonstrates your firm's expertise (no confidential details).",
      "Spotlight an attorney on your team — share their background, passion, and what drives them.",
    ],
  },
  integrations: {
    supportedCapabilities: ["case_management", "crm"],
    recommendedProviders: ["clio", "lawmatics"],
    starterAutomations: ["weekly_legal_tip", "new_blog_post_share"],
  },
  ui: { icon: "Scale" },
  techStack: [],
};
