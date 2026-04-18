// RentCast response → unified model mappers.
//
// Pure functions — no side effects, no I/O. Each function takes the raw
// RentCast JSON and returns one of the unified types from propertyData.types.js.
// ATTOM would have its own attom.mappers.js with the same output shapes.

const PROVIDER = "rentcast";

/**
 * Normalize a RentCast property type string into our standard set.
 * @param {string | null | undefined} type
 * @returns {string | null}
 */
export function normalizePropertyType(type) {
  if (!type) return null;
  const lower = String(type).toLowerCase();
  if (lower.includes("single") || lower.includes("house")) return "single_family";
  if (lower.includes("condo")) return "condo";
  if (lower.includes("town")) return "townhouse";
  if (lower.includes("multi") || lower.includes("duplex")) return "multi_family";
  if (lower.includes("land") || lower.includes("lot")) return "land";
  if (lower.includes("commercial")) return "commercial";
  if (lower.includes("apartment")) return "apartment";
  return "other";
}

/** @param {number | string | null | undefined} v */
function num(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** @param {string | null | undefined} v */
function str(v) {
  return v != null ? String(v) : null;
}

/**
 * Map a raw RentCast property record to UnifiedProperty.
 * RentCast /properties returns an array — caller should pick the first element.
 *
 * @param {object} raw
 * @returns {import('../../propertyData.types.js').UnifiedProperty}
 */
export function mapProperty(raw) {
  if (!raw || typeof raw !== "object") return null;

  const features = raw.features && typeof raw.features === "object"
    ? {
        cooling: Boolean(raw.features.cooling),
        coolingType: str(raw.features.coolingType),
        heating: Boolean(raw.features.heating),
        heatingType: str(raw.features.heatingType),
        fireplace: Boolean(raw.features.fireplace),
        pool: Boolean(raw.features.pool),
        exteriorType: str(raw.features.exteriorType),
        roofType: str(raw.features.roofType),
        floorCount: num(raw.features.floorCount),
      }
    : null;

  const owner = raw.ownerName || raw.owner
    ? {
        names: raw.owner?.names ?? (raw.ownerName ? [raw.ownerName] : []),
        ownerOccupied: Boolean(raw.ownerOccupied ?? raw.owner?.ownerOccupied),
      }
    : null;

  // Tax assessments keyed by year
  let taxAssessments = null;
  if (raw.taxAssessments && typeof raw.taxAssessments === "object") {
    taxAssessments = {};
    for (const [year, assess] of Object.entries(raw.taxAssessments)) {
      taxAssessments[year] = {
        land: num(assess?.land),
        improvements: num(assess?.improvements),
        total: num(assess?.total),
      };
    }
  }

  // Sale history
  const saleHistory = [];
  if (Array.isArray(raw.saleHistory)) {
    for (const entry of raw.saleHistory) {
      if (entry?.date && entry?.price) {
        saleHistory.push({ date: String(entry.date), price: Number(entry.price) });
      }
    }
  }

  return {
    provider: PROVIDER,
    providerId: str(raw.id),
    formattedAddress: str(raw.formattedAddress ?? raw.addressFull),
    street: str(raw.addressLine1),
    city: str(raw.city),
    state: str(raw.state),
    zip: str(raw.zipCode),
    county: str(raw.county),
    latitude: num(raw.latitude),
    longitude: num(raw.longitude),
    propertyType: normalizePropertyType(raw.propertyType),
    bedrooms: num(raw.bedrooms),
    bathrooms: num(raw.bathrooms),
    sqft: num(raw.squareFootage),
    lotSize: num(raw.lotSize),
    yearBuilt: num(raw.yearBuilt),
    garage: num(raw.garageSpaces),
    features,
    owner,
    taxAssessments,
    lastSalePrice: num(raw.lastSalePrice),
    lastSaleDate: str(raw.lastSaleDate),
    saleHistory,
    hoaFee: num(raw.hoa?.fee ?? raw.hoaFee),
  };
}

/**
 * Map a raw RentCast listing record to UnifiedListing.
 *
 * @param {object} raw
 * @returns {import('../../propertyData.types.js').UnifiedListing}
 */
export function mapListing(raw) {
  if (!raw || typeof raw !== "object") return null;

  const agent = raw.listedByAgentName || raw.agent
    ? {
        name: str(raw.agent?.name ?? raw.listedByAgentName),
        phone: str(raw.agent?.phone ?? raw.listedByAgentPhone),
        email: str(raw.agent?.email ?? raw.listedByAgentEmail),
      }
    : null;

  const office = raw.listedByOfficeName || raw.office
    ? {
        name: str(raw.office?.name ?? raw.listedByOfficeName),
        phone: str(raw.office?.phone ?? raw.listedByOfficePhone),
      }
    : null;

  return {
    provider: PROVIDER,
    providerId: str(raw.id),
    formattedAddress: str(raw.formattedAddress ?? raw.addressFull),
    street: str(raw.addressLine1),
    city: str(raw.city),
    state: str(raw.state),
    zip: str(raw.zipCode),
    propertyType: normalizePropertyType(raw.propertyType),
    price: num(raw.price),
    bedrooms: num(raw.bedrooms),
    bathrooms: num(raw.bathrooms),
    sqft: num(raw.squareFootage),
    lotSize: num(raw.lotSize),
    yearBuilt: num(raw.yearBuilt),
    status: normalizeStatus(raw.status),
    daysOnMarket: num(raw.daysOnMarket),
    listedDate: str(raw.listedDate),
    removedDate: str(raw.removedDate),
    agent,
    office,
  };
}

/**
 * @param {string | null | undefined} status
 * @returns {string | null}
 */
function normalizeStatus(status) {
  if (!status) return null;
  const lower = String(status).toLowerCase();
  if (lower.includes("active")) return "active";
  if (lower.includes("pending")) return "pending";
  if (lower.includes("sold") || lower.includes("closed")) return "sold";
  return "off_market";
}

/**
 * Map RentCast AVM value response to PropertyValuation.
 *
 * @param {object} raw
 * @returns {import('../../propertyData.types.js').PropertyValuation}
 */
export function mapValuation(raw) {
  if (!raw || typeof raw !== "object") return null;

  return {
    provider: PROVIDER,
    estimate: num(raw.price) ?? 0,
    rangeLow: num(raw.priceLow ?? raw.priceRangeLow),
    rangeHigh: num(raw.priceHigh ?? raw.priceRangeHigh),
    comparables: mapComparables(raw.comparables),
  };
}

/**
 * Map RentCast AVM rent response to RentEstimate.
 *
 * @param {object} raw
 * @returns {import('../../propertyData.types.js').RentEstimate}
 */
export function mapRentEstimate(raw) {
  if (!raw || typeof raw !== "object") return null;

  return {
    provider: PROVIDER,
    estimate: num(raw.rent) ?? 0,
    rangeLow: num(raw.rentRangeLow),
    rangeHigh: num(raw.rentRangeHigh),
    comparables: mapComparables(raw.comparables),
  };
}

/**
 * Map raw comparables array to ValuationComparable[].
 * @param {any[] | undefined} comps
 * @returns {import('../../propertyData.types.js').ValuationComparable[]}
 */
function mapComparables(comps) {
  if (!Array.isArray(comps)) return [];
  return comps.map((c) => ({
    address: str(c.formattedAddress ?? c.address),
    price: num(c.price ?? c.rent),
    sqft: num(c.squareFootage),
    bedrooms: num(c.bedrooms),
    bathrooms: num(c.bathrooms),
    distance: num(c.distance),
    correlation: num(c.correlation),
    daysOnMarket: num(c.daysOnMarket),
  }));
}

/**
 * Map RentCast market data response to MarketSnapshot.
 *
 * @param {object} raw
 * @param {string} zipCode
 * @returns {import('../../propertyData.types.js').MarketSnapshot}
 */
export function mapMarketData(raw, zipCode) {
  if (!raw || typeof raw !== "object") return null;

  // RentCast /markets returns sale and rental data in the same object
  const saleData = raw.saleData ?? (raw.averagePrice != null ? raw : null);
  const rentalData = raw.rentalData ?? (raw.averageRent != null ? raw : null);

  return {
    provider: PROVIDER,
    zipCode,
    saleData: saleData
      ? {
          averagePrice: num(saleData.averagePrice),
          medianPrice: num(saleData.medianPrice),
          averagePricePerSqft: num(saleData.averagePricePerSqft),
          averageDaysOnMarket: num(saleData.averageDaysOnMarket),
          totalListings: num(saleData.totalListings),
          newListings: num(saleData.newListings),
        }
      : null,
    rentalData: rentalData
      ? {
          averageRent: num(rentalData.averageRent),
          medianRent: num(rentalData.medianRent),
          averageRentPerSqft: num(rentalData.averageRentPerSqft),
          averageDaysOnMarket: num(rentalData.averageDaysOnMarket),
          totalListings: num(rentalData.totalListings),
        }
      : null,
    lastUpdated: str(raw.lastUpdated ?? raw.updatedAt),
  };
}
