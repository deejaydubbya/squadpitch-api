export default {
  key: "mortgage",
  label: "Mortgage & Loans",
  description: "Mortgage brokers, loan officers, and lending institutions.",
  onboarding: {
    websitePlaceholder: "primemortgage.com",
    extraContextLabel: "Loan programs or specialties",
    extraContextPlaceholder: "Describe your loan programs, service areas, or licensing details...",
    helperText: "We'll extract your loan products, rates, and client testimonials.",
  },
  extraction: {
    hints: "Focus on loan programs (conventional, FHA, VA, jumbo), current rates, team bios, client testimonials, educational content about the home-buying process, and compliance/licensing info.",
    priorityDataTypes: ["CUSTOM", "TESTIMONIAL", "STATISTIC", "FAQ"],
  },
  content: {
    starterBlueprintSlugs: ["rate-update", "homebuyer-tip", "closing-celebration"],
    starterChannels: ["LINKEDIN", "FACEBOOK", "INSTAGRAM"],
    starterAngles: [
      "Share a rate update or market trend that helps buyers understand today's mortgage landscape.",
      "Post a first-time homebuyer tip — break down a confusing part of the loan process simply.",
      "Celebrate a client closing — share the milestone (with permission) to build social proof.",
    ],
  },
  integrations: {
    supportedCapabilities: ["rate_feed", "crm"],
    recommendedProviders: ["encompass", "mortgage_coach"],
    starterAutomations: ["rate_change_post", "weekly_market_update"],
  },
  ui: { icon: "Landmark" },
};
