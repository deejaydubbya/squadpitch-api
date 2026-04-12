// AI-powered data extraction engine.
//
// Converts raw content (text, HTML, CSV rows) into structured WorkspaceDataItem
// shapes using OpenAI structured output. All 11 DataItemType field shapes are
// encoded in the system prompt so the model knows what to extract.

import { generateStructuredContent } from "./generation/openai.provider.js";

const MAX_INPUT_BYTES = 500_000; // 500KB
const EXTRACTION_TIMEOUT_MS = 90_000;
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

CUSTOM — Anything that doesn't fit above
  dataJson: { (any relevant key-value pairs) }
`;

const SYSTEM_PROMPT = `You are a data extraction engine for a content marketing platform. Your job is to analyze raw content and extract structured business data items that can be used to generate social media content.

${DATA_ITEM_TYPES_DESCRIPTION}

Rules:
- Extract as many distinct data items as the content supports (1-50 items)
- Each item MUST have a type, title, and relevant dataJson fields
- Set confidence (0.0-1.0) based on how well the content matches the type
- Assign relevant tags (1-5 per item)
- Set priority (0-10) based on content marketing value
- Write concise summaries (1-2 sentences) capturing the key message
- Titles should be compelling and specific, not generic
- If content is ambiguous, prefer more specific types over CUSTOM
- Do NOT fabricate data — only extract what's present in the content`;

const RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "extracted_data",
    strict: true,
    schema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              type: {
                type: "string",
                enum: [
                  "TESTIMONIAL", "CASE_STUDY", "PRODUCT_LAUNCH", "PROMOTION",
                  "STATISTIC", "MILESTONE", "FAQ", "TEAM_SPOTLIGHT",
                  "INDUSTRY_NEWS", "EVENT", "CUSTOM",
                ],
              },
              title: { type: "string" },
              summary: { type: "string" },
              dataJson: { type: "object", additionalProperties: true },
              tags: { type: "array", items: { type: "string" } },
              priority: { type: "number" },
              confidence: { type: "number" },
            },
            required: ["type", "title", "summary", "dataJson", "tags", "priority", "confidence"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    },
  },
};

/**
 * Parse raw content into structured data items using AI.
 *
 * @param {string} rawContent — the raw text to extract from
 * @param {{ hint?: string, sourceUrl?: string }} opts
 * @returns {Promise<Array<{ type, title, summary, dataJson, tags, priority, confidence }>>}
 */
export async function parseToStructuredData(rawContent, { hint, sourceUrl } = {}) {
  if (!rawContent || typeof rawContent !== "string") {
    return [];
  }

  // Truncate to bound token usage
  const truncated = rawContent.slice(0, MAX_INPUT_BYTES);

  let userPrompt = `Extract structured business data items from the following content:\n\n${truncated}`;
  if (sourceUrl) userPrompt += `\n\nSource URL: ${sourceUrl}`;
  if (hint) userPrompt += `\n\nAdditional context from user: ${hint}`;

  const result = await generateStructuredContent({
    systemPrompt: SYSTEM_PROMPT,
    userPrompt,
    responseFormat: RESPONSE_FORMAT,
    temperature: EXTRACTION_TEMPERATURE,
    timeoutMs: EXTRACTION_TIMEOUT_MS,
  });

  const items = result.parsed?.items;
  if (!Array.isArray(items)) return [];

  // Post-process: validate and clamp values
  return items
    .filter((item) => item.title && item.type)
    .map((item) => ({
      type: item.type,
      title: String(item.title).slice(0, 200),
      summary: item.summary ? String(item.summary).slice(0, 2000) : null,
      dataJson: item.dataJson && typeof item.dataJson === "object" ? item.dataJson : {},
      tags: Array.isArray(item.tags) ? item.tags.slice(0, 10).map((t) => String(t).slice(0, 100)) : [],
      priority: Math.max(0, Math.min(10, Math.round(Number(item.priority) || 0))),
      confidence: Math.max(0, Math.min(1, Number(item.confidence) || 0)),
    }));
}
