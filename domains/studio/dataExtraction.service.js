// AI-powered data extraction engine.
//
// Converts raw content (text, HTML, CSV rows) into structured WorkspaceDataItem
// shapes using OpenAI structured output. All 11 DataItemType field shapes are
// encoded in the system prompt so the model knows what to extract.
//
// Large content is automatically split into chunks and extracted in parallel,
// then deduplicated by title similarity.

import { generateStructuredContent } from "./generation/openai.provider.js";

const CHUNK_SIZE = 100_000; // ~35K tokens per chunk — faster completion, more incremental progress
const CHUNK_OVERLAP = 2_000; // overlap to avoid splitting items at boundaries
const MAX_CONCURRENT_CHUNKS = 3;
const EXTRACTION_TIMEOUT_MS = 120_000;
const EXTRACTION_TEMPERATURE = 0.3;

const DATA_ITEM_TYPES_DESCRIPTION = `
Available data item types and their expected dataJson fields:

TESTIMONIAL — Customer quotes/reviews
  dataJson: { quote, author, role, company, rating (1-5) }

CASE_STUDY — Client success stories
  dataJson: { client, challenge, solution, results, industry }

PRODUCT_LAUNCH — New product/feature announcements
  dataJson: { productName, launchDate, features, pricing, targetAudience }

PROMOTION — Sales, offers, discounts
  dataJson: { offerDetails, discount, validUntil, promoCode, terms }

STATISTIC — Key metrics and data points
  dataJson: { metric, value, context, source, timeframe }

MILESTONE — Company achievements
  dataJson: { achievement, date, significance }

FAQ — Frequently asked questions
  dataJson: { question, answer, category }

TEAM_SPOTLIGHT — Team member features
  dataJson: { name, role, bio, funFact }

INDUSTRY_NEWS — Relevant news/trends
  dataJson: { headline, source, publishedDate, relevance }

EVENT — Upcoming or past events
  dataJson: { eventName, date, location, description, registrationUrl }

CUSTOM — Anything that doesn't fit above (e.g. product listings, real estate, job postings, recipes, events)
  dataJson: { (any relevant key-value pairs that capture the structured data) }
`;

const SYSTEM_PROMPT = `You are a data extraction engine. Your job is to analyze raw content and extract structured data items.

${DATA_ITEM_TYPES_DESCRIPTION}

Type classification guidelines — ALWAYS prefer a specific type over CUSTOM:
- Product/service pages with prices, features, or specs → PRODUCT_LAUNCH
- Customer reviews, quotes, or star ratings → TESTIMONIAL
- Numbers, percentages, metrics, or data points → STATISTIC
- Sale prices, discounts, coupon codes, limited-time offers → PROMOTION
- Success stories, before/after comparisons, client results → CASE_STUDY
- Award wins, revenue milestones, anniversary celebrations → MILESTONE
- Q&A format, help docs, support articles → FAQ
- Employee bios, team pages, about-us profiles → TEAM_SPOTLIGHT
- News articles, trend reports, industry analysis → INDUSTRY_NEWS
- Events with dates, locations, registration links → EVENT
- ONLY use CUSTOM when none of the above types apply (e.g. real estate listings, job postings, recipes, directory entries)

Rules:
- Extract ALL distinct data items from the content — do not stop early. Extract every product, vehicle, listing, testimonial, team member, FAQ, etc.
- Each item MUST have a type, title, and relevant dataJson fields
- When the user provides a hint about what to extract, prioritize finding those items
- Set confidence (0.0-1.0) based on how well the content matches the type
- Do NOT fabricate data — only extract what's present in the content
- Titles should be compelling and specific, not generic

REQUIRED fields — every item MUST include ALL of these:
- summary: A 1-2 sentence description capturing the key selling point or message. NEVER leave this empty.
- tags: 2-5 relevant keyword tags (e.g. ["sedan", "toyota", "2024", "low-mileage"]). NEVER leave this empty.
- priority: 0-10 based on usefulness
- dataJson: Extract ALL available details into dataJson — not just name and price. Include every field present in the content (e.g. descriptions, specs, features, mileage, year, location, dates, quantities, conditions, categories).

Image association (REQUIRED when image URLs are provided):
- Match each item to its most relevant image URL from the provided list
- Set dataJson.imageUrl to that URL
- Use URL patterns, filenames, and proximity in the content to match images to items
- Every item should have an imageUrl if any plausible match exists

You MUST return a JSON object with an "items" array. Even if the content is unusual, extract what you can.`;

// Valid DataItemType enum values (must match Prisma schema)
const VALID_TYPES = new Set([
  "TESTIMONIAL", "CASE_STUDY", "PRODUCT_LAUNCH", "PROMOTION",
  "STATISTIC", "MILESTONE", "FAQ", "TEAM_SPOTLIGHT",
  "INDUSTRY_NEWS", "EVENT", "CUSTOM",
]);

// NOTE: dataJson has dynamic keys per item type, so we cannot use strict: true
// (OpenAI strict mode requires additionalProperties: false on all objects).
// We use json_object mode instead and describe the schema in the system prompt.
const RESPONSE_FORMAT = { type: "json_object" };

/**
 * Parse raw content into structured data items using AI.
 * Automatically chunks large content and runs parallel extractions.
 *
 * @param {string} rawContent — the raw text to extract from
 * @param {{ hint?: string, sourceUrl?: string, images?: string[], onProgress?: (items: Array) => void }} opts
 * @returns {Promise<Array<{ type, title, summary, dataJson, tags, priority, confidence }>>}
 */
