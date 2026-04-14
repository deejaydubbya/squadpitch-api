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
  recommendationTemplates: [
    { type: "rate_update", tier: "core", title: "Share a Rate Update", description: "Position yourself as the go-to source for current rates.", priority: "high", guidance: "Create a mortgage rate update post. Share current rate trends, what they mean for buyers, and why now is a good time to act.", conditions: {} },
    { type: "refinance_opportunity", tier: "core", title: "Promote Refinancing", description: "Reach homeowners who could benefit from refinancing.", priority: "high", guidance: "Create a refinancing promotion post. Explain potential savings, when refinancing makes sense, and include a clear call-to-action.", conditions: {} },
    { type: "preapproval_cta", tier: "core", title: "Encourage Pre-Approval", description: "Drive leads to start their pre-approval process.", priority: "high", guidance: "Create a pre-approval call-to-action post. Explain why pre-approval matters, how easy the process is, and what buyers need to get started.", conditions: {} },
    { type: "homebuyer_tip", tier: "secondary", title: "Share a Homebuyer Tip", description: "Educate first-time buyers on the mortgage process.", priority: "medium", guidance: "Post a practical homebuyer tip. Break down a confusing part of the loan process in simple terms that first-time buyers can understand.", conditions: {} },
    { type: "program_spotlight", tier: "secondary", title: "Spotlight a Loan Program", description: "Highlight FHA, VA, USDA, or other specific programs.", priority: "medium", guidance: "Create a loan program spotlight. Explain who qualifies, key benefits, down payment requirements, and why it might be the right fit.", conditions: {} },
    { type: "client_closing", tier: "secondary", title: "Celebrate a Client Closing", description: "Share a success story of a funded loan.", priority: "medium", guidance: "Create a client closing celebration post. Share the milestone, congratulate the homeowner, and show the human side of the process.", conditions: { hasData: true } },
    { type: "business_intro", tier: "advanced", title: "Introduce Your Services", description: "Tell homebuyers who you are and how you can help.", priority: "low", guidance: "Write an introduction post for this mortgage professional. Highlight experience, loan programs offered, service areas, and what sets them apart.", conditions: { noPublished: true } },
  ],
  ui: { icon: "Landmark" },
  techStack: [],
};
