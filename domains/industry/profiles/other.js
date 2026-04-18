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
    channelRecommendations: {
      primary: ["INSTAGRAM", "FACEBOOK"],
      secondary: ["LINKEDIN", "TIKTOK"],
      optional: ["X", "THREADS", "YOUTUBE"],
    },
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
  recommendationTemplates: [
    { type: "business_intro", tier: "core", title: "Introduce Your Business", description: "Tell your audience who you are and what you offer.", priority: "high", guidance: "Write an introduction post for this business. Highlight key services, the team, mission, and what makes them stand out.", conditions: { noPublished: true } },
    { type: "promotion_post", tier: "core", title: "Promote an Offer", description: "Drive action with a timely promotion or event.", priority: "high", guidance: "Create a promotional post for a current offer, sale, or upcoming event. Include a clear call-to-action and urgency.", conditions: {} },
    { type: "customer_story", tier: "core", title: "Share a Customer Story", description: "Build trust with a real success story.", priority: "high", guidance: "Share a customer success story or testimonial. Include specific details about the experience and outcome to build credibility.", conditions: { hasData: true } },
    { type: "expertise_post", tier: "secondary", title: "Share Your Expertise", description: "Demonstrate knowledge with an insight or tip.", priority: "medium", guidance: "Create a post sharing a useful tip, insight, or industry knowledge that positions this business as an expert in their field.", conditions: {} },
    { type: "behind_the_scenes", tier: "secondary", title: "Share Behind the Scenes", description: "Humanize your brand with a team or process look.", priority: "medium", guidance: "Create a behind-the-scenes post showing the team, the process, or day-to-day operations. Make it personal and relatable.", conditions: {} },
  ],
  ui: { icon: "Briefcase" },
  techStack: [],
};
