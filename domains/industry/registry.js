// Industry profile registry — central map of all industry profiles.

import realEstate from "./profiles/real_estate.js";
import carSales from "./profiles/car_sales.js";
import propertyManagement from "./profiles/property_management.js";
import ecommerce from "./profiles/ecommerce.js";
import mortgage from "./profiles/mortgage.js";
import insurance from "./profiles/insurance.js";
import legal from "./profiles/legal.js";
import finance from "./profiles/finance.js";
import homeServices from "./profiles/home_services.js";
import fitness from "./profiles/fitness.js";
import restaurant from "./profiles/restaurant.js";
import beauty from "./profiles/beauty.js";
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
  fitness,
  restaurant,
  beauty,
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
 * @returns {Array<{ key: string, label: string, description: string, icon: string }>}
 */
export function getIndustryOptionsForUI() {
  return ALL_PROFILES.map((p) => ({
    key: p.key,
    label: p.label,
    description: p.description,
    icon: p.ui.icon,
  }));
}
