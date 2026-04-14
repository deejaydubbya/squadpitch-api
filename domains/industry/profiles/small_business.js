export default {
  key: "small_business",
  label: "Small Business",
  description: "Local shops, service providers, and general small businesses.",
  onboarding: {
    websitePlaceholder: "mybusiness.com",
    extraContextLabel: "Business details",
    extraContextPlaceholder: "Describe what your business does, who you serve, and what sets you apart...",
    helperText: "We'll extract your products, services, and brand story.",
  },
  extraction: {
    hints: "Focus on products/services offered, owner/team bios, customer testimonials, location and hours, community involvement, unique selling points, and any promotions or events.",
    priorityDataTypes: ["CUSTOM", "TESTIMONIAL", "PROMOTION", "TEAM_SPOTLIGHT"],
  },
  content: {
    starterBlueprintSlugs: ["owner-story", "product-highlight", "community-post"],
    starterChannels: ["INSTAGRAM", "FACEBOOK", "LINKEDIN"],
    starterAngles: [
      "Tell the story behind your business — why you started and what keeps you going.",
      "Highlight a product or service that your customers love, with real details and benefits.",
      "Share a community moment — how your business gives back or connects with local events.",
    ],
  },
  integrations: {
    supportedCapabilities: ["review_feed", "pos"],
    recommendedProviders: ["square", "google_business"],
    starterAutomations: ["new_review_post", "weekly_business_update"],
  },
  ui: { icon: "Store" },
  techStack: [],
};
