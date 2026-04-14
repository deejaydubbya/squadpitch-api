export default {
  key: "creator",
  label: "Creator & Brand",
  description: "Content creators, influencers, podcasters, and personal brands.",
  onboarding: {
    websitePlaceholder: "janedoe.co",
    extraContextLabel: "Content niche or brand details",
    extraContextPlaceholder: "Describe your niche, audience, or content style...",
    helperText: "We'll extract your brand identity, content themes, and audience insights.",
  },
  extraction: {
    hints: "Focus on content themes/niche, brand partnerships, audience demographics, signature content formats, bio/about info, merchandise or digital products, podcast/YouTube channel details, and collaboration history.",
    priorityDataTypes: ["CUSTOM", "MILESTONE", "PRODUCT_LAUNCH", "EVENT"],
  },
  content: {
    starterBlueprintSlugs: ["personal-story", "value-post", "community-engagement"],
    starterChannels: ["INSTAGRAM", "TIKTOK", "YOUTUBE"],
    starterAngles: [
      "Share a personal story or lesson learned that resonates with your audience's values.",
      "Create a high-value tip or insight post in your niche that followers will save and share.",
      "Post a community engagement prompt — ask a question or start a conversation your audience cares about.",
    ],
  },
  integrations: {
    supportedCapabilities: ["analytics", "link_in_bio"],
    recommendedProviders: ["linktree", "stan_store"],
    starterAutomations: ["weekly_content_recap", "new_video_announcement"],
  },
  ui: { icon: "Mic" },
};
