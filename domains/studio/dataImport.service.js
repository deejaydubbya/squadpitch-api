// Data import service — 5 extract functions + save.
//
// Each extract function returns a preview (does NOT save).
// saveImportedItems() persists reviewed items to the database.

import * as cheerio from "cheerio";
import { parse as csvParse } from "csv-parse/sync";
import { prisma } from "../../prisma.js";
import { parseToStructuredData } from "./dataExtraction.service.js";
import { readSheetRows } from "../integrations/providers/sheetsProvider.js";
import { readNotionPages } from "../integrations/providers/notionProvider.js";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_CSV_SIZE = 5_000_000; // 5MB
const MAX_TEXT_LENGTH = 500_000; // 500KB

// ── URL ──────────────────────────────────────────────────────────────────

/**
 * Fetch a URL, extract text content, and parse via AI.
 */
export async function extractFromUrl(url, { hint } = {}) {
  // Validate
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw Object.assign(new Error("Invalid URL"), { status: 400 });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw Object.assign(new Error("Only http/https URLs are supported"), { status: 400 });
  }

  // Fetch
  let html;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "SquadpitchBot/1.0 (content import)",
        Accept: "text/html,application/xhtml+xml,text/plain",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "follow",
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    html = await res.text();
  } catch (err) {
    if (err.name === "AbortError" || err.name === "TimeoutError") {
      throw Object.assign(new Error("URL request timed out"), { status: 408 });
    }
    throw Object.assign(new Error(`Failed to fetch URL: ${err.message}`), { status: 502 });
  }

  // Extract text
  const $ = cheerio.load(html);
  $("script, style, nav, footer, header, iframe, noscript").remove();

  let textSource = $("article").text() || $("main").text() || $("body").text();
  textSource = textSource.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH);

  if (textSource.length < 10) {
    throw Object.assign(new Error("Could not extract meaningful content from URL"), { status: 422 });
  }

  const items = await parseToStructuredData(textSource, { hint, sourceUrl: url });

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

  // Bulk create items
  const created = await prisma.workspaceDataItem.createMany({
    data: items.map((item) => ({
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

  return { created: created.count, dataSourceId: dataSource.id };
}
