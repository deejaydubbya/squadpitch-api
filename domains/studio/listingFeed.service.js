// Listing Feeds Service — multi-source listing management.
//
// Each listing source is a WorkspaceDataSource record with sync metadata
// in the `config` JSON field. All sources feed the same canonical listing
// pipeline (listingIngestion.service.js).
//
// Supported source types: URL, CSV, MANUAL (future: MLS, API)
//
// Config shape:
//   { sourceUrl, label, syncStatus, lastSyncedAt, lastError, isEnabled, listingCount }

import { prisma } from "../../prisma.js";
import * as importService from "./dataImport.service.js";
import { stampSourceAttribution, RE_SOURCE_TYPES } from "../industry/realEstateAssets.js";
import { runAutopilot } from "./autopilot.service.js";

// ── List sources ────────────────────────────────────────────────────────

/**
 * Get all listing sources for a workspace, with item counts.
 *
 * @param {string} clientId
 * @returns {Promise<object[]>}
 */
export async function getListingSources(clientId) {
  const sources = await prisma.workspaceDataSource.findMany({
    where: {
      clientId,
      // Only listing-related source types
      type: { in: ["URL", "CSV", "MANUAL"] },
      // Exclude non-listing sources (CRM, GBP sync sources) by checking name pattern
    },
    orderBy: { createdAt: "desc" },
    include: {
      _count: { select: { dataItems: true } },
    },
  });

  // Filter to listing sources (exclude CRM/GBP sync sources)
  const listingSources = sources.filter((s) => {
    const name = (s.name || "").toLowerCase();
    return !name.includes("crm") && !name.includes("gbp");
  });

  return listingSources.map((s) => {
    const cfg = s.config ?? {};
    return {
      id: s.id,
      name: s.name,
      type: s.type,
      sourceUrl: cfg.sourceUrl ?? null,
      syncStatus: cfg.syncStatus ?? "idle",
      lastSyncedAt: cfg.lastSyncedAt ?? null,
      lastError: cfg.lastError ?? null,
      isEnabled: cfg.isEnabled !== false,
      listingCount: s._count.dataItems,
      createdAt: s.createdAt,
      updatedAt: s.updatedAt,
    };
  });
}

// ── Create source ───────────────────────────────────────────────────────

/**
 * Create a new listing source.
 *
 * @param {string} clientId
 * @param {{ name: string, type: "URL" | "CSV" | "MANUAL", sourceUrl?: string }} input
 * @returns {Promise<object>}
 */
export async function createListingSource(clientId, { name, type, sourceUrl }) {
  const source = await prisma.workspaceDataSource.create({
    data: {
      clientId,
      type,
      name: name || defaultNameForType(type),
      config: {
        sourceUrl: sourceUrl || null,
        syncStatus: "idle",
        lastSyncedAt: null,
        lastError: null,
        isEnabled: true,
        listingCount: 0,
      },
    },
  });

  return formatSource(source);
}

// ── Update source ───────────────────────────────────────────────────────

/**
 * Update a listing source's name, URL, or enabled state.
 *
 * @param {string} clientId
 * @param {string} sourceId
 * @param {{ name?: string, sourceUrl?: string, isEnabled?: boolean }} patch
 * @returns {Promise<object>}
 */
export async function updateListingSource(clientId, sourceId, patch) {
  const existing = await prisma.workspaceDataSource.findFirst({
    where: { id: sourceId, clientId },
  });
  if (!existing) throw Object.assign(new Error("Source not found"), { status: 404 });

  const cfg = existing.config ?? {};
  const updatedConfig = { ...cfg };

  if (patch.sourceUrl !== undefined) updatedConfig.sourceUrl = patch.sourceUrl;
  if (patch.isEnabled !== undefined) updatedConfig.isEnabled = patch.isEnabled;

  const updated = await prisma.workspaceDataSource.update({
    where: { id: sourceId },
    data: {
      ...(patch.name !== undefined && { name: patch.name }),
      config: updatedConfig,
    },
  });

  return formatSource(updated);
}

// ── Sync source ─────────────────────────────────────────────────────────

/**
 * Sync a URL-type listing source: scrape the URL and upsert listings.
 *
 * @param {string} clientId
 * @param {string} sourceId
 * @returns {Promise<{ listingsFound: number, lastSyncedAt: string }>}
 */
