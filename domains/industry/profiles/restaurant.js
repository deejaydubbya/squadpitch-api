export default {
  key: "restaurant",
  label: "Restaurant & Food",
  description: "Restaurants, cafes, food trucks, catering, and food & beverage brands.",
  onboarding: {
    websitePlaceholder: "bellavistabistro.com",
    extraContextLabel: "Menu or concept details",
    extraContextPlaceholder: "Describe your cuisine, signature dishes, or dining concept...",
    helperText: "We'll extract your menu, reviews, and dining experience details.",
  },
  extraction: {
    hints: "Focus on menu items (dishes, drinks, prices), chef/owner bios, customer reviews, dining ambiance, special events (happy hour, brunch, live music), catering options, and location/hours info.",
    priorityDataTypes: ["CUSTOM", "TESTIMONIAL", "EVENT", "PROMOTION"],
  },
  content: {
    starterBlueprintSlugs: ["dish-spotlight", "behind-the-kitchen", "event-promo"],
    starterChannels: ["INSTAGRAM", "TIKTOK", "FACEBOOK"],
    starterAngles: [
      "Spotlight a signature dish — describe the flavors, ingredients, and what makes it a must-try.",
      "Take followers behind the kitchen — show prep, plating, or a day in the life of the team.",
      "Promote an upcoming event, special, or seasonal menu addition with mouth-watering details.",
    ],
  },
  integrations: {
    supportedCapabilities: ["menu_feed", "reservation_system"],
    recommendedProviders: ["toast", "opentable"],
    starterAutomations: ["daily_special_post", "event_announcement"],
  },
  ui: { icon: "UtensilsCrossed" },
  techStack: [],
};
