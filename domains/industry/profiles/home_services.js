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
  ui: { icon: "Wrench" },
};
