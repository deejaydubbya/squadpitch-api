export default {
  key: "finance",
  label: "Financial Advisor",
  description: "Financial advisors, accountants, wealth managers, and fintech companies.",
  onboarding: {
    websitePlaceholder: "brightfinancial.com",
    extraContextLabel: "Services or specialties",
    extraContextPlaceholder: "Describe your financial services, certifications, or client focus...",
    helperText: "We'll extract your services, team credentials, and client success stories.",
  },
  extraction: {
    hints: "Focus on financial services (retirement planning, tax prep, wealth management), advisor bios and certifications (CFP, CPA), client testimonials, educational content, market commentary, and compliance disclosures.",
    priorityDataTypes: ["CUSTOM", "TESTIMONIAL", "STATISTIC", "TEAM_SPOTLIGHT"],
  },
  content: {
    starterBlueprintSlugs: ["market-insight", "financial-tip", "client-milestone"],
    starterChannels: ["LINKEDIN", "FACEBOOK", "INSTAGRAM"],
    starterAngles: [
      "Share a timely market insight or economic trend that affects your clients' financial plans.",
      "Post a practical money tip — budgeting, saving, or tax strategy that anyone can use.",
      "Celebrate a client milestone — retirement, debt freedom, or financial goal achieved (with permission).",
    ],
  },
  integrations: {
    supportedCapabilities: ["portfolio_data", "crm"],
    recommendedProviders: ["wealthbox", "redtail"],
    starterAutomations: ["market_commentary_post", "tax_season_tip"],
  },
  ui: { icon: "TrendingUp" },
};
