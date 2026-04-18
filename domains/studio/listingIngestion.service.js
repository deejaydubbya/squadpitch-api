// Property Ingestion Service — unified pipeline for importing property data
// from manual entry, CSV, and best-effort URL extraction.
//
// All sources → ONE normalized listing model → WorkspaceDataItems (type=CUSTOM)
//
// Pipeline: Source Adapters → Normalization → Validation → Deduplication → Storage

import { parse as csvParse } from "csv-parse/sync";
import { prisma } from "../../prisma.js";
import { scrapeUrl } from "./scrapeUrl.js";
import { stampSourceAttribution, RE_SOURCE_TYPES } from "../industry/realEstateAssets.js";
import {
  detectIngestionEvents,
  recordPriceChange,
  recordStatusChange,
  appendEvents,
} from "./listingEvents.service.js";
import { enrichListing } from "../industry/propertyEnrichment.service.js";

// ── Canonical Listing Fields ────────────────────────────────────────────────

const LISTING_STATUSES = ["active", "pending", "sold", "coming_soon", "off_market"];
const PROPERTY_TYPES = [
  "single_family", "condo", "townhouse", "multi_family", "land",
  "commercial", "apartment", "mobile_home", "farm", "other",
];

// ── Source Adapters ─────────────────────────────────────────────────────────

/**
 * ManualListingAdapter — accepts user-submitted form data.
 * Input is already partially structured.
 */
function adaptManualListing(input) {
  return {
    title: input.title || null,
    description: input.description || null,
    price: input.price || null,
    status: input.status || null,
    address: {
      street: input.street || input.address || null,
      city: input.city || null,
      state: input.state || null,
      zip: input.zip || null,
    },
    beds: input.beds || null,
    baths: input.baths || null,
    sqft: input.sqft || null,
    lotSize: input.lotSize || null,
    propertyType: input.propertyType || null,
    images: extractImageArray(input.images || input.imageUrl),
    listingUrl: input.listingUrl || null,
    agentName: input.agentName || null,
    brokerage: input.brokerage || null,
    yearBuilt: input.yearBuilt || null,
    garage: input.garage || null,
    features: input.features || null,
    sourceType: "manual",
    sourceId: null,
  };
}

/**
 * CsvListingAdapter — parses CSV rows using column mapping.
 * Returns array of partially structured listings.
 */
function adaptCsvListings(csvContent, { columnMapping }) {
  const records = csvParse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  const headers = records.length > 0 ? Object.keys(records[0]) : [];
  const m = columnMapping;

  const listings = records.map((row) => {
    const listing = {
      title: getCol(row, m.title),
      description: getCol(row, m.description),
      price: getCol(row, m.price),
      status: getCol(row, m.status),
      address: {
        street: getCol(row, m.street || m.address),
        city: getCol(row, m.city),
        state: getCol(row, m.state),
        zip: getCol(row, m.zip),
      },
      beds: getCol(row, m.beds || m.bedrooms),
      baths: getCol(row, m.baths || m.bathrooms),
      sqft: getCol(row, m.sqft || m.squareFootage),
      lotSize: getCol(row, m.lotSize),
      propertyType: getCol(row, m.propertyType),
      images: extractImageArray(getCol(row, m.images || m.imageUrl || m.photo)),
      listingUrl: getCol(row, m.listingUrl || m.url),
      agentName: getCol(row, m.agentName || m.agent),
      brokerage: getCol(row, m.brokerage),
      yearBuilt: getCol(row, m.yearBuilt),
      garage: getCol(row, m.garage),
      features: getCol(row, m.features),
      sourceType: "csv",
      sourceId: getCol(row, m.sourceId || m.mlsId || m.listingId),
    };
    return listing;
  });

  return { listings, headers, rowCount: records.length };
}

/**
 * UrlListingAdapter — scrapes a URL and extracts listing data.
 * Uses meta tags (og:title, og:image) + best-effort HTML parsing.
 */
async function adaptUrlListing(url) {
  const scraped = await scrapeUrl(url);
  const listing = extractListingFromScrapedData(scraped, url);
  listing.sourceType = "url";
  listing.listingUrl = url;
  return listing;
}

