// industry-03 — module loader.
//
// Single entry point for resolving an industry's module by key.
// Core services (prompt builder, sites generation, etc.) call
// getIndustryModuleOrGeneric() so a null/unknown industry falls
// back to neutral behavior automatically — no silent real-estate
// fallback.
//
// Adding a new industry:
//   1. Create modules/<key>/ with prompts.js + campaignTypes.js +
//      siteTemplates.js + index.js.
//   2. Register in MODULE_REGISTRY below.
//   3. (Optional) seed industry/registry.js + industry/profiles/
//      so it appears in the onboarding picker.

import { genericIndustryModule } from "./generic/index.js";
import { realEstateIndustryModule } from "./real_estate/index.js";

const MODULE_REGISTRY = new Map([
  [realEstateIndustryModule.key, realEstateIndustryModule],
  // Future:
  // [carSalesIndustryModule.key, carSalesIndustryModule],
]);

/**
 * Return the strictly-matching industry module, or null if the
 * key isn't registered. Used by code paths that need to know
 * whether an industry has its own module (e.g. autopilot-feature
 * support checks).
 *
 * @param {string|null|undefined} industryKey
 * @returns {import("./types.js").IndustryModule|null}
 */
export function getIndustryModule(industryKey) {
  if (!industryKey) return null;
  return MODULE_REGISTRY.get(industryKey) ?? null;
}

/**
 * Return the matching industry module, or the generic fallback
 * when the key is null / unknown. This is the right loader for
 * prompt builders, site generation, anywhere you want "use the
 * industry's overrides if present, else neutral defaults".
 *
 * Never silently returns the real-estate module for an unknown
 * key — that was the leakage bug industry-01 fixed at the
 * adapter layer; same principle here.
 *
 * @param {string|null|undefined} industryKey
 * @returns {import("./types.js").IndustryModule}
 */
export function getIndustryModuleOrGeneric(industryKey) {
  return getIndustryModule(industryKey) ?? genericIndustryModule;
}

/**
 * The neutral baseline module. Exposed so callers can fetch the
 * generic config without first resolving an industry key (e.g.
 * for documentation surfaces or no-industry-aware tests).
 *
 * @returns {import("./types.js").IndustryModule}
 */
export function getGenericIndustryModule() {
  return genericIndustryModule;
}

/**
 * Check whether an industry module declares support for a named
 * feature. Today the supported feature names are:
 *   - 'autopilot'  → industry has autopilot trigger types defined
 *   - 'urlExtraction' → industry has a URL extractor
 *
 * Other surfaces can add their own feature checks here.
 *
 * @param {string|null|undefined} industryKey
 * @param {'autopilot'|'urlExtraction'} feature
 * @returns {boolean}
 */
export function isIndustryFeatureSupported(industryKey, feature) {
  const mod = getIndustryModuleOrGeneric(industryKey);
  switch (feature) {
    case "autopilot":
      return Array.isArray(mod.autopilotTriggerTypes) && mod.autopilotTriggerTypes.length > 0;
    case "urlExtraction":
      return Boolean(mod.urlExtraction);
    default:
      return false;
  }
}

/**
 * Sorted list of registered industry module keys (excludes generic).
 * Used by industry-selection UIs that want to render every concrete
 * industry option.
 *
 * @returns {string[]}
 */
export function listRegisteredIndustryKeys() {
  return [...MODULE_REGISTRY.keys()].sort();
}