export async function parseToStructuredData(rawContent, { hint, sourceUrl, images, onProgress } = {}) {
  if (!rawContent || typeof rawContent !== "string") {
    return [];
  }

  // Split into chunks if content exceeds single-call limit
  const chunks = splitIntoChunks(rawContent, CHUNK_SIZE, CHUNK_OVERLAP);
  console.log(`[dataExtraction] Content: ${rawContent.length} bytes → ${chunks.length} chunk(s)`);

  // Extract from all chunks in parallel, reporting progress as each completes
  const allItems = [];

  for (let i = 0; i < chunks.length; i += MAX_CONCURRENT_CHUNKS) {
    const batch = chunks.slice(i, i + MAX_CONCURRENT_CHUNKS);
    // Start batch and attach per-chunk progress callbacks
    await Promise.all(
      batch.map((chunk, j) =>
        extractFromChunk(chunk, {
          hint,
          sourceUrl,
          images,
          chunkIndex: i + j,
          totalChunks: chunks.length,
        }).then((items) => {
          allItems.push(...items);
          // Report progress as each individual chunk completes
          if (onProgress && allItems.length > 0) {
            onProgress(deduplicateItems(allItems));
          }
        })
      )
    );
  }

  // Deduplicate items that may appear in overlapping chunks
  const deduped = deduplicateItems(allItems);
  console.log(`[dataExtraction] Total: ${allItems.length} raw → ${deduped.length} after dedup`);

  return deduped;
}

/**
 * Split content into chunks, breaking at section boundaries (--- markers).
 */
function splitIntoChunks(content, chunkSize, overlap) {
  if (content.length <= chunkSize) {
    return [content];
  }

  const chunks = [];
  let offset = 0;

  while (offset < content.length) {
    let end = Math.min(offset + chunkSize, content.length);

    // Try to break at a section boundary (--- marker) near the end
    if (end < content.length) {
      const searchStart = Math.max(end - 5000, offset);
      const searchRegion = content.slice(searchStart, end);
      const lastBreak = searchRegion.lastIndexOf("\n---");
      if (lastBreak > 0) {
        end = searchStart + lastBreak;
      }
    }

    chunks.push(content.slice(offset, end));

    // If we reached the end, stop — don't create overlap micro-chunks
    if (end >= content.length) break;

    offset = end - overlap;
  }

  return chunks;
}

/**
 * Extract items from a single chunk.
 */
async function extractFromChunk(chunk, { hint, sourceUrl, images, chunkIndex, totalChunks }) {
  let userPrompt = "";
  if (hint) userPrompt += `IMPORTANT — The user wants to extract: ${hint}\n\n`;

  if (totalChunks > 1) {
    userPrompt += `(Processing chunk ${chunkIndex + 1} of ${totalChunks})\n\n`;
  }

  userPrompt += `Extract structured data items from the following content:\n\n${chunk}`;
  if (sourceUrl) userPrompt += `\n\nSource URL: ${sourceUrl}`;
  if (images && images.length > 0) {
    userPrompt += `\n\nImage URLs found on this page (associate with relevant items in dataJson.imageUrl):\n${images.slice(0, 30).join("\n")}`;
  }

  let result;
  try {
    result = await generateStructuredContent({
      systemPrompt: SYSTEM_PROMPT,
      userPrompt,
      responseFormat: RESPONSE_FORMAT,
      taskType: "parsing",
      temperature: EXTRACTION_TEMPERATURE,
      timeoutMs: EXTRACTION_TIMEOUT_MS,
    });
  } catch (err) {
    console.error(`[dataExtraction] Chunk ${chunkIndex + 1}/${totalChunks} failed:`, err.code, err.message, err.cause?.message);
    return [];
  }

  const parsed = result.parsed;

  // The model should return { items: [...] } but may use different keys
  let items = parsed?.items;
  if (!Array.isArray(items)) {
    items = parsed?.data || parsed?.results || parsed?.entries;
  }
  if (!Array.isArray(items) && Array.isArray(parsed)) {
    items = parsed;
  }

  if (!Array.isArray(items)) {
    console.warn(
      `[dataExtraction] Chunk ${chunkIndex + 1}/${totalChunks}: no items array. Keys:`,
      Object.keys(parsed ?? {}),
    );
    return [];
  }

  console.log(`[dataExtraction] Chunk ${chunkIndex + 1}/${totalChunks}: extracted ${items.length} items from ${chunk.length} bytes`);

  return items
    .filter((item) => item.title || item.name || item.heading)
    .map((item) => ({
      type: VALID_TYPES.has(item.type) ? item.type : "CUSTOM",
      title: String(item.title || item.name || item.heading).slice(0, 200),
      summary: item.summary ? String(item.summary).slice(0, 2000) : null,
      dataJson: item.dataJson && typeof item.dataJson === "object" ? item.dataJson : {},
      tags: Array.isArray(item.tags) ? item.tags.slice(0, 10).map((t) => String(t).slice(0, 100)) : [],
      priority: Math.max(0, Math.min(10, Math.round(Number(item.priority) || 0))),
      confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0)),
    }));
}

/**
 * Deduplicate items by normalized title similarity.
 * Keeps the version with higher priority/confidence.
 */
function deduplicateItems(items) {
  const seen = new Map(); // normalized title → best item

  for (const item of items) {
    const key = `${item.type}:${normalizeTitle(item.title)}`;
    const existing = seen.get(key);
    if (!existing) {
      seen.set(key, item);
    } else {
      // Keep the one with more data
      const existingScore = existing.priority + existing.confidence + Object.keys(existing.dataJson).length;
      const newScore = item.priority + item.confidence + Object.keys(item.dataJson).length;
      if (newScore > existingScore) {
        seen.set(key, item);
      }
    }
  }

  return Array.from(seen.values());
}

/**
 * Normalize a title for dedup comparison.
 */
function normalizeTitle(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
    .slice(0, 80);
}
