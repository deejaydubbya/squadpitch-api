// Industry service — extraction hints, starter angles, blueprint resolution, and tech stack.

import { getIndustryProfile } from "./registry.js";

/** @typedef {import("./techStack.types.js").IndustryTechStackItem} IndustryTechStackItem */
/** @typedef {import("./techStack.types.js").IntegrationCapability} IntegrationCapability */

/**
 * Get extraction hints for an industry key.
 * Returns the hints string to inject into AI extraction prompts,
 * or null if no industry key is provided.
 *
 * @param {string | null | undefined} industryKey
 * @returns {{ hints: string, priorityDataTypes: string[] } | null}
 */
export function getExtractionHints(industryKey) {
  if (!industryKey) return null;
  const profile = getIndustryProfile(industryKey);
  return {
    hints: profile.extraction.hints,
    priorityDataTypes: profile.extraction.priorityDataTypes,
  };
}

/**
 * Get starter content angles for an industry key.
 * Returns an array of 3 guidance strings for onboarding post generation,
 * or null if no industry key is provided.
 *
 * @param {string | null | undefined} industryKey
 * @returns {string[] | null}
 */
export function getStarterAngles(industryKey) {
  if (!industryKey) return null;
  const profile = getIndustryProfile(industryKey);
  return profile.content.starterAngles;
}

/**
 * Get content context for an industry key — used in generation prompts
 * to provide industry-aware guidance beyond onboarding.
 *
 * @param {string | null | undefined} industryKey
 * @returns {{ label: string, description: string, contentAngles: string[], priorityDataTypes: string[], starterChannels: string[], channelRecommendations: { primary: string[], secondary: string[], optional: string[] } | null } | null}
 */
export function getContentContext(industryKey) {
  if (!industryKey) return null;
  const profile = getIndustryProfile(industryKey);
  return {
    label: profile.label,
    description: profile.description,
    contentAngles: profile.content.starterAngles,
    priorityDataTypes: profile.extraction.priorityDataTypes,
    starterChannels: profile.content.starterChannels,
    channelRecommendations: profile.content.channelRecommendations ?? null,
  };
}

/**
 * Get channel recommendations for an industry key.
 * Returns tiered channel recommendations (primary, secondary, optional),
 * or null if no industry key is provided.
 *
 * @param {string | null | undefined} industryKey
 * @returns {{ primary: string[], secondary: string[], optional: string[] } | null}
 */
export function getChannelRecommendations(industryKey) {
  if (!industryKey) return null;
  const profile = getIndustryProfile(industryKey);
  return profile.content.channelRecommendations ?? null;
}

/**
 * Resolve starter blueprint slugs for an industry key.
 * Returns the recommended blueprint slugs and channels,
 * or null if no industry key is provided.
 *
 * @param {string | null | undefined} industryKey
 * @returns {{ slugs: string[], channels: string[] } | null}
 */
export function resolveStarterBlueprints(industryKey) {
  if (!industryKey) return null;
  const profile = getIndustryProfile(industryKey);
  return {
    slugs: profile.content.starterBlueprintSlugs,
    channels: profile.content.starterChannels,
  };
}

/**
 * Get the tech stack items for an industry key.
 * Returns an empty array if no industry key is provided or no items exist.
 *
 * @param {string | null | undefined} industryKey
 * @returns {IndustryTechStackItem[]}
 */
export function getIndustryTechStack(industryKey) {
  if (!industryKey) return [];
  const profile = getIndustryProfile(industryKey);
  return profile.techStack ?? [];
}

// ── Tech stack resolvers ────────────────────────────────────────────

/**
 * Get only core-priority tech stack items for an industry.
 * @param {string | null | undefined} industryKey
 * @returns {IndustryTechStackItem[]}
 */
export function getCoreTechStackItems(industryKey) {
  return getIndustryTechStack(industryKey).filter((i) => i.priority === "core");
}

/**
 * Get tech stack items that have a specific capability.
 * @param {string | null | undefined} industryKey
 * @param {IntegrationCapability} capability
 * @returns {IndustryTechStackItem[]}
 */
export function getTechStackItemsByCapability(industryKey, capability) {
  return getIndustryTechStack(industryKey).filter((i) =>
    i.capabilities.includes(capability),
  );
}

/**
 * Get tech stack items that can publish content.
 * @param {string | null | undefined} industryKey
 * @returns {IndustryTechStackItem[]}
 */
export function getPublishingTechStackItems(industryKey) {
  return getIndustryTechStack(industryKey).filter((i) =>
    i.capabilities.includes("publishing") || i.capabilities.includes("scheduling_target"),
  );
}

/**
 * Get tech stack items that can import data into Squadpitch.
 * @param {string | null | undefined} industryKey
 * @returns {IndustryTechStackItem[]}
 */
