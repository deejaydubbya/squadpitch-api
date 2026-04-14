// Industry service — extraction hints, starter angles, blueprint resolution, and tech stack.

import { getIndustryProfile } from "./registry.js";

/** @typedef {import("./techStack.types.js").IndustryTechStackItem} IndustryTechStackItem */

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
