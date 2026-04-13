// Industry service — extraction hints, starter angles, and blueprint resolution.

import { getIndustryProfile } from "./registry.js";

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
