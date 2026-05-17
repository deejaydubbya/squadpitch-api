// Industry profile registry — central map of all industry profiles.
//
// Ordering matters: the array order is the order the onboarding
// selector renders. Active (selectable) profiles first, then
// coming-soon profiles in the order spec'd by spinstr421.

import realEstate from "./profiles/real_estate.js";
import carSales from "./profiles/car_sales.js";
import propertyManagement from "./profiles/property_management.js";
import ecommerce from "./profiles/ecommerce.js";
import mortgage from "./profiles/mortgage.js";
import insurance from "./profiles/insurance.js";
import legal from "./profiles/legal.js";
import finance from "./profiles/finance.js";
import homeServices from "./profiles/home_services.js";
import medical from "./profiles/medical.js";
import fitness from "./profiles/fitness.js";
import restaurant from "./profiles/restaurant.js";
import beauty from "./profiles/beauty.js";
import events from "./profiles/events.js";
import creator from "./profiles/creator.js";
import smallBusiness from "./profiles/small_business.js";
import other from "./profiles/other.js";

const ALL_PROFILES = [
  realEstate,
  carSales,
  propertyManagement,
  ecommerce,
  mortgage,
  insurance,
  legal,
  finance,
  homeServices,
  medical,
  fitness,
  restaurant,
  beauty,
  events,
  creator,
  smallBusiness,
  other,
];

const PROFILE_MAP = new Map(ALL_PROFILES.map((p) => [p.key, p]));

export const VALID_INDUSTRY_KEYS = new Set(ALL_PROFILES.map((p) => p.key));

/**
 * Get a single industry profile by key.
 * Returns the "other" fallback profile for unknown/missing keys.
 * @param {string} key
 * @returns {object}
 */
export function getIndustryProfile(key) {
  return PROFILE_MAP.get(key) ?? other;
}

/**
 * Check if a key is a valid registered industry key.
 * @param {string} key
 * @returns {boolean}
 */
export function isValidIndustryKey(key) {
  return VALID_INDUSTRY_KEYS.has(key);
}

/**
 * List all industry profiles (returns cloned array).
 * @returns {object[]}
 */
export function listIndustryProfiles() {
  return [...ALL_PROFILES];
}

/**
 * Get industry options formatted for frontend UI selectors.
 * Includes status + compliance flag so the onboarding grid can
 * render coming-soon cards as disabled with the right framing.
 * @returns {Array<{
 *   key: string,
 *   label: string,
 *   description: string,
 *   icon: string,
 *   status: 'active' | 'coming_soon',
 *   isSelectable: boolean,
 *   isComplianceSensitive: boolean,
 * }>}
 */
export function getIndustryOptionsForUI() {
  return ALL_PROFILES.map((p) => ({
    key: p.key,
    label: p.label,
    description: p.description,
    icon: p.ui?.icon ?? "Briefcase",
    status: p.status ?? "active",
    isSelectable: (p.status ?? "active") === "active",
    isComplianceSensitive: p.isComplianceSensitive === true,
  }));
}

/**
 * Check whether a given key is selectable today. Used by the
 * workspace-update handler to refuse a save that would assign an
 * industryKey the UI shouldn't allow. Defaults to false on
 * unknown keys.
 */
export function isIndustryKeySelectable(key) {
  const profile = PROFILE_MAP.get(key);
  if (!profile) return false;
  return (profile.status ?? "active") === "active";
}

// Legacy label / synonym → canonical key map. The onboarding
// selector has always stored snake_case keys so most of these
// mappings already match by accident — but inbound code paths
// (CSV imports, scraped values, older API clients) sometimes
// send labels. Normalize defensively so the workspace's industry
// resolves the same regardless of which surface set it.
const LEGACY_KEY_ALIASES = new Map(
  Object.entries({
    // Old label strings (case-insensitive).
    "real estate": "real_estate",
    "car sales": "car_sales",
    "property management": "property_management",
    "e-commerce": "ecommerce",
    "ecommerce / online store": "ecommerce",
    "mortgage & loans": "mortgage",
    "mortgage / loan officer": "mortgage",
    "insurance agent": "insurance",
    "legal services": "legal",
    "financial advisor": "finance",
    "home services": "home_services",
    "medical / dental / wellness": "medical_dental_wellness",
    "fitness & training": "fitness",
    "fitness / gym / personal training": "fitness",
    "restaurant & food": "restaurant",
    "restaurant / cafe / food business": "restaurant",
    "beauty & salon": "beauty",
    "beauty / salon / spa": "beauty",
    "events / entertainment": "events_entertainment",
    "creator & brand": "creator",
    "content creator / personal brand": "creator",
    "small business": "small_business",
    "small business general": "small_business",
    "something else": "other",
    // Old/new id pairs (the prompt suggests longer ids; we accept
    // both so a future migration to the longer ids is a one-line
    // change here, not a data migration).
    property_management_rentals: "property_management",
    ecommerce_online_store: "ecommerce",
    mortgage_loan_officer: "mortgage",
    fitness_gym_personal_training: "fitness",
    restaurant_cafe_food: "restaurant",
    beauty_salon_spa: "beauty",
    content_creator_personal_brand: "creator",
    small_business_general: "small_business",
    something_else: "other",
  }),
);

/**
 * Resolve any incoming string (label or alias key) to the
 * canonical industry key stored on Client.industryKey. Returns
 * "other" for unrecognized values rather than throwing — keeps
 * older saved workspaces displayable even if their stored key
 * is from a vintage that no longer matches our registry.
 */
export function normalizeIndustryKey(input) {
  if (input == null) return "other";
  const raw = String(input).trim();
  if (raw.length === 0) return "other";
  // Direct hit on the live registry?
  if (VALID_INDUSTRY_KEYS.has(raw)) return raw;
  // Alias table is case-insensitive.
  const aliased = LEGACY_KEY_ALIASES.get(raw.toLowerCase());
  if (aliased) return aliased;
  return "other";
}
