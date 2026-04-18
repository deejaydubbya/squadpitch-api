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
    channelRecommendations: {
      primary: ["TIKTOK", "INSTAGRAM", "YOUTUBE"],
      secondary: ["X", "THREADS"],
      optional: ["REDDIT", "PINTEREST"],
    },
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
  recommendationTemplates: [
    { type: "content_preview", tier: "core", title: "Preview Upcoming Content", description: "Tease what's coming next to build anticipation.", priority: "high", guidance: "Create a content preview or teaser post. Build anticipation for upcoming content — hint at the topic, share a snippet, and tell followers when to expect it.", conditions: {} },
    { type: "product_launch", tier: "core", title: "Promote Your Product", description: "Drive sales for merch, courses, or offerings.", priority: "high", guidance: "Create a product promotion post. Feature your merch, course, ebook, or other offering. Highlight the value, price, and where to buy.", conditions: { hasData: true } },
    { type: "tip_or_tutorial", tier: "core", title: "Share a Tip or Tutorial", description: "Teach something valuable to your audience.", priority: "high", guidance: "Create a tip or tutorial post in your niche. Make it actionable, specific, and something followers will want to save and share.", conditions: {} },
    { type: "personal_story", tier: "secondary", title: "Share a Personal Story", description: "Connect with your audience through a real moment.", priority: "medium", guidance: "Share a personal story or lesson learned. Be authentic and vulnerable — connect with your audience on a human level.", conditions: {} },
    { type: "collaboration_announcement", tier: "secondary", title: "Announce a Collaboration", description: "Promote a partnership or guest feature.", priority: "medium", guidance: "Announce a collaboration or partnership. Explain who you're working with, what you're creating together, and why your audience should care.", conditions: {} },
    { type: "audience_question", tier: "secondary", title: "Ask Your Audience", description: "Engage followers with a poll or question.", priority: "medium", guidance: "Create an audience engagement post. Ask a question, start a debate, or run a poll that your followers will want to respond to.", conditions: {} },
    { type: "milestone_celebration", tier: "advanced", title: "Celebrate a Milestone", description: "Share an achievement with your community.", priority: "low", guidance: "Create a milestone celebration post. Share a follower count, launch, or personal achievement. Thank your community and reflect on the journey.", conditions: {} },
  ],
  ui: { icon: "Mic" },
  techStack: [],
};