export function getImportTechStackItems(industryKey) {
  return getIndustryTechStack(industryKey).filter((i) =>
    i.capabilities.includes("imports") || i.capabilities.includes("content_source"),
  );
}

// ── Tech stack view model ───────────────────────────────────────────

/**
 * @typedef {"importData" | "publishContent" | "enhanceWorkflow"} TechStackGroup
 */

/**
 * @typedef {Object} TechStackViewItem
 * @property {string} providerKey
 * @property {string} label
 * @property {string} [description]
 * @property {"core" | "recommended" | "optional"} priority
 * @property {"live" | "beta" | "planned"} status
 * @property {string} category
 * @property {string[]} capabilities
 * @property {"oauth" | "manual" | "planned"} connectionMode
 * @property {boolean} isPublishing
 * @property {boolean} isImportSource
 * @property {boolean} isWorkflowTool
 * @property {TechStackGroup} group
 */

/**
 * Determine the primary group for a tech stack item based on capabilities.
 * @param {string[]} capabilities
 * @returns {TechStackGroup}
 */
function resolveTechStackGroup(capabilities) {
  if (capabilities.includes("publishing") || capabilities.includes("scheduling_target")) {
    return "publishContent";
  }
  if (capabilities.includes("imports") || capabilities.includes("content_source")) {
    return "importData";
  }
  return "enhanceWorkflow";
}

/**
 * Transform raw tech stack items into a normalized view model.
 * Computes boolean flags and group assignment from capabilities.
 *
 * @param {string | null | undefined} industryKey
 * @returns {TechStackViewItem[]}
 */
export function getIndustryTechStackView(industryKey) {
  return getIndustryTechStack(industryKey).map((item) => {
    const caps = item.capabilities;
    return {
      providerKey: item.providerKey,
      label: item.label,
      description: item.description,
      priority: item.priority,
      status: item.status,
      category: item.category,
      capabilities: caps,
      connectionMode: item.connectionMode ?? "planned",
      isPublishing: caps.includes("publishing") || caps.includes("scheduling_target"),
      isImportSource: caps.includes("imports") || caps.includes("content_source"),
      isWorkflowTool:
        caps.includes("workflow_trigger") ||
        caps.includes("document_source") ||
        caps.includes("client_sync") ||
        caps.includes("lead_sync"),
      group: resolveTechStackGroup(caps),
    };
  });
}

/**
 * Get tech stack view items grouped by their primary function.
 * Returns an object with arrays for each group.
 *
 * @param {string | null | undefined} industryKey
 * @returns {{ importData: TechStackViewItem[], publishContent: TechStackViewItem[], enhanceWorkflow: TechStackViewItem[] }}
 */
export function getGroupedTechStackView(industryKey) {
  const items = getIndustryTechStackView(industryKey);
  return {
    importData: items.filter((i) => i.group === "importData"),
    publishContent: items.filter((i) => i.group === "publishContent"),
    enhanceWorkflow: items.filter((i) => i.group === "enhanceWorkflow"),
  };
}

// ── Terminology & workflow language ──────────────────────────────────

const DEFAULT_TERMINOLOGY = {
  item: "product",
  items: "products",
  customer: "customer",
  customers: "customers",
  service: "service",
  services: "services",
  offer: "offer",
  offers: "offers",
  contentUnit: "post",
  contentUnits: "posts",
  campaign: "campaign",
  campaigns: "campaigns",
  primaryAction: "promote",
};

const DEFAULT_ONBOARDING_STEPS = {
  explore: "Exploring your website...",
  understand: "Understanding your brand...",
  insights: "Discovering business insights...",
  prepare: "Preparing your workspace...",
  generate: "Creating your first posts...",
};

const DEFAULT_BUSINESS_DATA_LABELS = {
  itemSingular: "Item",
  itemPlural: "Items",
  launchLabel: "New Item",
  categoryLabel: "Category",
  collectionLabel: "Collection",
  serviceLabel: "Service",
  offerLabel: "Offer",
};

/**
 * Get industry-specific terminology with defaults.
 * @param {string | null | undefined} industryKey
 */
export function getIndustryTerminology(industryKey) {
  if (!industryKey) return { ...DEFAULT_TERMINOLOGY };
  const profile = getIndustryProfile(industryKey);
  return { ...DEFAULT_TERMINOLOGY, ...profile.terminology };
}

/**
 * Get industry-specific onboarding step labels with defaults.
 * @param {string | null | undefined} industryKey
 */
export function getIndustryOnboardingSteps(industryKey) {
  if (!industryKey) return { ...DEFAULT_ONBOARDING_STEPS };
  const profile = getIndustryProfile(industryKey);
  return { ...DEFAULT_ONBOARDING_STEPS, ...profile.onboardingSteps };
}

