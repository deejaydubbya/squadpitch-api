// Medical / Dental / Wellness profile.
//
// spinstr421 introduced this niche to the onboarding selector,
// gated as "coming soon" until we ship industry-specific
// adapters. The profile carries the standard shape (so any code
// that iterates the registry doesn't choke) plus a minimal set
// of compliance defaults — medical content has real consequences
// when AI overpromises, so we mark it isComplianceSensitive and
// the resolver / brand-defaults flow can refuse risky outputs
// once it's wired.

export default {
  key: "medical_dental_wellness",
  label: "Medical / Dental / Wellness",
  description: "Doctors, dentists, clinics, wellness centers, and licensed health practitioners.",
  status: "coming_soon",
  isComplianceSensitive: true,
  complianceNotes: [
    "Don't make diagnostic or treatment claims without disclaimers.",
    "Avoid testimonials that imply specific medical outcomes.",
    "Encourage compliance/clinical review before publishing.",
  ],
  onboarding: {
    websitePlaceholder: "yourclinic.com",
    extraContextLabel: "Practice details",
    extraContextPlaceholder: "Describe your specialties, services, or patient focus...",
    helperText: "We'll respect HIPAA and your professional standards.",
  },
  extraction: {
    hints: "Extract practitioner bios, services offered, locations, hours, insurance accepted, and patient testimonials. Never extract or include any patient-identifying information.",
    priorityDataTypes: ["CUSTOM", "TESTIMONIAL", "FAQ", "TEAM_SPOTLIGHT"],
  },
  content: {
    starterBlueprintSlugs: ["brand-story", "value-post", "social-proof"],
    starterChannels: ["INSTAGRAM", "FACEBOOK"],
    channelRecommendations: {
      primary: ["INSTAGRAM", "FACEBOOK"],
      secondary: ["LINKEDIN"],
      optional: ["YOUTUBE", "THREADS"],
    },
    starterAngles: [
      "Introduce the practice — mission, team, what patients can expect.",
      "Share general wellness tips without making medical claims.",
      "Highlight the patient experience — facility, comfort, accessibility.",
    ],
  },
  integrations: {
    supportedCapabilities: [],
    recommendedProviders: [],
    starterAutomations: [],
  },
  recommendationTemplates: [],
  ui: { icon: "Stethoscope" },
  techStack: [],
};
