export default {
  key: "real_estate",
  label: "Real Estate",
  description: "Residential and commercial real estate agents, brokers, and teams.",
  onboarding: {
    websitePlaceholder: "smithrealty.com",
    extraContextLabel: "Property or market details",
    extraContextPlaceholder: "Describe your market area, specialties, or paste listing details...",
    helperText: "We'll extract your listings, testimonials, and market expertise.",
  },
  extraction: {
    hints: "Focus on property listings (address, price, bedrooms, sqft), agent bios, testimonials, market stats, neighborhoods, and open house events.",
    priorityDataTypes: ["CUSTOM", "TESTIMONIAL", "STATISTIC", "EVENT"],
  },
  content: {
    starterBlueprintSlugs: ["just-listed", "market-update", "client-success-story"],
    starterChannels: ["INSTAGRAM", "FACEBOOK", "LINKEDIN"],
    starterAngles: [
      "Create a 'just listed' post highlighting a property's best features. Use specific details.",
      "Write a local market insight post sharing a surprising housing stat or trend.",
      "Share a client success story — how the agent helped a buyer or seller achieve their goal.",
    ],
  },
  integrations: {
    supportedCapabilities: ["listing_feed", "crm"],
    recommendedProviders: ["mls_idx", "follow_up_boss"],
    starterAutomations: ["new_listing_post", "open_house_post"],
  },
  ui: { icon: "Home" },
};