/**
 * Get industry-specific input hints (merged from onboarding config).
 * @param {string | null | undefined} industryKey
 */
export function getIndustryInputHints(industryKey) {
  if (!industryKey) return {
    websitePlaceholder: "yourwebsite.com",
    detailsLabel: "Business description",
    detailsPlaceholder: "What does your business do? Who do you serve?",
    detailsHelpText: "No website? No problem — describe your business instead.",
  };
  const profile = getIndustryProfile(industryKey);
  return {
    websitePlaceholder: profile.onboarding.websitePlaceholder,
    detailsLabel: profile.onboarding.extraContextLabel,
    detailsPlaceholder: profile.onboarding.extraContextPlaceholder,
    detailsHelpText: profile.onboarding.helperText,
  };
}

/**
 * Get industry-specific business data labels with defaults.
 * @param {string | null | undefined} industryKey
 */
export function getIndustryBusinessDataLabels(industryKey) {
  if (!industryKey) return { ...DEFAULT_BUSINESS_DATA_LABELS };
  const profile = getIndustryProfile(industryKey);
  return { ...DEFAULT_BUSINESS_DATA_LABELS, ...profile.businessDataLabels };
}

/**
 * Get industry-specific content type labels.
 * @param {string | null | undefined} industryKey
 * @returns {Array<{ key: string, label: string }>}
 */
export function getIndustryContentTypeLabels(industryKey) {
  if (!industryKey) return [];
  const profile = getIndustryProfile(industryKey);
  return profile.contentTypeLabels ?? [];
}

// ── Asset tag defaults ────────────────────────────────────────────────

/**
 * Get default asset tags for an industry key.
 * Returns an empty array if no industry key is provided or no tags are defined.
 *
 * @param {string | null | undefined} industryKey
 * @returns {string[]}
 */
export function getAssetTagDefaults(industryKey) {
  if (!industryKey) return [];
  const profile = getIndustryProfile(industryKey);
  return profile?.assetTags ?? [];
}

// ── Recommendation templates ─────────────────────────────────────────

/**
 * @typedef {Object} RecommendationTemplate
 * @property {string} type - Unique template key (e.g. "listing_post")
 * @property {"core" | "secondary" | "advanced"} tier - Template tier for prioritization
 * @property {string} title - Display title
 * @property {string} description - Short description
 * @property {"high" | "medium" | "low"} priority
 * @property {string} guidance - Prompt guidance passed to content generation
 * @property {{ hasData?: boolean, noPublished?: boolean, hasWebsite?: boolean }} [conditions]
 */

/** @type {RecommendationTemplate[]} */
const GENERIC_TEMPLATES = [
  {
    type: "business_intro",
    tier: "core",
    title: "Introduce Your Business",
    description: "Tell your audience who you are and what you offer.",
    priority: "high",
    guidance: "Write an introduction post for this business. Highlight key services, experience, and what makes them stand out.",
    conditions: { noPublished: true },
  },
  {
    type: "customer_spotlight",
    tier: "core",
    title: "Spotlight a Customer Win",
    description: "Build trust by sharing a real customer success story.",
    priority: "high",
    guidance: "Share a customer success story or testimonial. Use specific details and outcomes to build credibility and trust.",
    conditions: { hasData: true },
  },
  {
    type: "promotion_post",
    tier: "core",
    title: "Promote an Offer or Event",
    description: "Drive action with a timely promotion or upcoming event.",
    priority: "high",
    guidance: "Create a promotional post for a current offer, sale, or upcoming event. Include a clear call-to-action and urgency.",
    conditions: {},
  },
  {
    type: "expertise_post",
    tier: "secondary",
    title: "Share Your Expertise",
    description: "Demonstrate knowledge with an insight or tip your audience will find valuable.",
    priority: "medium",
    guidance: "Create a post sharing a useful tip, insight, or industry knowledge that positions this business as an expert in their field.",
    conditions: {},
  },
  {
    type: "behind_the_scenes",
    tier: "secondary",
    title: "Share Behind the Scenes",
    description: "Humanize your brand with a look at the team or process.",
    priority: "medium",
    guidance: "Create a behind-the-scenes post showing the team, the process, or day-to-day operations. Make it personal and relatable.",
    conditions: {},
  },
];

/**
 * Get recommendation templates for an industry.
 * Returns industry-specific templates if available, otherwise generic fallbacks.
 *
 * @param {string | null | undefined} industryKey
 * @returns {RecommendationTemplate[]}
 */
export function getRecommendationTemplates(industryKey) {
  if (!industryKey) return GENERIC_TEMPLATES;
  const profile = getIndustryProfile(industryKey);
  return profile.recommendationTemplates ?? GENERIC_TEMPLATES;
}
