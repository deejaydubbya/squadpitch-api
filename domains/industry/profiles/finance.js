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
  recommendationTemplates: [
    { type: "market_commentary", tier: "core", title: "Share Market Commentary", description: "Provide insight on current market conditions.", priority: "high", guidance: "Create a market commentary post. Share a timely insight about stock market, interest rates, or economic conditions and what it means for clients.", conditions: {} },
    { type: "tax_planning_tip", tier: "core", title: "Share a Tax Planning Tip", description: "Provide timely advice during tax season or year-end.", priority: "high", guidance: "Share a tax planning tip that helps clients save money or prepare for tax season. Be specific and actionable.", conditions: {} },
    { type: "financial_tip", tier: "core", title: "Share a Financial Tip", description: "Educate on saving, investing, or retirement planning.", priority: "high", guidance: "Post a practical financial tip that anyone can use. Cover budgeting, saving, investing basics, or tax strategy in plain language.", conditions: {} },
    { type: "client_milestone", tier: "secondary", title: "Celebrate a Client Milestone", description: "Share a client success story or financial achievement.", priority: "medium", guidance: "Create a post celebrating a client milestone — retirement, debt freedom, or a major financial goal achieved. Keep details anonymous if needed.", conditions: { hasData: true } },
    { type: "retirement_planning", tier: "secondary", title: "Discuss Retirement Planning", description: "Help clients think about long-term financial goals.", priority: "medium", guidance: "Create a retirement planning post. Discuss a specific aspect like catch-up contributions, Social Security timing, or required minimum distributions.", conditions: {} },
    { type: "economic_update", tier: "secondary", title: "Post an Economic Update", description: "Break down how economic news affects personal finances.", priority: "medium", guidance: "Create an economic update post. Take a recent headline — jobs report, Fed decision, inflation data — and explain what it means for everyday people.", conditions: {} },
    { type: "business_intro", tier: "advanced", title: "Introduce Your Services", description: "Explain what you do and who you serve.", priority: "low", guidance: "Write an introduction post for this financial advisory practice. Highlight services, credentials, client focus, and what sets them apart.", conditions: { noPublished: true } },
  ],
  ui: { icon: "TrendingUp" },
  techStack: [],
};
