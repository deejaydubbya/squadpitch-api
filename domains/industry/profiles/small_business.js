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
  recommendationTemplates: [
    { type: "business_intro", tier: "core", title: "Introduce Your Business", description: "Tell your audience who you are and what you offer.", priority: "high", guidance: "Write an introduction post for this business. Highlight key products or services, the team, and what makes them the right choice.", conditions: { noPublished: true } },
    { type: "special_offer", tier: "core", title: "Promote a Special Offer", description: "Drive sales with a limited-time deal.", priority: "high", guidance: "Create a special offer or promotion post. Include what's on sale, the discount, deadline, and a compelling call-to-action.", conditions: {} },
    { type: "customer_testimonial", tier: "core", title: "Share a Customer Testimonial", description: "Build trust with a real client review.", priority: "high", guidance: "Feature a customer testimonial or review. Share their experience, what they purchased or used, and the outcome. Make it relatable.", conditions: { hasData: true } },
    { type: "product_spotlight", tier: "secondary", title: "Spotlight a Product or Service", description: "Deep-dive on a specific offering.", priority: "medium", guidance: "Create a product or service spotlight. Explain what it is, who needs it, key benefits, and why customers love it.", conditions: { hasData: true } },
    { type: "behind_the_scenes", tier: "secondary", title: "Share Behind the Scenes", description: "Humanize your brand with a look at the team or process.", priority: "medium", guidance: "Create a behind-the-scenes post. Show the team, the workspace, or how products are made. Make it personal and authentic.", conditions: {} },
    { type: "milestone_post", tier: "secondary", title: "Celebrate a Milestone", description: "Share a business achievement or anniversary.", priority: "medium", guidance: "Create a milestone celebration post. Share an anniversary, achievement, or growth moment. Thank customers and reflect on the journey.", conditions: {} },
    { type: "local_partnership", tier: "advanced", title: "Highlight a Local Partnership", description: "Showcase community connections and collaborations.", priority: "low", guidance: "Create a post highlighting a local partnership or community involvement. Show how your business connects with and supports the local area.", conditions: {} },
  ],
  ui: { icon: "Store" },
  techStack: [],
};
