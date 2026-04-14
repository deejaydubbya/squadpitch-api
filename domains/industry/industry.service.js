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
