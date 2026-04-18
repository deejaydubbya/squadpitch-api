export default {
  key: "property_management",
  label: "Property Management",
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
    channelRecommendations: {
      primary: ["FACEBOOK", "LINKEDIN"],
      secondary: ["INSTAGRAM", "YOUTUBE"],
      optional: ["X", "REDDIT"],
    },
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
  recommendationTemplates: [
    { type: "available_unit", tier: "core", title: "List an Available Unit", description: "Promote a vacant rental with key details and photos.", priority: "high", guidance: "Create a post promoting an available rental unit. Include address, rent, bedrooms, bathrooms, amenities, and a compelling reason to apply.", conditions: { hasData: true } },
    { type: "leasing_special", tier: "core", title: "Promote a Leasing Special", description: "Drive applications with a move-in deal or incentive.", priority: "high", guidance: "Create a leasing special promotion post. Highlight the deal, eligible units, and urgency to apply before the offer expires.", conditions: {} },
    { type: "tenant_testimonial", tier: "core", title: "Share a Tenant Review", description: "Build trust with a real tenant experience.", priority: "high", guidance: "Share a tenant testimonial or review. Highlight what they love about the property, community, or management team.", conditions: { hasData: true } },
    { type: "property_upgrade", tier: "secondary", title: "Showcase a Property Upgrade", description: "Highlight renovations or improvements to your properties.", priority: "medium", guidance: "Create a post showcasing a recent property renovation or improvement. Show before/after if possible and explain the benefit to residents.", conditions: {} },
    { type: "neighborhood_guide", tier: "secondary", title: "Highlight the Neighborhood", description: "Showcase local amenities near your properties.", priority: "medium", guidance: "Create a neighborhood guide post. Feature local restaurants, parks, schools, transit, and what makes the area great for renters.", conditions: {} },
    { type: "community_event", tier: "secondary", title: "Announce a Community Event", description: "Promote events for residents or prospective tenants.", priority: "medium", guidance: "Create a community event announcement. Include date, time, location, and what attendees can expect. Make it inviting.", conditions: {} },
    { type: "maintenance_tip", tier: "advanced", title: "Share a Maintenance Tip", description: "Provide helpful home care advice for tenants.", priority: "low", guidance: "Share a practical maintenance or home care tip for renters. Keep it seasonal and actionable — something they can do today.", conditions: {} },
  ],
  ui: { icon: "Building2" },
  techStack: [],
};