// ── Normalization ───────────────────────────────────────────────────────────

/**
 * Normalize adapter output into the canonical listing format.
 * Handles type coercion, address parsing, field cleaning.
 */
function normalizeListing(raw) {
  const street = raw.address?.street || null;
  const city = raw.address?.city || null;
  const state = raw.address?.state || null;
  const zip = raw.address?.zip || null;

  // Build title from address if missing
  const title = raw.title
    || buildAddressTitle(street, city, state)
    || null;

  const price = parseNumeric(raw.price);
  const beds = parseNumeric(raw.beds);
  const baths = parseNumeric(raw.baths);
  const sqft = parseNumeric(raw.sqft);
  const lotSize = raw.lotSize ? String(raw.lotSize).trim() : null;
  const yearBuilt = parseNumeric(raw.yearBuilt);
  const garage = parseNumeric(raw.garage);

  const status = normalizeStatus(raw.status);
  const propertyType = normalizePropertyType(raw.propertyType);
  const images = (raw.images || []).filter(Boolean).slice(0, 20);
  const description = raw.description ? String(raw.description).trim().slice(0, 5000) : null;
  const features = raw.features
    ? (Array.isArray(raw.features) ? raw.features : String(raw.features).split(/[,;|]/).map(s => s.trim())).filter(Boolean)
    : [];

  return {
    title: title ? String(title).slice(0, 200) : null,
    description,
    price,
    status,
    address: { street, city, state, zip },
    beds,
    baths,
    sqft,
    lotSize,
    propertyType,
    images,
    listingUrl: raw.listingUrl || null,
    agentName: raw.agentName ? String(raw.agentName).trim() : null,
    brokerage: raw.brokerage ? String(raw.brokerage).trim() : null,
    yearBuilt,
    garage,
    features,
    sourceType: raw.sourceType || "manual",
    sourceId: raw.sourceId || null,
  };
}

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Validate a normalized listing. Returns { valid, complete, issues[] }.
 * Required: title OR address, price OR description.
 * Incomplete listings are still allowed but flagged.
 */
function validateListing(listing) {
  const issues = [];

  const hasTitle = Boolean(listing.title);
  const hasAddress = Boolean(listing.address?.street || listing.address?.city);
  if (!hasTitle && !hasAddress) {
    issues.push("Missing title or address");
  }

  const hasPrice = listing.price != null && listing.price > 0;
  const hasDescription = Boolean(listing.description);
  if (!hasPrice && !hasDescription) {
    issues.push("Missing price or description");
  }

  const hasImage = listing.images?.length > 0;
  if (!hasImage) {
    issues.push("No images");
  }

  const valid = (hasTitle || hasAddress);
  const complete = valid && (hasPrice || hasDescription) && hasImage;

  return { valid, complete, issues };
}

// ── Deduplication ───────────────────────────────────────────────────────────

/**
 * Check for duplicate listings in the workspace.
 * Matches by: address, sourceId, or listingUrl.
 *
 * @returns {{ duplicate: boolean, existingId?: string }}
 */
async function checkDuplicate(clientId, listing) {
  const conditions = [];

  // Match by sourceId
  if (listing.sourceId) {
    conditions.push({
      dataJson: { path: ["sourceId"], equals: listing.sourceId },
    });
  }

  // Match by listingUrl
  if (listing.listingUrl) {
    conditions.push({
      dataJson: { path: ["listingUrl"], equals: listing.listingUrl },
    });
  }

  // Match by street address (normalized)
  const street = listing.address?.street?.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (street && street.length > 5) {
    // Can't do normalized comparison with Prisma JSON, so we fetch and compare
    const candidates = await prisma.workspaceDataItem.findMany({
      where: { clientId, type: { in: ["PROPERTY", "CUSTOM"] }, status: "ACTIVE" },
      select: { id: true, dataJson: true },
      take: 100,
    });

    for (const c of candidates) {
      const d = c.dataJson || {};
      const cStreet = (d.street || d.address || "").toLowerCase().replace(/[^a-z0-9]/g, "");
      if (cStreet && cStreet === street) {
        return { duplicate: true, existingId: c.id };
      }
    }
  }

  if (conditions.length > 0) {
    const existing = await prisma.workspaceDataItem.findFirst({
      where: {
        clientId,
        type: { in: ["PROPERTY", "CUSTOM"] },
        status: "ACTIVE",
        OR: conditions,
      },
      select: { id: true },
    });

    if (existing) {
      return { duplicate: true, existingId: existing.id };
    }
  }

  return { duplicate: false };
}

