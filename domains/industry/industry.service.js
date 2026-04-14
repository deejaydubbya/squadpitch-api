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
 * @returns {{ label: string, description: string, contentAngles: string[], priorityDataTypes: string[], starterChannels: string[] } | null}
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
  };
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
