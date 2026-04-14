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
  ui: { icon: "Scissors" },
};
