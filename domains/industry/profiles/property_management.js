export default {
  key: "property_management",
  label: "Property Management / Rentals",
  description: "Residential and commercial property management companies and landlords.",
  onboarding: {
    websitePlaceholder: "sunsetproperties.com",
    extraContextLabel: "Portfolio or service details",
    extraContextPlaceholder: "Describe your property portfolio, services, or target tenants...",
    helperText: "We'll extract your property listings, services, and tenant resources.",
  },
  extraction: {
    hints: "Focus on available rental units (address, rent, bedrooms, amenities), property services, maintenance programs, tenant testimonials, and community features.",
    priorityDataTypes: ["CUSTOM", "TESTIMONIAL", "FAQ", "EVENT"],
  },
  content: {
    starterBlueprintSlugs: ["available-unit", "tenant-tip", "community-highlight"],
    starterChannels: ["FACEBOOK", "INSTAGRAM", "LINKEDIN"],
    starterAngles: [
      "Highlight an available rental unit — feature photos, amenities, and neighborhood perks.",
      "Share a helpful tenant tip about maintenance, move-in, or community living.",
      "Celebrate a community event or property improvement that shows you care about residents.",
    ],
  },
  integrations: {
    supportedCapabilities: ["listing_feed", "maintenance_requests"],
    recommendedProviders: ["appfolio", "buildium"],
    starterAutomations: ["new_listing_post", "seasonal_maintenance_reminder"],
  },
  ui: { icon: "Building2" },
};