// ── Storage ─────────────────────────────────────────────────────────────────

/**
 * Convert a normalized listing into a WorkspaceDataItem shape.
 */
function listingToDataItem(listing) {
  const { address, sourceType, sourceId, title, description, ...rest } = listing;

  const dataJson = {
    // Listing-specific fields
    price: rest.price,
    status: rest.status,
    street: address?.street,
    city: address?.city,
    state: address?.state,
    zip: address?.zip,
    bedrooms: rest.beds,
    bathrooms: rest.baths,
    sqft: rest.sqft,
    lotSize: rest.lotSize,
    propertyType: rest.propertyType,
    imageUrl: rest.images?.[0] || null,
    images: rest.images,
    listingUrl: rest.listingUrl,
    agentName: rest.agentName,
    brokerage: rest.brokerage,
    yearBuilt: rest.yearBuilt,
    garage: rest.garage,
    features: rest.features,
    sourceId: sourceId || null,
  };

  // Remove null/undefined values
  for (const key of Object.keys(dataJson)) {
    if (dataJson[key] == null || (Array.isArray(dataJson[key]) && dataJson[key].length === 0)) {
      delete dataJson[key];
    }
  }

  // Initialize listing intelligence metadata
  const now = new Date().toISOString();

  // Track field sources based on source type
  const fieldSourceTag = sourceType || "manual";
  const _fieldSources = {};
  for (const key of Object.keys(dataJson)) {
    if (dataJson[key] != null) {
      _fieldSources[key] = fieldSourceTag;
    }
  }
  dataJson._fieldSources = _fieldSources;

  // Timestamp when listing first appeared
  dataJson._listedAt = now;

  // Initialize price history
  if (rest.price) {
    dataJson._priceHistory = [{ price: rest.price, recordedAt: now, source: fieldSourceTag }];
  }

  // Initialize status history
  if (rest.status) {
    dataJson._statusHistory = [{ status: rest.status, recordedAt: now }];
  }

  // Stamp source attribution — all listing pipeline imports use LISTING_FEED
  // except manual entry. URL imports are listings extracted from pages, not
  // general website content, so they belong in the listing feed pipeline.
  const sourceMap = {
    manual: RE_SOURCE_TYPES.MANUAL,
    csv: RE_SOURCE_TYPES.LISTING_FEED,
    url: RE_SOURCE_TYPES.LISTING_FEED,
    mls: RE_SOURCE_TYPES.LISTING_FEED,
  };
  const stampedDataJson = stampSourceAttribution(
    dataJson,
    sourceMap[sourceType] || RE_SOURCE_TYPES.MANUAL,
    { sourceUrl: rest.listingUrl }
  );

  // Build summary from available fields
  const summaryParts = [];
  if (rest.beds) summaryParts.push(`${rest.beds} bed`);
  if (rest.baths) summaryParts.push(`${rest.baths} bath`);
  if (rest.sqft) summaryParts.push(`${rest.sqft.toLocaleString()} sqft`);
  if (rest.price) summaryParts.push(`$${rest.price.toLocaleString()}`);
  const summary = summaryParts.length > 0
    ? summaryParts.join(" · ")
    : description?.slice(0, 200) || null;

  // Build tags
  const tags = [];
  if (rest.propertyType) tags.push(rest.propertyType.replace(/_/g, " "));
  if (rest.status) tags.push(rest.status);
  if (address?.city) tags.push(address.city);

  return {
    type: "PROPERTY",
    title: title || "Untitled Listing",
    summary,
    dataJson: stampedDataJson,
    tags: tags.slice(0, 5),
    priority: rest.status === "active" ? 5 : 2,
  };
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Ingest a single listing from manual entry.
 *
 * @param {string} clientId
 * @param {object} input — form fields
 * @returns {Promise<{ listing: object, created: boolean, existingId?: string }>}
 */
export async function ingestManualListing(clientId, input) {
  const raw = adaptManualListing(input);
  const normalized = normalizeListing(raw);
  const validation = validateListing(normalized);

  if (!validation.valid) {
    throw Object.assign(new Error(`Invalid listing: ${validation.issues.join(", ")}`), { status: 400 });
  }

  // Check for duplicates
  const dupe = await checkDuplicate(clientId, normalized);
  if (dupe.duplicate) {
    // Load existing for event comparison
    const existing = await prisma.workspaceDataItem.findUnique({
      where: { id: dupe.existingId },
      select: { dataJson: true },
    });
    const oldDataJson = existing?.dataJson || {};

    // Update existing listing
    const dataItem = listingToDataItem(normalized);
    let updatedDataJson = dataItem.dataJson;

    // Record price/status changes if they differ
    if (normalized.price && oldDataJson.price && normalized.price !== oldDataJson.price) {
      updatedDataJson = recordPriceChange(updatedDataJson, normalized.price, normalized.sourceType);
    }
    if (normalized.status && oldDataJson.status && normalized.status !== oldDataJson.status) {
      updatedDataJson = recordStatusChange(updatedDataJson, normalized.status);
    }

    // Preserve existing metadata from the old listing
    if (oldDataJson._listedAt) updatedDataJson._listedAt = oldDataJson._listedAt;
    if (oldDataJson._priceHistory && !updatedDataJson._priceHistory?.length) {
      updatedDataJson._priceHistory = oldDataJson._priceHistory;
    }
    if (oldDataJson._statusHistory && !updatedDataJson._statusHistory?.length) {
      updatedDataJson._statusHistory = oldDataJson._statusHistory;
    }
    if (oldDataJson._events) updatedDataJson._events = oldDataJson._events;
    if (oldDataJson._enrichedAt) {
      updatedDataJson._enrichedAt = oldDataJson._enrichedAt;
      updatedDataJson._enrichmentProvider = oldDataJson._enrichmentProvider;
    }

    // Detect events from the update
    const newEvents = detectIngestionEvents(updatedDataJson, oldDataJson);
    if (newEvents.length > 0) {
      updatedDataJson._events = appendEvents(updatedDataJson._events || [], newEvents);
    }

    const updated = await prisma.workspaceDataItem.update({
      where: { id: dupe.existingId },
      data: {
        title: dataItem.title,
        summary: dataItem.summary,
        dataJson: updatedDataJson,
        tags: dataItem.tags,
        priority: dataItem.priority,
      },
    });
    return { listing: updated, created: false, existingId: dupe.existingId };
  }

  // Create new
  const dataItem = listingToDataItem(normalized);

  // Detect new_listing event
  const newEvents = detectIngestionEvents(dataItem.dataJson, null);
  if (newEvents.length > 0) {
    dataItem.dataJson = { ...dataItem.dataJson, _events: newEvents };
  }

  const dataSource = await getOrCreateManualSource(clientId);

  const created = await prisma.workspaceDataItem.create({
    data: {
      clientId,
      dataSourceId: dataSource.id,
      ...dataItem,
    },
  });

  // Fire-and-forget auto-enrichment
  enrichListing(created).catch((err) =>
    console.warn("[listingIngestion] Auto-enrich failed:", err.message)
  );

  return { listing: created, created: true };
}

/**
 * Preview CSV for column mapping.
 *
 * @param {string} csvContent
 * @returns {{ headers: string[], rowCount: number, sampleRows: object[] }}
 */
export function previewListingCSV(csvContent) {
  if (!csvContent || csvContent.length < 5) {
    throw Object.assign(new Error("CSV content is too short"), { status: 400 });
  }
  if (csvContent.length > 5_000_000) {
    throw Object.assign(new Error("CSV exceeds 5MB limit"), { status: 400 });
  }

  const records = csvParse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  const headers = records.length > 0 ? Object.keys(records[0]) : [];
  const sampleRows = records.slice(0, 5);

  // Auto-detect column mapping
  const autoMapping = autoDetectColumns(headers);

  return { headers, rowCount: records.length, sampleRows, autoMapping };
}

/**
 * Ingest listings from CSV.
 *
 * @param {string} clientId
 * @param {string} csvContent
 * @param {{ columnMapping: object }} options
 * @returns {Promise<{ imported: number, updated: number, skipped: number, listings: object[] }>}
 */
export async function ingestCsvListings(clientId, csvContent, { columnMapping }) {
  const { listings: rawListings, headers, rowCount } = adaptCsvListings(csvContent, { columnMapping });

  const results = { imported: 0, updated: 0, skipped: 0, listings: [] };
  const dataSource = await getOrCreateCsvSource(clientId);

  for (const raw of rawListings) {
    const normalized = normalizeListing(raw);
    const validation = validateListing(normalized);

    if (!validation.valid) {
      results.skipped++;
      continue;
    }

    const dupe = await checkDuplicate(clientId, normalized);
    const dataItem = listingToDataItem(normalized);

    if (dupe.duplicate) {
      // Load existing for event comparison
      const existing = await prisma.workspaceDataItem.findUnique({
        where: { id: dupe.existingId },
        select: { dataJson: true },
      });
      const oldDataJson = existing?.dataJson || {};
      let updatedDataJson = dataItem.dataJson;

      // Record price/status changes
      if (normalized.price && oldDataJson.price && normalized.price !== oldDataJson.price) {
        updatedDataJson = recordPriceChange(updatedDataJson, normalized.price, normalized.sourceType);
      }
      if (normalized.status && oldDataJson.status && normalized.status !== oldDataJson.status) {
        updatedDataJson = recordStatusChange(updatedDataJson, normalized.status);
      }

      // Preserve existing metadata
      if (oldDataJson._listedAt) updatedDataJson._listedAt = oldDataJson._listedAt;
      if (oldDataJson._events) updatedDataJson._events = oldDataJson._events;
      if (oldDataJson._enrichedAt) {
        updatedDataJson._enrichedAt = oldDataJson._enrichedAt;
        updatedDataJson._enrichmentProvider = oldDataJson._enrichmentProvider;
      }

      // Detect events
      const newEvents = detectIngestionEvents(updatedDataJson, oldDataJson);
      if (newEvents.length > 0) {
        updatedDataJson._events = appendEvents(updatedDataJson._events || [], newEvents);
      }

      const updated = await prisma.workspaceDataItem.update({
        where: { id: dupe.existingId },
        data: {
          title: dataItem.title,
          summary: dataItem.summary,
          dataJson: updatedDataJson,
          tags: dataItem.tags,
          priority: dataItem.priority,
        },
      });
      results.updated++;
      results.listings.push(updated);
    } else {
      // Detect new_listing event
      const newEvents = detectIngestionEvents(dataItem.dataJson, null);
      if (newEvents.length > 0) {
        dataItem.dataJson = { ...dataItem.dataJson, _events: newEvents };
      }

      const created = await prisma.workspaceDataItem.create({
        data: {
          clientId,
          dataSourceId: dataSource.id,
          ...dataItem,
        },
      });

      // Fire-and-forget auto-enrichment
      enrichListing(created).catch((err) =>
        console.warn("[listingIngestion] CSV auto-enrich failed:", err.message)
      );

      results.imported++;
      results.listings.push(created);
    }
  }

  return results;
}

/**
 * Ingest a listing from a URL (best-effort scraping).
 *
 * @param {string} clientId
 * @param {string} url
 * @returns {Promise<{ listing: object, created: boolean, preview: object }>}
 */
export async function ingestUrlListing(clientId, url) {
  const raw = await adaptUrlListing(url);
  const normalized = normalizeListing(raw);
  const validation = validateListing(normalized);
  const quality = assessExtractionQuality(normalized);

  // Return preview data even if incomplete — user can fill gaps
  const preview = {
    ...normalized,
    validation,
  };

  return { preview, normalized, quality };
}

/**
 * Confirm and save a URL-imported listing after user review.
 *
 * @param {string} clientId
 * @param {object} listing — normalized listing (possibly edited by user)
 * @returns {Promise<{ listing: object, created: boolean }>}
 */
export async function confirmUrlListing(clientId, listing) {
  const normalized = normalizeListing(listing);
  normalized.sourceType = "url";

  const dupe = await checkDuplicate(clientId, normalized);
  const dataItem = listingToDataItem(normalized);

  if (dupe.duplicate) {
    // Load existing for event comparison
    const existing = await prisma.workspaceDataItem.findUnique({
      where: { id: dupe.existingId },
      select: { dataJson: true },
    });
    const oldDataJson = existing?.dataJson || {};
    let updatedDataJson = dataItem.dataJson;

    // Record price/status changes
    if (normalized.price && oldDataJson.price && normalized.price !== oldDataJson.price) {
      updatedDataJson = recordPriceChange(updatedDataJson, normalized.price, normalized.sourceType);
    }
    if (normalized.status && oldDataJson.status && normalized.status !== oldDataJson.status) {
      updatedDataJson = recordStatusChange(updatedDataJson, normalized.status);
    }

    // Preserve existing metadata
    if (oldDataJson._listedAt) updatedDataJson._listedAt = oldDataJson._listedAt;
    if (oldDataJson._events) updatedDataJson._events = oldDataJson._events;
    if (oldDataJson._enrichedAt) {
      updatedDataJson._enrichedAt = oldDataJson._enrichedAt;
      updatedDataJson._enrichmentProvider = oldDataJson._enrichmentProvider;
    }

    // Detect events
    const newEvents = detectIngestionEvents(updatedDataJson, oldDataJson);
    if (newEvents.length > 0) {
      updatedDataJson._events = appendEvents(updatedDataJson._events || [], newEvents);
    }

    const updated = await prisma.workspaceDataItem.update({
      where: { id: dupe.existingId },
      data: {
        title: dataItem.title,
        summary: dataItem.summary,
        dataJson: updatedDataJson,
        tags: dataItem.tags,
        priority: dataItem.priority,
      },
    });
    return { listing: updated, created: false };
  }

  // Detect new_listing event
  const newEvents = detectIngestionEvents(dataItem.dataJson, null);
  if (newEvents.length > 0) {
    dataItem.dataJson = { ...dataItem.dataJson, _events: newEvents };
  }

  const dataSource = await getOrCreateUrlSource(clientId);
  const created = await prisma.workspaceDataItem.create({
    data: {
      clientId,
      dataSourceId: dataSource.id,
      ...dataItem,
    },
  });

  // Fire-and-forget auto-enrichment
  enrichListing(created).catch((err) =>
    console.warn("[listingIngestion] URL auto-enrich failed:", err.message)
  );

  return { listing: created, created: true };
}

// ── Extraction Quality Assessment ────────────────────────────────────────────

/**
 * Assess how much useful listing data was extracted from a URL scrape.
 * Returns a quality grade, score, extracted/missing field breakdown, and user guidance.
 *
 * @param {object} normalized — normalized listing from URL extraction
 * @returns {{ grade: string, score: number, extracted: string[], missing: string[], message: string }}
 */
function assessExtractionQuality(normalized) {
  // Weighted fields — more important fields score higher
  const fields = [
    { key: "price", weight: 3, label: "Price", check: () => normalized.price != null && normalized.price > 0 },
    { key: "address", weight: 3, label: "Address", check: () => Boolean(normalized.address?.street) },
    { key: "images", weight: 2, label: "Images", check: () => normalized.images?.length > 0 },
    { key: "beds", weight: 2, label: "Bedrooms", check: () => normalized.beds != null },
    { key: "baths", weight: 2, label: "Bathrooms", check: () => normalized.baths != null },
    { key: "sqft", weight: 1, label: "Square footage", check: () => normalized.sqft != null },
    { key: "description", weight: 1, label: "Description", check: () => Boolean(normalized.description) },
    { key: "title", weight: 1, label: "Title", check: () => Boolean(normalized.title) },
    { key: "propertyType", weight: 1, label: "Property type", check: () => Boolean(normalized.propertyType) },
    { key: "yearBuilt", weight: 1, label: "Year built", check: () => normalized.yearBuilt != null },
  ];

  const extracted = [];
  const missing = [];
  let earned = 0;
  let total = 0;

  for (const f of fields) {
    total += f.weight;
    if (f.check()) {
      earned += f.weight;
      extracted.push(f.label);
    } else {
      missing.push(f.label);
    }
  }

  const score = Math.round((earned / total) * 100);

  // Grade and message based on score
  let grade, message;
  if (score >= 70) {
    grade = "good";
    message = "We extracted most of the listing details. Review and edit anything that looks off.";
  } else if (score >= 40) {
    grade = "partial";
    message = "We could only extract some details from this page. You'll need to fill in the missing fields, or try adding this listing manually instead.";
  } else {
    grade = "poor";
    message = "This page didn't return much listing data. The site may block automated access or use a format we can't read. We recommend adding this listing manually or importing via CSV.";
  }

  return { grade, score, extracted, missing, message };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function parseNumeric(value) {
  if (value == null) return null;
  if (typeof value === "number") return value;
  const cleaned = String(value).replace(/[^0-9.]/g, "");
  const num = parseFloat(cleaned);
  return isNaN(num) ? null : num;
}

function extractImageArray(value) {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter(Boolean).map(String);
  const str = String(value).trim();
  if (!str) return [];
  // Could be comma-separated URLs or a single URL
  if (str.includes(",")) {
    return str.split(",").map((s) => s.trim()).filter(Boolean);
  }
  return [str];
}

function getCol(row, colName) {
  if (!colName) return null;
  const val = row[colName];
  return val !== undefined && val !== "" ? val : null;
}

function buildAddressTitle(street, city, state) {
  const parts = [street, city, state].filter(Boolean);
  return parts.length > 0 ? parts.join(", ") : null;
}

function normalizeStatus(status) {
  if (!status) return "active";
  const lower = String(status).toLowerCase().replace(/[^a-z_]/g, "");
  if (LISTING_STATUSES.includes(lower)) return lower;
  if (lower.includes("sold")) return "sold";
  if (lower.includes("pending") || lower.includes("contract")) return "pending";
  if (lower.includes("coming")) return "coming_soon";
  return "active";
}

function normalizePropertyType(type) {
  if (!type) return null;
  const lower = String(type).toLowerCase().replace(/[\s-]+/g, "_");
  if (PROPERTY_TYPES.includes(lower)) return lower;
  if (lower.includes("single") || lower.includes("house") || lower.includes("detach")) return "single_family";
  if (lower.includes("condo")) return "condo";
  if (lower.includes("town")) return "townhouse";
  if (lower.includes("multi") || lower.includes("duplex") || lower.includes("triplex")) return "multi_family";
  if (lower.includes("land") || lower.includes("lot")) return "land";
  if (lower.includes("commercial")) return "commercial";
  if (lower.includes("apart")) return "apartment";
  if (lower.includes("mobile") || lower.includes("manufactured")) return "mobile_home";
  if (lower.includes("farm") || lower.includes("ranch")) return "farm";
  return "other";
}

/**
 * Auto-detect column mapping from CSV headers.
 */
function autoDetectColumns(headers) {
  const mapping = {};
  const lowerHeaders = headers.map((h) => h.toLowerCase().replace(/[\s_-]+/g, ""));

  const patterns = {
    title: ["title", "name", "listingtitle", "propertytitle", "heading"],
    description: ["description", "desc", "details", "remarks", "comments"],
    price: ["price", "listprice", "listingprice", "askingprice", "amount"],
    status: ["status", "listingstatus", "state"],
    street: ["street", "address", "streetaddress", "addr", "address1"],
    city: ["city", "town", "municipality"],
    state: ["state", "province", "region", "st"],
    zip: ["zip", "zipcode", "postalcode", "postal"],
    beds: ["beds", "bedrooms", "bed", "br", "numbed"],
    baths: ["baths", "bathrooms", "bath", "ba", "numbath"],
    sqft: ["sqft", "squarefeet", "squarefootage", "sqfootage", "area", "size"],
    lotSize: ["lotsize", "lot", "lotarea", "lotacres"],
    propertyType: ["propertytype", "type", "proptype", "hometype", "style"],
    imageUrl: ["image", "imageurl", "photo", "photourl", "pic", "thumbnail"],
    listingUrl: ["url", "link", "listingurl", "listinglink", "webpage"],
    agentName: ["agent", "agentname", "listedby", "realtor", "listingagent"],
    brokerage: ["brokerage", "broker", "office", "company", "firm"],
    yearBuilt: ["yearbuilt", "year", "built", "builtyear"],
    sourceId: ["mlsid", "mlsnumber", "listingid", "sourceid", "id"],
  };

  for (const [field, keywords] of Object.entries(patterns)) {
    const idx = lowerHeaders.findIndex((h) => keywords.includes(h));
    if (idx !== -1) {
      mapping[field] = headers[idx];
    }
  }

  return mapping;
}

/**
 * Extract listing data from scraped HTML/markdown content.
 * Uses meta tags (og:title, og:image) + best-effort text parsing.
 */
function extractListingFromScrapedData(scraped, url) {
  const listing = {
    title: null,
    description: null,
    price: null,
    status: null,
    address: { street: null, city: null, state: null, zip: null },
    beds: null,
    baths: null,
    sqft: null,
    lotSize: null,
    propertyType: null,
    images: [],
    listingUrl: url,
    agentName: null,
    brokerage: null,
    yearBuilt: null,
    garage: null,
    features: null,
    sourceType: "url",
    sourceId: null,
  };

  // Title from og:title / page title
  listing.title = scraped.title || null;

  // Images from og:image and scraped images
  if (scraped.ogImage) listing.images.push(scraped.ogImage);
  if (scraped.images) {
    for (const img of scraped.images) {
      if (!listing.images.includes(img) && listing.images.length < 20) {
        listing.images.push(img);
      }
    }
  }

  // Description from meta
  listing.description = scraped.metaDescription || null;

  // Best-effort extraction from text content
  const text = scraped.text || "";

  // Price: look for $xxx,xxx patterns
  const priceMatch = text.match(/\$[\d,]+(?:\.\d{2})?/);
  if (priceMatch) {
    listing.price = priceMatch[0];
  }

  // Beds/baths: look for "X bed" / "X bath" patterns
  const bedMatch = text.match(/(\d+)\s*(?:bed(?:room)?s?|BR)/i);
  if (bedMatch) listing.beds = bedMatch[1];

  const bathMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:bath(?:room)?s?|BA)/i);
  if (bathMatch) listing.baths = bathMatch[1];

  // Sqft
  const sqftMatch = text.match(/([\d,]+)\s*(?:sq\.?\s*ft|sqft|square\s*feet)/i);
  if (sqftMatch) listing.sqft = sqftMatch[1].replace(/,/g, "");

  // Year built
  const yearMatch = text.match(/(?:built\s+(?:in\s+)?|year\s*built:?\s*)(\d{4})/i);
  if (yearMatch) listing.yearBuilt = yearMatch[1];

  // Address: try to find address patterns (number + street name)
  const addressMatch = text.match(/(\d+\s+[A-Z][a-zA-Z]+(?:\s+[A-Z][a-zA-Z]+)*\s+(?:St|Ave|Blvd|Dr|Rd|Ln|Ct|Way|Pl|Cir|Terr?|Loop|Pike|Pkwy|Hwy)\.?)/);
  if (addressMatch) {
    listing.address.street = addressMatch[1];
  }

  return listing;
}

async function getOrCreateManualSource(clientId) {
  const existing = await prisma.workspaceDataSource.findFirst({
    where: { clientId, type: "MANUAL", name: "Manual listings" },
  });
  if (existing) return existing;
  return prisma.workspaceDataSource.create({
    data: { clientId, type: "MANUAL", name: "Manual listings" },
  });
}

async function getOrCreateCsvSource(clientId) {
  const existing = await prisma.workspaceDataSource.findFirst({
    where: { clientId, type: "CSV", name: "CSV listing import" },
  });
  if (existing) return existing;
  return prisma.workspaceDataSource.create({
    data: { clientId, type: "CSV", name: "CSV listing import" },
  });
}

async function getOrCreateUrlSource(clientId) {
  const existing = await prisma.workspaceDataSource.findFirst({
    where: { clientId, type: "URL", name: "URL listing import" },
  });
  if (existing) return existing;
  return prisma.workspaceDataSource.create({
    data: { clientId, type: "URL", name: "URL listing import" },
  });
}
