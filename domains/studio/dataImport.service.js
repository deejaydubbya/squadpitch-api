// Data import service — 5 extract functions + save.
//
// Each extract function returns a preview (does NOT save).
// saveImportedItems() persists reviewed items to the database.

import { parse as csvParse } from "csv-parse/sync";
import { prisma } from "../../prisma.js";
import { parseToStructuredData } from "./dataExtraction.service.js";
import { scrapeUrl } from "./scrapeUrl.js";
import { readSheetRows } from "../integrations/providers/sheetsProvider.js";
import { readNotionPages } from "../integrations/providers/notionProvider.js";

const MAX_CSV_SIZE = 5_000_000; // 5MB
const MAX_TEXT_LENGTH = 500_000; // 500KB

// ── URL ──────────────────────────────────────────────────────────────────

/**
 * Fetch a URL, extract text content, and parse via AI.
 */
export async function extractFromUrl(url, { hint } = {}) {
  const { text, images } = await scrapeUrl(url);
  const items = await parseToStructuredData(text, { hint, sourceUrl: url, images });
  return { items, sourceUrl: url };
}

// ── Text ─────────────────────────────────────────────────────────────────

/**
 * Parse raw text via AI.
 */
export async function extractFromText(text, { hint } = {}) {
  if (!text || text.length < 10) {
    throw Object.assign(new Error("Text must be at least 10 characters"), { status: 400 });
  }

  const truncated = text.slice(0, MAX_TEXT_LENGTH);
  const items = await parseToStructuredData(truncated, { hint });

  return { items };
}

// ── CSV ──────────────────────────────────────────────────────────────────

/**
 * Preview CSV: parse and return headers + row count (no AI).
 */
export function previewCSV(csvContent) {
  if (!csvContent || csvContent.length < 5) {
    throw Object.assign(new Error("CSV content is too short"), { status: 400 });
  }
  if (csvContent.length > MAX_CSV_SIZE) {
    throw Object.assign(new Error("CSV content exceeds 5MB limit"), { status: 400 });
  }

  const records = csvParse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  const headers = records.length > 0 ? Object.keys(records[0]) : [];

  return { headers, rowCount: records.length };
}

/**
 * Extract CSV with column mapping — deterministic, no AI.
 */
export function extractFromCSV(csvContent, { columnMapping, defaultType = "CUSTOM" }) {
  if (!csvContent || csvContent.length < 5) {
    throw Object.assign(new Error("CSV content is too short"), { status: 400 });
  }

  const records = csvParse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
    relax_column_count: true,
  });

  const headers = records.length > 0 ? Object.keys(records[0]) : [];
  const { title, summary, type, tags, priority, dataJsonFields = [] } = columnMapping;

  const items = records.map((row) => {
    const itemTitle = title ? row[title] : null;
    if (!itemTitle) return null;

    // Build dataJson from unmapped + explicitly mapped columns
    const dataJson = {};
    const mappedCols = new Set([title, summary, type, tags, priority].filter(Boolean));
    for (const col of dataJsonFields) {
      if (row[col] !== undefined) {
        dataJson[col] = row[col];
        mappedCols.add(col);
      }
    }
    // Remaining unmapped columns go into dataJson
    for (const col of headers) {
      if (!mappedCols.has(col) && row[col] !== undefined && row[col] !== "") {
        dataJson[col] = row[col];
      }
    }

    const itemTags = tags && row[tags]
      ? row[tags].split(/[,;|]/).map((t) => t.trim()).filter(Boolean)
      : [];

    const itemPriority = priority && row[priority]
      ? Math.max(0, Math.min(10, parseInt(row[priority], 10) || 0))
      : 0;

    return {
      type: (type && row[type]) || defaultType,
      title: String(itemTitle).slice(0, 200),
      summary: summary && row[summary] ? String(row[summary]).slice(0, 2000) : null,
      dataJson,
      tags: itemTags.slice(0, 10),
      priority: itemPriority,
      confidence: 1.0, // deterministic mapping — full confidence
    };
  }).filter(Boolean);

  return { items, headers, rowCount: records.length };
}

