export default {
  key: "fitness",
  label: "Fitness & Training",
  description: "Gyms, personal trainers, yoga studios, and wellness coaches.",
  onboarding: {
    websitePlaceholder: "ironcorefitness.com",
    extraContextLabel: "Programs or specialties",
    extraContextPlaceholder: "Describe your programs, class schedule, or coaching philosophy...",
    helperText: "We'll extract your programs, trainer bios, and client transformations.",
  },
  extraction: {
    hints: "Focus on fitness programs (classes, personal training, group sessions), trainer/coach bios, client transformation stories, class schedules, membership options, nutrition services, and facility amenities.",
    priorityDataTypes: ["CUSTOM", "TESTIMONIAL", "EVENT", "TEAM_SPOTLIGHT"],
  },
  content: {
    starterBlueprintSlugs: ["transformation-story", "workout-tip", "class-spotlight"],
    starterChannels: ["INSTAGRAM", "TIKTOK", "FACEBOOK"],
    starterAngles: [
      "Share a client transformation story — celebrate their journey and results (with permission).",
      "Post a quick workout tip or exercise demo that followers can try today.",
      "Spotlight an upcoming class, challenge, or event that drives sign-ups.",
    ],
  },
  integrations: {
    supportedCapabilities: ["class_schedule", "member_management"],
    recommendedProviders: ["mindbody", "trainerize"],
    starterAutomations: ["class_reminder_post", "member_milestone_celebration"],
  },
  ui: { icon: "Dumbbell" },
  techStack: [],
};
