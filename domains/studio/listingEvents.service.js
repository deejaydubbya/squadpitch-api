// Listing Events Service — event detection, price/status history tracking,
// and stale listing evaluation for the listing intelligence layer.
//
// Events are stored in dataJson._events[] (append-only, deduplicated).
// Price/status history stored in dataJson._priceHistory[] / _statusHistory[].
// All mutations return the updated dataJson — callers persist it.

import { prisma } from "../../prisma.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const HISTORY_CAP = 20;

// ── Event Detection (Ingestion-time) ─────────────────────────────────────

/**
 * Detect events by comparing new vs previous dataJson during ingestion.
 * Called after create (previousDataJson=null) or update.
 *
 * @param {object} newDataJson
 * @param {object|null} previousDataJson — null for new listings
 * @returns {object[]} — array of event objects to append
 */
export function detectIngestionEvents(newDataJson, previousDataJson) {
  const events = [];
  const now = new Date().toISOString();

  if (!previousDataJson) {
    // New listing
    events.push({
      type: "new_listing",
      detectedAt: now,
      data: { listedAt: newDataJson._listedAt || now },
    });
  } else {
    // Price drop detection
    const oldPrice = previousDataJson.price;
    const newPrice = newDataJson.price;
    if (oldPrice && newPrice && newPrice < oldPrice) {
      const dropAmount = oldPrice - newPrice;
      const dropPercent = Math.round((dropAmount / oldPrice) * 100);
      if (dropPercent >= 1) {
        events.push({
          type: "price_drop",
          detectedAt: now,
          data: { oldPrice, newPrice, dropPercent, dropAmount },
        });
      }
    }

    // Status change detection
    const oldStatus = previousDataJson.status;
    const newStatus = newDataJson.status;
    if (oldStatus && newStatus && oldStatus !== newStatus) {
      events.push({
        type: "status_change",
        detectedAt: now,
        data: { oldStatus, newStatus },
      });
    }
  }

  return events;
}

// ── Event Detection (Daily Evaluation) ───────────────────────────────────

/**
 * Scan all active listings for stale_listing and not_promoted events.
 * Call periodically (daily) or via manual trigger.
 *
 * @param {string} clientId
 * @returns {Promise<{ evaluated: number, eventsCreated: number, listings: object[] }>}
 */
export async function evaluateStaleListings(clientId) {
  const items = await prisma.workspaceDataItem.findMany({
    where: { clientId, type: "CUSTOM", status: "ACTIVE" },
    select: { id: true, dataJson: true, usageCount: true, createdAt: true },
  });

  const now = new Date();
  const results = { evaluated: 0, eventsCreated: 0, listings: [] };

  for (const item of items) {
    const dj = item.dataJson || {};
    if (dj.status && dj.status !== "active") continue; // Only evaluate active listings

    results.evaluated++;
    const newEvents = [];
    const daysActive = computeDaysOnMarket(dj, item.createdAt);

    // Stale listing: active ≥14 days, no stale event in last 7 days
    if (daysActive >= 14) {
      const lastStale = (dj._events || [])
        .filter((e) => e.type === "stale_listing")
        .sort((a, b) => b.detectedAt.localeCompare(a.detectedAt))[0];

      const daysSinceLastStale = lastStale
        ? (now - new Date(lastStale.detectedAt)) / DAY_MS
        : Infinity;

      if (daysSinceLastStale >= 7) {
        newEvents.push({
          type: "stale_listing",
          detectedAt: now.toISOString(),
          data: { daysActive, daysSincePromotion: null },
        });
      }
    }

    // Not promoted: active ≥7 days, usageCount === 0
    if (daysActive >= 7 && (item.usageCount ?? 0) === 0) {
      const hasNotPromoted = (dj._events || []).some((e) => e.type === "not_promoted");
      if (!hasNotPromoted) {
        newEvents.push({
          type: "not_promoted",
          detectedAt: now.toISOString(),
          data: { daysActive },
        });
      }
    }

    if (newEvents.length > 0) {
      const updatedEvents = appendEvents(dj._events || [], newEvents);
      await prisma.workspaceDataItem.update({
        where: { id: item.id },
        data: {
          dataJson: { ...dj, _events: updatedEvents, _daysOnMarket: daysActive },
        },
      });
      results.eventsCreated += newEvents.length;
      results.listings.push({ id: item.id, events: newEvents });
    }
  }

  return results;
}

// ── History Helpers ──────────────────────────────────────────────────────

/**
 * Compute days on market from _listedAt or _statusHistory, falling back to createdAt.
 *
 * @param {object} dataJson
 * @param {Date} [createdAt] — fallback from the DB record
 * @returns {number}
 */
export function computeDaysOnMarket(dataJson, createdAt) {
  const listedAt = dataJson._listedAt
    ? new Date(dataJson._listedAt)
    : createdAt
      ? new Date(createdAt)
      : null;

  if (!listedAt) return 0;
  return Math.floor((Date.now() - listedAt.getTime()) / DAY_MS);
}

/**
 * Record a price change. Appends to _priceHistory and returns updated dataJson.
 *
 * @param {object} dataJson
 * @param {number} newPrice
 * @param {string} source — "manual" | "csv" | "url" | "listing_feed"
 * @returns {object} — updated dataJson (not persisted — caller saves)
 */
export function recordPriceChange(dataJson, newPrice, source) {
  const history = [...(dataJson._priceHistory || [])];
  const lastEntry = history[history.length - 1];

  // Skip if price hasn't actually changed
  if (lastEntry && lastEntry.price === newPrice) return dataJson;

  history.push({
    price: newPrice,
    recordedAt: new Date().toISOString(),
    source,
  });

  // Cap history
  while (history.length > HISTORY_CAP) history.shift();

  return { ...dataJson, _priceHistory: history };
}

/**
 * Record a status change. Appends to _statusHistory and returns updated dataJson.
 *
 * @param {object} dataJson
 * @param {string} newStatus
 * @returns {object} — updated dataJson (not persisted — caller saves)
 */
export function recordStatusChange(dataJson, newStatus) {
  const history = [...(dataJson._statusHistory || [])];
  const lastEntry = history[history.length - 1];

  // Skip if status hasn't actually changed
  if (lastEntry && lastEntry.status === newStatus) return dataJson;

  history.push({
    status: newStatus,
    recordedAt: new Date().toISOString(),
  });

  while (history.length > HISTORY_CAP) history.shift();

  return { ...dataJson, _statusHistory: history };
}

// ── Event Array Helpers ──────────────────────────────────────────────────

/**
 * Append events with deduplication.
 * Dedup rule: same type within 60 minutes is considered duplicate.
 */
export function appendEvents(existingEvents, newEvents) {
  const result = [...(existingEvents || [])];
  const DEDUP_WINDOW_MS = 60 * 60 * 1000; // 1 hour

  for (const evt of newEvents) {
    const isDupe = result.some(
      (e) =>
        e.type === evt.type &&
        Math.abs(new Date(e.detectedAt) - new Date(evt.detectedAt)) < DEDUP_WINDOW_MS
    );
    if (!isDupe) {
      result.push(evt);
    }
  }

  return result;
}

/**
 * Get events for a listing, optionally filtered by type.
 *
 * @param {object} dataJson
 * @param {string} [type] — filter by event type
 * @returns {object[]}
 */
export function getEvents(dataJson, type) {
  const events = dataJson?._events || [];
  if (!type) return events;
  return events.filter((e) => e.type === type);
}
