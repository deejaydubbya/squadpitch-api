export default {
  key: "insurance",
  label: "Insurance Agent",
  description: "Insurance agents, brokers, and agencies across all lines of coverage.",
  onboarding: {
    websitePlaceholder: "shieldinsurance.com",
    extraContextLabel: "Coverage types or specialties",
    extraContextPlaceholder: "Describe the types of insurance you offer and your target clients...",
    helperText: "We'll extract your coverage options, team info, and client stories.",
  },
  extraction: {
    hints: "Focus on insurance products (auto, home, life, commercial, health), agent bios, client testimonials, educational content about coverage, claims process info, and community involvement.",
    priorityDataTypes: ["CUSTOM", "TESTIMONIAL", "FAQ", "TEAM_SPOTLIGHT"],
  },
  content: {
    starterBlueprintSlugs: ["coverage-tip", "claims-story", "seasonal-reminder"],
    starterChannels: ["FACEBOOK", "LINKEDIN", "INSTAGRAM"],
    starterAngles: [
      "Share a practical insurance tip that helps people understand a coverage gap they might have.",
      "Tell a story about how the right coverage saved a client — make it relatable and real.",
      "Post a seasonal safety or preparedness reminder tied to weather, holidays, or life events.",
    ],
  },
  integrations: {
    supportedCapabilities: ["quote_engine", "crm"],
    recommendedProviders: ["applied_epic", "hawksoft"],
    starterAutomations: ["seasonal_coverage_reminder", "policy_renewal_tip"],
  },
  ui: { icon: "Shield" },
  techStack: [],
};
