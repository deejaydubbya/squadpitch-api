// Mock Property Enrichment Provider
//
// Always available — no API key needed. Returns deterministic fake data
// based on an address hash so the same address always produces the same result.
// Used for development, testing, and as automatic fallback.

const PROVIDER_NAME = "mock";

/**
 * Simple hash from string → integer (deterministic).
 */
function hashAddress(str) {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
  }
  return Math.abs(hash);
}

/**
 * Deterministic pseudo-random from hash + seed.
 */
function seeded(hash, seed) {
  const combined = ((hash * 2654435761 + seed * 40503) >>> 0) / 4294967296;
  return combined;
}

/**
 * Pick from array using hash.
 */
function pick(arr, hash, seed = 0) {
  return arr[Math.floor(seeded(hash, seed) * arr.length)];
}

/**
 * Range value using hash.
 */
function range(min, max, hash, seed = 0) {
  return Math.round(min + seeded(hash, seed) * (max - min));
}

const PROPERTY_TYPES = ["single_family", "condo", "townhouse", "multi_family", "land"];
const FEATURES_POOL = [
  "Hardwood floors", "Granite countertops", "Stainless steel appliances",
  "Central air", "Updated kitchen", "Walk-in closet", "Fireplace",
  "Covered patio", "Fenced yard", "Attached garage", "Finished basement",
  "Crown molding", "Vaulted ceilings", "Open floor plan", "Smart home features",
  "Energy-efficient windows", "In-unit laundry", "Pool access", "New roof",
  "Freshly painted", "Tankless water heater", "Deck", "Garden",
];

export const mockProvider = {
  name: PROVIDER_NAME,

  isAvailable() {
    return true; // Always available
  },

  /**
   * Return deterministic enrichment data based on address.
   *
   * @param {{ street?: string, city?: string, state?: string, zip?: string }} address
   * @returns {Promise<object|null>}
   */
  async lookupByAddress({ street, city, state, zip }) {
    const addressStr = [street, city, state, zip].filter(Boolean).join(" ").toLowerCase();
    if (!addressStr || addressStr.length < 5) return null;

    const h = hashAddress(addressStr);

    const propertyType = pick(PROPERTY_TYPES, h, 1);
    const yearBuilt = range(1960, 2024, h, 2);
    const lotAcres = (range(10, 200, h, 3) / 100).toFixed(2);
    const bedrooms = range(2, 5, h, 4);
    const bathrooms = range(1, 4, h, 5);
    const sqft = range(800, 4500, h, 6);
    const garage = range(0, 3, h, 7);

    // Price ranges by property type
    const priceRanges = {
      single_family: [250000, 1200000],
      condo: [150000, 600000],
      townhouse: [200000, 800000],
      multi_family: [400000, 1500000],
      land: [50000, 500000],
    };
    const [minP, maxP] = priceRanges[propertyType] || [200000, 800000];
    const estimatedValue = range(minP, maxP, h, 8);
    const taxAssessedValue = Math.round(estimatedValue * (range(75, 95, h, 9) / 100));
    const lastSalePrice = Math.round(estimatedValue * (range(70, 100, h, 10) / 100));

    // Last sale date: 1-15 years ago
    const yearsAgo = range(1, 15, h, 11);
    const lastSaleDate = `${2024 - yearsAgo}-${String(range(1, 12, h, 12)).padStart(2, "0")}-${String(range(1, 28, h, 13)).padStart(2, "0")}`;

    // Pick 3-6 features deterministically
    const featureCount = range(3, 6, h, 14);
    const features = [];
    for (let i = 0; i < featureCount; i++) {
      const feat = pick(FEATURES_POOL, h, 20 + i);
      if (!features.includes(feat)) features.push(feat);
    }

    console.log(`[PropertyEnrichment:mock] Enriched address: "${addressStr}"`);

    return {
      provider: PROVIDER_NAME,
      bedrooms,
      bathrooms,
      sqft,
      lotSize: `${lotAcres} acres`,
      yearBuilt,
      garage,
      propertyType,
      features,
      estimatedValue,
      taxAssessedValue,
      lastSalePrice,
      lastSaleDate,
    };
  },
};
