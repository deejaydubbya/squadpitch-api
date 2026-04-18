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
    channelRecommendations: {
      primary: ["INSTAGRAM", "TIKTOK"],
      secondary: ["YOUTUBE"],
      optional: ["FACEBOOK", "THREADS"],
    },
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
  recommendationTemplates: [
    { type: "transformation_story", tier: "core", title: "Share a Transformation Story", description: "Showcase a real client's fitness journey.", priority: "high", guidance: "Create a client transformation post. Share their starting point, what they did, and where they are now. Celebrate the journey and results.", conditions: { hasData: true } },
    { type: "class_promo", tier: "core", title: "Promote a Class or Program", description: "Drive sign-ups for a specific offering.", priority: "high", guidance: "Create a class or program promotion post. Highlight what it includes, who it's for, schedule, and a clear call-to-action to sign up.", conditions: {} },
    { type: "workout_tip", tier: "core", title: "Share a Workout Tip", description: "Post an exercise tip or quick routine.", priority: "high", guidance: "Share a practical workout tip or quick exercise routine. Make it something followers can try today — clear, actionable, and motivating.", conditions: {} },
    { type: "client_testimonial", tier: "secondary", title: "Feature a Client Testimonial", description: "Build credibility with a real client review.", priority: "medium", guidance: "Feature a client testimonial or review. Share their experience, what they achieved, and why they'd recommend your gym or training.", conditions: { hasData: true } },
    { type: "nutrition_tip", tier: "secondary", title: "Share a Nutrition Tip", description: "Post practical diet or nutrition advice.", priority: "medium", guidance: "Share a practical nutrition tip. Keep it simple and evidence-based — a meal prep idea, macro tip, or hydration reminder that supports fitness goals.", conditions: {} },
    { type: "challenge_post", tier: "secondary", title: "Launch a Fitness Challenge", description: "Engage your audience with a challenge.", priority: "medium", guidance: "Create a fitness challenge post. Define the challenge, duration, rules, and how to participate. Make it fun and shareable.", conditions: {} },
    { type: "trainer_spotlight", tier: "advanced", title: "Spotlight a Trainer", description: "Introduce a team member and their expertise.", priority: "low", guidance: "Create a trainer spotlight post. Introduce their background, certifications, training style, and what clients love about working with them.", conditions: {} },
  ],
  ui: { icon: "Dumbbell" },
  techStack: [],
};
