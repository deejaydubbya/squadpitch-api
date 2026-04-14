export default {
  key: "beauty",
  label: "Beauty & Salon",
  description: "Hair salons, spas, barbershops, nail studios, and beauty professionals.",
  onboarding: {
    websitePlaceholder: "glamoursalon.com",
    extraContextLabel: "Services or specialties",
    extraContextPlaceholder: "Describe your services, signature treatments, or stylist team...",
    helperText: "We'll extract your services, stylist profiles, and client transformations.",
  },
  extraction: {
    hints: "Focus on services offered (haircuts, coloring, facials, nails, massage), stylist/technician bios, before/after transformations, pricing/packages, client reviews, and booking info.",
    priorityDataTypes: ["CUSTOM", "TESTIMONIAL", "TEAM_SPOTLIGHT", "PROMOTION"],
  },
  content: {
    starterBlueprintSlugs: ["transformation-reveal", "stylist-spotlight", "booking-promo"],
    starterChannels: ["INSTAGRAM", "TIKTOK", "FACEBOOK"],
    starterAngles: [
      "Share a stunning before/after transformation — let the results speak for themselves.",
      "Spotlight a stylist or technician — share their specialty and what clients love about them.",
      "Promote a seasonal package or limited-time offer that drives bookings.",
    ],
  },
  integrations: {
    supportedCapabilities: ["booking_system", "review_feed"],
    recommendedProviders: ["vagaro", "glossgenius"],
    starterAutomations: ["transformation_post", "open_appointment_reminder"],
  },
  recommendationTemplates: [
    { type: "transformation_post", tier: "core", title: "Share a Transformation", description: "Show dramatic before & after results.", priority: "high", guidance: "Create a before & after transformation post. Let the results speak — describe the service, the look achieved, and the client's reaction.", conditions: {} },
    { type: "new_service_announcement", tier: "core", title: "Announce a New Service", description: "Build excitement for a new offering.", priority: "high", guidance: "Announce a new service or treatment. Explain what it is, the benefits, pricing if available, and encourage bookings.", conditions: {} },
    { type: "booking_promo", tier: "core", title: "Promote a Booking Special", description: "Drive appointments with a limited-time offer.", priority: "high", guidance: "Create a booking special promotion. Include the deal, eligible services, deadline, and a clear call-to-action to book now.", conditions: {} },
    { type: "service_spotlight", tier: "secondary", title: "Spotlight a Service", description: "Explain a specific treatment or service you offer.", priority: "medium", guidance: "Create a service spotlight post. Explain what the treatment involves, who it's for, how long it takes, and the results clients can expect.", conditions: {} },
    { type: "client_testimonial", tier: "secondary", title: "Feature a Client Testimonial", description: "Build trust with a real client testimonial.", priority: "medium", guidance: "Feature a client review or testimonial. Share their experience, the service they received, and why they keep coming back.", conditions: { hasData: true } },
    { type: "product_recommendation", tier: "secondary", title: "Recommend a Product", description: "Suggest a retail product you carry.", priority: "medium", guidance: "Create a product recommendation post. Feature a product you carry, explain its benefits, who it's for, and how to use it at home.", conditions: { hasData: true } },
    { type: "stylist_spotlight", tier: "advanced", title: "Spotlight a Stylist", description: "Introduce a team member and their work.", priority: "low", guidance: "Create a stylist or technician spotlight. Share their background, specialties, personality, and what clients love about them.", conditions: {} },
  ],
  ui: { icon: "Scissors" },
  techStack: [],
};