// ── Google Sheets ────────────────────────────────────────────────────────

/**
 * Read rows from a Google Sheet and extract via AI.
 */
export async function extractFromGoogleSheets(integrationId, { spreadsheetId, sheetName, hint } = {}) {
  const { headers, rows } = await readSheetRows(integrationId, spreadsheetId, sheetName);

  if (rows.length === 0) {
    return { items: [], spreadsheetId, sheetName };
  }

  // Convert rows to text for AI processing
  const lines = rows.map((row) =>
    headers.map((h, i) => `${h}: ${row[i] ?? ""}`).join(", ")
  );
  const text = lines.join("\n").slice(0, MAX_TEXT_LENGTH);

  const items = await parseToStructuredData(text, { hint });

  return { items, spreadsheetId, sheetName };
}

// ── Notion ───────────────────────────────────────────────────────────────

/**
 * Read pages from a Notion database and extract via AI.
 */
export async function extractFromNotion(integrationId, { hint } = {}) {
  // Load integration config
  const integration = await prisma.integration.findUnique({
    where: { id: integrationId },
    select: { config: true },
  });
  if (!integration) {
    throw Object.assign(new Error("Integration not found"), { status: 404 });
  }

  const { pages } = await readNotionPages(integration.config, { limit: 100 });

  if (pages.length === 0) {
    return { items: [] };
  }

  // Convert pages to text for AI processing
  const lines = pages.map((page) =>
    Object.entries(page).map(([k, v]) => `${k}: ${v}`).join(", ")
  );
  const text = lines.join("\n").slice(0, MAX_TEXT_LENGTH);

  const items = await parseToStructuredData(text, { hint });

  return { items };
}

// ── Save ─────────────────────────────────────────────────────────────────

// Spinstr02 — keep PROPERTY rows unique at intake.
//
// The dedicated listingIngestion path already dedups by sourceId /
// listingUrl / normalized street address before insert
// (domains/studio/listingIngestion.service.js:checkDuplicate).
// The generic import path used by the Property Library UI bypassed
// that check and called createMany blindly, so the same listing
// imported via URL extraction + manual paste landed as two rows
// (e.g. "508 King George Court" — once with photos, once without).
// We now run the same family of dedup keys for PROPERTY items here.
// Non-PROPERTY items continue to bulk-insert unchanged: testimonials,
// FAQs, and other generic data may legitimately repeat.