export async function syncListingSource(clientId, sourceId) {
  const source = await prisma.workspaceDataSource.findFirst({
    where: { id: sourceId, clientId },
  });
  if (!source) throw Object.assign(new Error("Source not found"), { status: 404 });

  const cfg = source.config ?? {};
  if (!cfg.sourceUrl) {
    throw Object.assign(new Error("No URL configured for this source"), { status: 400 });
  }

  // Mark as syncing
  await prisma.workspaceDataSource.update({
    where: { id: sourceId },
    data: { config: { ...cfg, syncStatus: "syncing", lastError: null } },
  });

  try {
    const hint = "Extract property listings from this page. For each listing, extract: title/address, price, bedrooms, bathrooms, square footage, and image URL. Focus only on real estate property listings.";
    const { items: allItems } = await importService.extractFromUrl(cfg.sourceUrl, { hint });

    // Filter to CUSTOM type (listings) and cap at 20 per source
    const listings = allItems.filter((i) => i.type === "CUSTOM").slice(0, 20);

    // Stamp source attribution
    const stampedListings = listings.map((item) => ({
      ...item,
      dataJson: stampSourceAttribution(item.dataJson || {}, RE_SOURCE_TYPES.LISTING_FEED, {
        sourceUrl: cfg.sourceUrl,
        sourceConnectionId: sourceId,
      }),
    }));

    // Persist — use the source record as the data source
    if (stampedListings.length > 0) {
      await importService.saveImportedItems(clientId, {
        items: stampedListings,
        sourceType: source.type,
        sourceUrl: cfg.sourceUrl,
        dataSourceId: sourceId,
      });
    }

    const lastSyncedAt = new Date().toISOString();
    await prisma.workspaceDataSource.update({
      where: { id: sourceId },
      data: {
        config: {
          ...cfg,
          syncStatus: "synced",
          lastSyncedAt,
          lastError: null,
          listingCount: listings.length,
        },
      },
    });

    // Fire-and-forget autopilot
    if (listings.length > 0) {
      runAutopilot(clientId).catch(() => {});
    }

    return { listingsFound: listings.length, lastSyncedAt };
  } catch (err) {
    // Mark error
    await prisma.workspaceDataSource.update({
      where: { id: sourceId },
      data: {
        config: {
          ...cfg,
          syncStatus: "error",
          lastError: err.message || "Sync failed",
        },
      },
    }).catch(() => {});
    throw err;
  }
}

// ── Remove source ───────────────────────────────────────────────────────

/**
 * Remove a listing source and all its data items (cascade).
 *
 * @param {string} clientId
 * @param {string} sourceId
 * @returns {Promise<{ deleted: true, itemsRemoved: number }>}
 */
export async function removeListingSource(clientId, sourceId) {
  const source = await prisma.workspaceDataSource.findFirst({
    where: { id: sourceId, clientId },
    include: { _count: { select: { dataItems: true } } },
  });
  if (!source) throw Object.assign(new Error("Source not found"), { status: 404 });

  const itemsRemoved = source._count.dataItems;

  // Cascade delete removes all associated WorkspaceDataItems
  await prisma.workspaceDataSource.delete({ where: { id: sourceId } });

  return { deleted: true, itemsRemoved };
}

// ── Summary stats ───────────────────────────────────────────────────────

/**
 * Get aggregate stats across all listing sources.
 *
 * @param {string} clientId
 * @returns {Promise<{ sourceCount: number, totalListings: number, lastSyncedAt: string | null }>}
 */
export async function getListingFeedStats(clientId) {
  const sources = await getListingSources(clientId);
  const totalListings = sources.reduce((n, s) => n + s.listingCount, 0);
  const lastSynced = sources
    .filter((s) => s.lastSyncedAt)
    .sort((a, b) => new Date(b.lastSyncedAt) - new Date(a.lastSyncedAt));

  return {
    sourceCount: sources.length,
    totalListings,
    lastSyncedAt: lastSynced[0]?.lastSyncedAt ?? null,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function defaultNameForType(type) {
  switch (type) {
    case "URL": return "Listings URL";
    case "CSV": return "CSV Import";
    case "MANUAL": return "Manual Listings";
    default: return "Listing Source";
  }
}

function formatSource(source) {
  const cfg = source.config ?? {};
  return {
    id: source.id,
    name: source.name,
    type: source.type,
    sourceUrl: cfg.sourceUrl ?? null,
    syncStatus: cfg.syncStatus ?? "idle",
    lastSyncedAt: cfg.lastSyncedAt ?? null,
    lastError: cfg.lastError ?? null,
    isEnabled: cfg.isEnabled !== false,
    listingCount: cfg.listingCount ?? 0,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
  };
}
