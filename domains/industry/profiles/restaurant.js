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
  recommendationTemplates: [
    { type: "daily_special", tier: "core", title: "Promote Today's Special", description: "Highlight a daily special or chef's pick.", priority: "high", guidance: "Create a daily special post. Feature the dish or drink, describe the flavors, and create urgency — available today only.", conditions: {} },
    { type: "new_menu_item", tier: "core", title: "Announce a New Menu Item", description: "Build excitement for a new dish or drink.", priority: "high", guidance: "Announce a new menu item. Describe the dish, what inspired it, key ingredients, and why customers should try it on their next visit.", conditions: { hasData: true } },
    { type: "customer_favorite", tier: "core", title: "Feature a Customer Favorite", description: "Showcase a popular dish with real reviews.", priority: "high", guidance: "Create a post featuring a customer favorite dish. Include what makes it popular, a customer quote if available, and an appetizing description.", conditions: { hasData: true } },
    { type: "behind_the_kitchen", tier: "secondary", title: "Share Behind the Kitchen", description: "Show prep, cooking, or the team at work.", priority: "medium", guidance: "Create a behind-the-scenes kitchen post. Show food prep, plating, or the team in action. Make it authentic and personal.", conditions: {} },
    { type: "event_announcement", tier: "secondary", title: "Announce an Event", description: "Promote live music, happy hours, or special nights.", priority: "medium", guidance: "Create an event announcement post. Include the event type, date, time, and what guests can expect. Build excitement and drive reservations.", conditions: {} },
    { type: "seasonal_menu", tier: "secondary", title: "Promote a Seasonal Menu", description: "Highlight seasonal or limited-time offerings.", priority: "medium", guidance: "Create a seasonal menu promotion post. Feature 2-3 seasonal dishes or drinks, describe the flavors, and emphasize they're available for a limited time.", conditions: {} },
    { type: "catering_promo", tier: "advanced", title: "Promote Catering Services", description: "Drive catering inquiries for events and groups.", priority: "low", guidance: "Create a catering services promotion post. Highlight menu options, event types served, pricing info if available, and how to book.", conditions: {} },
  ],
  ui: { icon: "UtensilsCrossed" },
  techStack: [],
};