function normalizePropertyKeySegment(value) {
  if (typeof value !== "string") return "";
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function streetFromPropertyTitle(title) {
  if (typeof title !== "string" || title.trim().length === 0) return "";
  return title.split(",")[0].trim();
}

function propertyDedupKey(item) {
  const data = (item?.dataJson && typeof item.dataJson === "object") ? item.dataJson : {};
  const ext = data.externalListingId ?? data.mlsId ?? data.mls_id ?? data.sourceId ?? data.external_id;
  if (typeof ext === "string" && ext.length > 0) return `ext:${ext}`;
  if (typeof ext === "number") return `ext:${ext}`;
  if (typeof data.listingUrl === "string" && data.listingUrl.length > 0) {
    return `url:${data.listingUrl.toLowerCase()}`;
  }
  const street =
    normalizePropertyKeySegment(data.street) ||
    normalizePropertyKeySegment(data.address) ||
    normalizePropertyKeySegment(streetFromPropertyTitle(item?.title)) ||
    normalizePropertyKeySegment(streetFromPropertyTitle(data.title));
  if (street && street.length > 5) return `addr:${street}`;
  const titleKey = normalizePropertyKeySegment(item?.title) || normalizePropertyKeySegment(data.title);
  if (titleKey && titleKey.length > 5) return `title:${titleKey}`;
  return null;
}

function mergePreferRicher(existingData, incomingData) {
  const merged = { ...(existingData ?? {}) };
  for (const [k, v] of Object.entries(incomingData ?? {})) {
    if (v == null || v === "") continue;
    const cur = merged[k];
    if (cur == null || cur === "") {
      merged[k] = v;
      continue;
    }
    if (Array.isArray(cur) && Array.isArray(v) && v.length > cur.length) {
      merged[k] = v;
    }
  }
  return merged;
}

/**
 * Save reviewed/confirmed items to the database.
 */
export async function saveImportedItems(clientId, { items, sourceType, sourceUrl }) {
  // Create data source
  const sourceName = sourceUrl
    ? `Import from ${new URL(sourceUrl).hostname}`
    : `${sourceType.replace("_", " ")} import`;

  const dataSource = await prisma.workspaceDataSource.create({
    data: {
      clientId,
      type: sourceType,
      name: sourceName,
    },
  });

  // Split PROPERTY items from the rest so dedup only touches
  // listings. Other types pass through unchanged.
  const propertyItems = [];
  const otherItems = [];
  for (const item of items) {
    if (item.type === "PROPERTY") propertyItems.push(item);
    else otherItems.push(item);
  }

  // Resolve PROPERTY duplicates against existing rows and within
  // this same batch.
  let propertyCreated = 0;
  let propertyMerged = 0;
  const seenKeys = new Map(); // dedup key → id of within-batch row we already created

  if (propertyItems.length > 0) {
    const existing = await prisma.workspaceDataItem.findMany({
      where: { clientId, type: "PROPERTY", status: "ACTIVE" },
      select: { id: true, title: true, dataJson: true },
      take: 500,
    });
    const existingByKey = new Map();
    for (const row of existing) {
      const k = propertyDedupKey(row);
      if (k && !existingByKey.has(k)) existingByKey.set(k, row);
    }

    for (const item of propertyItems) {
      const key = propertyDedupKey(item);
      const dupId = key ? (seenKeys.get(key) ?? existingByKey.get(key)?.id) : null;
      if (dupId) {
        const target = await prisma.workspaceDataItem.findUnique({
          where: { id: dupId },
          select: { dataJson: true },
        });
        const mergedData = mergePreferRicher(target?.dataJson ?? {}, item.dataJson ?? {});
        await prisma.workspaceDataItem.update({
          where: { id: dupId },
          data: { dataJson: mergedData },
        });
        propertyMerged += 1;
        continue;
      }
      const row = await prisma.workspaceDataItem.create({
        data: {
          clientId,
          dataSourceId: dataSource.id,
          type: item.type,
          title: item.title,
          summary: item.summary || null,
          dataJson: item.dataJson || {},
          tags: item.tags || [],
          priority: item.priority ?? 0,
          expiresAt: item.expiresAt ? new Date(item.expiresAt) : null,
        },
        select: { id: true },
      });
      propertyCreated += 1;
      if (key) seenKeys.set(key, row.id);
    }
  }

  // Bulk create the non-PROPERTY items unchanged.
  let otherCreated = 0;
  if (otherItems.length > 0) {
    const created = await prisma.workspaceDataItem.createMany({
      data: otherItems.map((item) => ({
        clientId,
        dataSourceId: dataSource.id,
        type: item.type,
        title: item.title,
        summary: item.summary || null,
        dataJson: item.dataJson || {},
        tags: item.tags || [],
        priority: item.priority ?? 0,
        expiresAt: item.expiresAt ? new Date(item.expiresAt) : null,
      })),
    });
    otherCreated = created.count;
  }

  // Fetch back created items so callers can get their IDs
  const savedItems = await prisma.workspaceDataItem.findMany({
    where: { dataSourceId: dataSource.id },
    select: { id: true, type: true, title: true },
    orderBy: { createdAt: "asc" },
  });

  return {
    created: propertyCreated + otherCreated,
    propertyMerged,
    dataSourceId: dataSource.id,
    items: savedItems,
  };
}
