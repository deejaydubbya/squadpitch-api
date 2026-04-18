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
    channelRecommendations: {
      primary: ["FACEBOOK", "LINKEDIN"],
      secondary: ["INSTAGRAM"],
      optional: ["YOUTUBE", "TIKTOK", "X"],
    },
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
  recommendationTemplates: [
    { type: "policy_review_reminder", tier: "core", title: "Encourage Policy Reviews", description: "Prompt existing clients to review their coverage.", priority: "high", guidance: "Create a policy review reminder post. Explain why annual reviews matter, what life changes trigger a need to update, and offer a free review.", conditions: {} },
    { type: "seasonal_risk_alert", tier: "core", title: "Post a Seasonal Risk Alert", description: "Warn about seasonal risks and relevant coverage.", priority: "high", guidance: "Create a seasonal risk awareness post. Connect a current season or weather pattern to specific coverage needs and preparedness steps.", conditions: {} },
    { type: "coverage_tip", tier: "core", title: "Share a Coverage Tip", description: "Educate clients on an often-overlooked coverage type.", priority: "high", guidance: "Share a practical insurance tip about a coverage gap most people don't know about. Explain the risk and how to fix it simply.", conditions: {} },
    { type: "client_story", tier: "secondary", title: "Share a Client Story", description: "Illustrate value with a real claim or coverage story.", priority: "medium", guidance: "Tell a story about how the right insurance coverage saved a client. Make it relatable and real without revealing confidential details.", conditions: { hasData: true } },
    { type: "referral_incentive", tier: "secondary", title: "Promote Your Referral Program", description: "Encourage word-of-mouth with referral rewards.", priority: "medium", guidance: "Create a referral program promotion post. Explain the incentive, how to refer, and make it feel easy and rewarding.", conditions: {} },
    { type: "business_intro", tier: "secondary", title: "Introduce Your Agency", description: "Tell clients who you are and what you cover.", priority: "medium", guidance: "Write an introduction post for this insurance agency. Highlight coverage types, years of experience, and what sets them apart from big carriers.", conditions: { noPublished: true } },
    { type: "claims_process_explainer", tier: "advanced", title: "Explain the Claims Process", description: "Demystify claims to build client confidence.", priority: "low", guidance: "Create a post that walks through the claims process step by step. Make it reassuring and simple so clients feel prepared.", conditions: {} },
  ],
  ui: { icon: "Shield" },
  techStack: [],
};
