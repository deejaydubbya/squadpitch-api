// Events / Entertainment profile.
//
// spinstr421 introduced this niche to the onboarding selector,
// gated as "coming soon" until we ship industry-specific
// adapters. Covers event planners, entertainers, DJs, venues,
// promoters — most of these benefit from short-form video
// content first.

export default {
  key: "events_entertainment",
  label: "Events / Entertainment",
  description: "Event planners, venues, entertainers, DJs, promoters, and the events industry.",
  status: "coming_soon",
  onboarding: {
    websitePlaceholder: "yourevents.com",
    extraContextLabel: "Event or service details",
    extraContextPlaceholder: "Describe the kinds of events you produce or perform at...",
    helperText: "We'll spotlight your upcoming events and past highlights.",
  },
  extraction: {
    hints: "Extract upcoming events, past event highlights, venue info, performer bios, ticketing info, and client testimonials.",
    priorityDataTypes: ["EVENT", "CUSTOM", "TESTIMONIAL"],
  },
  content: {
    starterBlueprintSlugs: ["brand-story", "value-post", "social-proof"],
    starterChannels: ["INSTAGRAM", "TIKTOK", "FACEBOOK"],
    channelRecommendations: {
      primary: ["INSTAGRAM", "TIKTOK", "FACEBOOK"],
      secondary: ["YOUTUBE", "THREADS"],
      optional: ["LINKEDIN", "X"],
    },
    starterAngles: [
      "Promote an upcoming event — date, location, what attendees can expect.",
      "Share highlights from a recent event with photos or short video.",
      "Behind-the-scenes look at event prep or the team putting it together.",
    ],
  },
  integrations: {
    supportedCapabilities: [],
    recommendedProviders: [],
    starterAutomations: [],
  },
  recommendationTemplates: [],
  ui: { icon: "PartyPopper" },
  techStack: [],
};
