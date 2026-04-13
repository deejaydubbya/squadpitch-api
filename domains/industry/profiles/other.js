export default {
  key: "other",
  label: "Something Else",
  description: "Any industry not listed above — we'll adapt to your business.",
  onboarding: {
    websitePlaceholder: "yourwebsite.com",
    extraContextLabel: "Business details",
    extraContextPlaceholder: "Describe what your business does, who you serve, and what sets you apart...",
    helperText: "We'll analyze your content and build a custom strategy.",
  },
  extraction: {
    hints: "Extract all available business information including products, services, team members, testimonials, FAQs, events, and any structured data that could be used for social media content.",
    priorityDataTypes: ["CUSTOM", "TESTIMONIAL", "FAQ", "TEAM_SPOTLIGHT"],
  },
  content: {
    starterBlueprintSlugs: ["brand-story", "value-post", "social-proof"],
    starterChannels: ["INSTAGRAM", "LINKEDIN", "FACEBOOK"],
    starterAngles: [
      "Share your brand's origin story — what inspired you to start and what drives your mission.",
      "Create an educational post that positions you as an expert in your field.",
      "Feature a customer testimonial or success story that builds trust and credibility.",
    ],
  },
  integrations: {
    supportedCapabilities: [],
    recommendedProviders: [],
    starterAutomations: [],
  },
  ui: { icon: "Briefcase" },
};
