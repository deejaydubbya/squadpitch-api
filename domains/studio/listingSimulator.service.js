// Listing Simulator Service — dev testing utility.
//
// Generates sample listings via the real ingestion pipeline and simulates
// lifecycle events (price drops, status changes, aging) for testing.
//
// All routes gated by NODE_ENV !== "production".

import { prisma } from "../../prisma.js";
import { ingestManualListing } from "./listingIngestion.service.js";
import {
  recordPriceChange,
  recordStatusChange,
  detectIngestionEvents,
  appendEvents,
  computeDaysOnMarket,
} from "./listingEvents.service.js";

// ── Sample Data ──────────────────────────────────────────────────────────

const SAMPLE_ADDRESSES = [
  { street: "123 Main St", city: "Denver", state: "CO", zip: "80202" },
  { street: "456 Oak Ave", city: "Austin", state: "TX", zip: "78701" },
  { street: "789 Maple Dr", city: "Portland", state: "OR", zip: "97201" },
  { street: "321 Pine Ln", city: "Nashville", state: "TN", zip: "37201" },
  { street: "654 Cedar Blvd", city: "Phoenix", state: "AZ", zip: "85001" },
  { street: "987 Elm St", city: "Charlotte", state: "NC", zip: "28201" },
  { street: "147 Birch Ct", city: "Seattle", state: "WA", zip: "98101" },
  { street: "258 Walnut Way", city: "Raleigh", state: "NC", zip: "27601" },
  { street: "369 Spruce Pl", city: "Tampa", state: "FL", zip: "33601" },
  { street: "741 Willow Rd", city: "Atlanta", state: "GA", zip: "30301" },
  { street: "852 Ash Ter", city: "San Diego", state: "CA", zip: "92101" },
  { street: "963 Poplar Cir", city: "Minneapolis", state: "MN", zip: "55401" },
  { street: "111 Dogwood Dr", city: "Chicago", state: "IL", zip: "60601" },
  { street: "222 Hickory Ln", city: "Boston", state: "MA", zip: "02101" },
  { street: "333 Juniper Ave", city: "Dallas", state: "TX", zip: "75201" },
  { street: "444 Magnolia St", city: "Miami", state: "FL", zip: "33101" },
  { street: "555 Redwood Blvd", city: "Sacramento", state: "CA", zip: "95814" },
  { street: "666 Cypress Way", city: "San Antonio", state: "TX", zip: "78201" },
  { street: "777 Hemlock Ct", city: "Orlando", state: "FL", zip: "32801" },
  { street: "888 Chestnut Dr", city: "Columbus", state: "OH", zip: "43201" },
  { street: "999 Sycamore Pl", city: "Indianapolis", state: "IN", zip: "46201" },
  { street: "1010 Beech Rd", city: "Kansas City", state: "MO", zip: "64101" },
  { street: "1111 Alder Ter", city: "Salt Lake City", state: "UT", zip: "84101" },
  { street: "1212 Fir Cir", city: "Richmond", state: "VA", zip: "23219" },
  { street: "1313 Laurel Ave", city: "Boise", state: "ID", zip: "83701" },
  { street: "1414 Palm St", city: "Tucson", state: "AZ", zip: "85701" },
  { street: "1515 Olive Way", city: "Portland", state: "ME", zip: "04101" },
  { street: "1616 Ivy Ln", city: "Savannah", state: "GA", zip: "31401" },
  { street: "1717 Holly Dr", city: "Charleston", state: "SC", zip: "29401" },
  { street: "1818 Sage Ct", city: "Asheville", state: "NC", zip: "28801" },
  { street: "1919 Rosemary Pl", city: "Scottsdale", state: "AZ", zip: "85251" },
  { street: "2020 Thyme Rd", city: "Wilmington", state: "NC", zip: "28401" },
  { street: "2121 Basil Ter", city: "Greenville", state: "SC", zip: "29601" },
  { street: "2222 Mint Ave", city: "Chattanooga", state: "TN", zip: "37402" },
  { street: "2323 Fennel St", city: "Bend", state: "OR", zip: "97701" },
  { street: "2424 Dill Way", city: "Bozeman", state: "MT", zip: "59715" },
  { street: "2525 Coriander Ln", city: "Traverse City", state: "MI", zip: "49684" },
  { street: "2626 Tarragon Dr", city: "Burlington", state: "VT", zip: "05401" },
  { street: "2727 Oregano Ct", city: "Sedona", state: "AZ", zip: "86336" },
  { street: "2828 Parsley Pl", city: "Park City", state: "UT", zip: "84060" },
  { street: "2929 Chive Rd", city: "Flagstaff", state: "AZ", zip: "86001" },
  { street: "3030 Sorrel Ter", city: "Durango", state: "CO", zip: "81301" },
  { street: "3131 Lavender Cir", city: "Santa Fe", state: "NM", zip: "87501" },
  { street: "3232 Jasmine Ave", city: "Napa", state: "CA", zip: "94559" },
  { street: "3333 Peony St", city: "Carmel", state: "IN", zip: "46032" },
  { street: "3434 Dahlia Way", city: "Hilton Head", state: "SC", zip: "29928" },
  { street: "3535 Orchid Ln", city: "Key West", state: "FL", zip: "33040" },
  { street: "3636 Tulip Dr", city: "Sedona", state: "AZ", zip: "86336" },
  { street: "3737 Iris Ct", city: "Aspen", state: "CO", zip: "81611" },
  { street: "3838 Lily Pl", city: "Telluride", state: "CO", zip: "81435" },
  { street: "3939 Violet Rd", city: "Steamboat Springs", state: "CO", zip: "80477" },
];

