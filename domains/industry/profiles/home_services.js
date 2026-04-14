export default {
  key: "home_services",
  label: "Home Services",
  description: "Contractors, plumbers, electricians, HVAC, landscapers, and home improvement pros.",
  onboarding: {
    websitePlaceholder: "acmeplumbing.com",
    extraContextLabel: "Services or project details",
    extraContextPlaceholder: "Describe your services, service area, or paste project examples...",
    helperText: "We'll extract your services, project photos, and customer reviews.",
  },
  extraction: {
    hints: "Focus on services offered (plumbing, electrical, HVAC, roofing, landscaping), service areas, project before/after descriptions, customer reviews, certifications/licenses, and seasonal promotions.",
    priorityDataTypes: ["CUSTOM", "TESTIMONIAL", "PROMOTION", "FAQ"],
  },
  content: {
    starterBlueprintSlugs: ["project-showcase", "seasonal-tip", "customer-review"],
    starterChannels: ["FACEBOOK", "INSTAGRAM", "TIKTOK"],
    starterAngles: [
      "Showcase a completed project with before/after details — highlight the transformation.",
      "Share a seasonal home maintenance tip that positions you as the go-to expert.",
      "Feature a 5-star customer review with context about the job and the outcome.",
    ],
  },
  integrations: {
    supportedCapabilities: ["review_feed", "scheduling"],
    recommendedProviders: ["housecall_pro", "jobber"],
    starterAutomations: ["completed_job_post", "seasonal_service_reminder"],
  },
  recommendationTemplates: [
    { type: "before_after", tier: "core", title: "Share a Before & After", description: "Showcase a completed project with dramatic results.", priority: "high", guidance: "Create a before & after project post. Describe the problem, the solution, and the transformation. Make the results visual and impressive.", conditions: { hasData: true } },
    { type: "special_offer", tier: "core", title: "Promote a Special Offer", description: "Drive bookings with a limited-time deal.", priority: "high", guidance: "Create a special offer promotion post. Include the deal, eligible services, deadline, and a clear call-to-action to book now.", conditions: {} },
    { type: "customer_review", tier: "core", title: "Feature a Customer Review", description: "Build trust with a real client testimonial.", priority: "high", guidance: "Feature a 5-star customer review. Include context about the job, the customer's words, and the outcome. Make it relatable.", conditions: { hasData: true } },
    { type: "seasonal_maintenance", tier: "secondary", title: "Post a Seasonal Tip", description: "Remind homeowners about seasonal maintenance.", priority: "medium", guidance: "Share a seasonal home maintenance tip. Connect it to the current time of year and explain what homeowners should do now to avoid problems later.", conditions: {} },
    { type: "service_spotlight", tier: "secondary", title: "Spotlight a Service", description: "Explain a specific service you offer.", priority: "medium", guidance: "Create a service spotlight post. Explain what the service includes, who needs it, common signs it's time to call, and what to expect.", conditions: {} },
    { type: "project_showcase", tier: "secondary", title: "Showcase a Project", description: "Walk through a recent job from start to finish.", priority: "medium", guidance: "Create a project showcase post. Walk through a recent job — the problem, the approach, and the finished result. Show craftsmanship.", conditions: {} },
    { type: "business_intro", tier: "advanced", title: "Introduce Your Business", description: "Tell homeowners who you are and what you do.", priority: "low", guidance: "Write an introduction post for this home services business. Highlight services, service area, experience, and what makes them the right choice.", conditions: { noPublished: true } },
  ],
  ui: { icon: "Wrench" },
  techStack: [],
};
