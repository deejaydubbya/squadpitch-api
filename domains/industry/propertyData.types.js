// Unified property data types — provider-agnostic models.
//
// All property data providers (RentCast, ATTOM, etc.) map their
// responses into these shapes so consumers never see raw provider data.
// Provider field: "rentcast" | "attom" | "mock"
//
// ── PropertyDataProvider Interface ──
//
// Each provider in providers/ must export an object matching this shape.
// propertyData.service.js dispatches to the active provider via this interface.
//
// To add a new provider:
//   1. Create providers/<name>/<name>.provider.js
//   2. Implement all methods below (return null for unsupported endpoints)
//   3. Register in propertyData.service.js providers array
//   4. Add API key to config/env.js

/**
 * @typedef {Object} PropertyDataProvider
 * @property {string} name — unique provider identifier ("rentcast", "attom")
 * @property {() => boolean} isAvailable — returns true if API key is configured
 * @property {(address: string) => Promise<UnifiedProperty | null>} lookupProperty
 * @property {(params: PropertySearchParams) => Promise<UnifiedListing[]>} searchListings
 * @property {(address: string) => Promise<PropertyValuation | null>} getPropertyValue
 * @property {(address: string) => Promise<RentEstimate | null>} getRentEstimate
 * @property {(zipCode: string) => Promise<MarketSnapshot | null>} getMarketData
 */

/**
 * @typedef {Object} UnifiedProperty
 * @property {string} provider
 * @property {string | null} providerId
 * @property {string | null} formattedAddress
 * @property {string | null} street
 * @property {string | null} city
 * @property {string | null} state
 * @property {string | null} zip
 * @property {string | null} county
 * @property {number | null} latitude
 * @property {number | null} longitude
 * @property {string | null} propertyType - normalized: single_family, condo, townhouse, multi_family, land, commercial, apartment, other
 * @property {number | null} bedrooms
 * @property {number | null} bathrooms
 * @property {number | null} sqft
 * @property {number | null} lotSize
 * @property {number | null} yearBuilt
 * @property {number | null} garage
 * @property {UnifiedPropertyFeatures | null} features
 * @property {UnifiedPropertyOwner | null} owner
 * @property {Record<string, UnifiedTaxAssessment> | null} taxAssessments
 * @property {number | null} lastSalePrice
 * @property {string | null} lastSaleDate
 * @property {UnifiedSaleHistoryEntry[]} saleHistory
 * @property {number | null} hoaFee
 */

/**
 * @typedef {Object} UnifiedPropertyFeatures
 * @property {boolean} cooling
 * @property {string | null} coolingType
 * @property {boolean} heating
 * @property {string | null} heatingType
 * @property {boolean} fireplace
 * @property {boolean} pool
 * @property {string | null} exteriorType
 * @property {string | null} roofType
 * @property {number | null} floorCount
 */

/**
 * @typedef {Object} UnifiedPropertyOwner
 * @property {string[]} names
 * @property {boolean} ownerOccupied
 */

/**
 * @typedef {Object} UnifiedTaxAssessment
 * @property {number | null} land
 * @property {number | null} improvements
 * @property {number | null} total
 */

/**
 * @typedef {Object} UnifiedSaleHistoryEntry
 * @property {string} date
 * @property {number} price
 */

/**
 * @typedef {Object} UnifiedListing
 * @property {string} provider
 * @property {string | null} providerId
 * @property {string | null} formattedAddress
 * @property {string | null} street
 * @property {string | null} city
 * @property {string | null} state
 * @property {string | null} zip
 * @property {string | null} propertyType
 * @property {number | null} price
 * @property {number | null} bedrooms
 * @property {number | null} bathrooms
 * @property {number | null} sqft
 * @property {number | null} lotSize
 * @property {number | null} yearBuilt
 * @property {string | null} status - "active" | "pending" | "sold" | "off_market"
 * @property {number | null} daysOnMarket
 * @property {string | null} listedDate
 * @property {string | null} removedDate
 * @property {UnifiedListingAgent | null} agent
 * @property {UnifiedListingOffice | null} office
 */

/**
 * @typedef {Object} UnifiedListingAgent
 * @property {string | null} name
 * @property {string | null} phone
 * @property {string | null} email
 */

/**
 * @typedef {Object} UnifiedListingOffice
 * @property {string | null} name
 * @property {string | null} phone
 */

/**
 * @typedef {Object} PropertyValuation
 * @property {string} provider
 * @property {number} estimate
 * @property {number | null} rangeLow
 * @property {number | null} rangeHigh
 * @property {ValuationComparable[]} comparables
 */

/**
 * @typedef {Object} ValuationComparable
 * @property {string | null} address
 * @property {number | null} price
 * @property {number | null} sqft
 * @property {number | null} bedrooms
 * @property {number | null} bathrooms
 * @property {number | null} distance - miles
 * @property {number | null} correlation - 0-1
 * @property {number | null} daysOnMarket
 */

/**
 * @typedef {Object} RentEstimate
 * @property {string} provider
 * @property {number} estimate
 * @property {number | null} rangeLow
 * @property {number | null} rangeHigh
 * @property {ValuationComparable[]} comparables
 */

/**
 * @typedef {Object} MarketSnapshot
 * @property {string} provider
 * @property {string} zipCode
 * @property {MarketSaleData | null} saleData
 * @property {MarketRentalData | null} rentalData
 * @property {string | null} lastUpdated
 */

/**
 * @typedef {Object} MarketSaleData
 * @property {number | null} averagePrice
 * @property {number | null} medianPrice
 * @property {number | null} averagePricePerSqft
 * @property {number | null} averageDaysOnMarket
 * @property {number | null} totalListings
 * @property {number | null} newListings
 */

/**
 * @typedef {Object} MarketRentalData
 * @property {number | null} averageRent
 * @property {number | null} medianRent
 * @property {number | null} averageRentPerSqft
 * @property {number | null} averageDaysOnMarket
 * @property {number | null} totalListings
 */

/**
 * @typedef {Object} PropertySearchParams
 * @property {string} [address]
 * @property {string} [city]
 * @property {string} [state]
 * @property {string} [zipCode]
 * @property {number} [latitude]
 * @property {number} [longitude]
 * @property {number} [radius]
 * @property {string} [propertyType]
 * @property {number} [limit]
 * @property {number} [offset]
 */