const PROPERTY_TYPES = ["single_family", "condo", "townhouse", "multi_family", "land"];
const STATUSES = ["active", "pending", "sold", "coming_soon"];
const DESCRIPTIONS = [
  "Beautiful home with updated kitchen and hardwood floors throughout.",
  "Charming property in a quiet neighborhood with mature trees and a large backyard.",
  "Modern living with open floor plan, high ceilings, and natural light.",
  "Move-in ready with new appliances, fresh paint, and updated bathrooms.",
  "Prime location near parks, schools, and shopping. Won't last long!",
  "Spacious layout with multiple living areas and generous closet space.",
  "Recently renovated with designer finishes and energy-efficient upgrades.",
  "Corner lot with mountain views and a private fenced backyard.",
];
const FEATURES_POOL = [
  "Hardwood floors", "Granite countertops", "Stainless steel appliances",
  "Central air", "Updated kitchen", "Walk-in closet", "Fireplace",
  "Covered patio", "Fenced yard", "Attached garage", "Finished basement",
  "Crown molding", "Vaulted ceilings", "Open floor plan",
];

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomPick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomFeatures(count) {
  const shuffled = [...FEATURES_POOL].sort(() => Math.random() - 0.5);
  return shuffled.slice(0, count);
}

const PRICE_RANGES = {
  single_family: [250000, 1200000],
  condo: [150000, 600000],
  townhouse: [200000, 800000],
  multi_family: [400000, 1500000],
  land: [50000, 500000],
};

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Generate sample listings using the real ingestion pipeline.
 *
 * @param {string} clientId
 * @param {number} count — number of listings to create (max 50)
 * @param {object} [options]
 * @param {string[]} [options.statuses] — filter to specific statuses
 * @param {string[]} [options.propertyTypes] — filter to specific property types
 * @returns {Promise<{ created: number, listings: object[] }>}
 */
export async function generateSampleListings(clientId, count = 5, options = {}) {
  const max = Math.min(count, 50);
  const statuses = options.statuses?.length ? options.statuses : STATUSES;
  const propertyTypes = options.propertyTypes?.length ? options.propertyTypes : PROPERTY_TYPES;

  const results = [];

  for (let i = 0; i < max; i++) {
    const addr = SAMPLE_ADDRESSES[i % SAMPLE_ADDRESSES.length];
    const propType = randomPick(propertyTypes);
    const [minP, maxP] = PRICE_RANGES[propType] || [200000, 800000];

    const input = {
      street: addr.street,
      city: addr.city,
      state: addr.state,
      zip: addr.zip,
      price: randomInt(minP, maxP),
      status: randomPick(statuses),
      propertyType: propType,
      beds: randomInt(2, 5),
      baths: randomInt(1, 4),
      sqft: randomInt(800, 4500),
      yearBuilt: randomInt(1960, 2024),
      garage: randomInt(0, 3),
      features: randomFeatures(randomInt(3, 6)),
      description: randomPick(DESCRIPTIONS),
    };

    try {
      const result = await ingestManualListing(clientId, input);
      results.push(result.listing);
    } catch (err) {
      console.warn(`[Simulator] Failed to create listing ${i + 1}:`, err.message);
    }
  }

  return { created: results.length, listings: results };
}

/**
 * Simulate a lifecycle event on an existing listing.
 *
 * @param {string} clientId
 * @param {string} listingId
 * @param {string} eventType — "price_drop" | "status_change" | "age" | "mark_new"
 * @param {object} data — event-specific data
 * @returns {Promise<{ listing: object, event: string }>}
 */
export async function simulateListingEvent(clientId, listingId, eventType, data = {}) {
  const item = await prisma.workspaceDataItem.findFirst({
    where: { id: listingId, clientId, status: "ACTIVE" },
  });

  if (!item) {
    throw Object.assign(new Error("Listing not found"), { status: 404 });
  }

  let dj = { ...item.dataJson };

  switch (eventType) {
    case "price_drop": {
      const newPrice = data.newPrice || Math.round((dj.price || 500000) * 0.9);
      const oldPrice = dj.price;
      dj = recordPriceChange(dj, newPrice, "manual");
      dj.price = newPrice;

      // Detect the event
      const events = detectIngestionEvents(dj, { ...dj, price: oldPrice });
      if (events.length > 0) {
        dj._events = appendEvents(dj._events || [], events);
      }
      break;
    }

    case "status_change": {
      const newStatus = data.newStatus || "pending";
      const oldStatus = dj.status;
      dj = recordStatusChange(dj, newStatus);
      dj.status = newStatus;

      const events = detectIngestionEvents(dj, { ...dj, status: oldStatus });
      if (events.length > 0) {
        dj._events = appendEvents(dj._events || [], events);
      }
      break;
    }

    case "age": {
      const daysBack = data.days || 15;
      const aged = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000).toISOString();
      dj._listedAt = aged;
      dj._daysOnMarket = daysBack;

      // Update the createdAt on the record too
      await prisma.workspaceDataItem.update({
        where: { id: listingId },
        data: { createdAt: new Date(aged) },
      });
      break;
    }

    case "mark_new": {
      const now = new Date().toISOString();
      dj._listedAt = now;
      dj._daysOnMarket = 0;
      dj._events = appendEvents(dj._events || [], [{
        type: "new_listing",
        detectedAt: now,
        data: { listedAt: now },
      }]);
      break;
    }

    default:
      throw Object.assign(new Error(`Unknown event type: ${eventType}`), { status: 400 });
  }

  const updated = await prisma.workspaceDataItem.update({
    where: { id: listingId },
    data: { dataJson: dj },
  });

  return { listing: updated, event: eventType };
}
