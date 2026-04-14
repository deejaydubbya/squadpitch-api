// Onboarding setup service — scrape website + AI brand extraction.
//
// Used by the onboarding flow to analyze a business URL or description
// and extract structured brand/voice data for workspace setup.

import { generateStructuredContent } from "./generation/openai.provider.js";
import { scrapeUrl } from "./scrapeUrl.js";
import { crawlWebsite } from "./crawlWebsite.js";
import { parseToStructuredData } from "./dataExtraction.service.js";
import { getExtractionHints } from "../industry/industry.service.js";

const MAX_TEXT_LENGTH = 500_000;
const EXTRACTION_TIMEOUT_MS = 60_000;
const EXTRACTION_TEMPERATURE = 0.3;

const BRAND_EXTRACTION_SYSTEM_PROMPT = `You are analyzing a business to extract brand profile data for a social media content platform. Extract as much useful information as possible from the provided content.

Return a JSON object with these fields:
- name: The business/brand name
- description: A concise 1-2 sentence description of what the business does
- industry: The industry or niche (e.g. "Fitness & Wellness", "SaaS", "E-commerce")
- audience: Who their target audience is
- offers: What products/services they offer (brief summary)
- competitors: 2-3 likely competitors (comma-separated), or empty string if unknown
- suggestedTone: A recommended voice tone for their social content (e.g. "Professional and authoritative", "Friendly and approachable")
- suggestedGoal: One of "growth", "engagement", or "leads" — whichever best fits this business
- suggestedChannels: Array of recommended social platforms from ["INSTAGRAM", "TIKTOK", "X", "LINKEDIN", "FACEBOOK", "YOUTUBE"] — pick 2-4 that best fit
- voiceRules: Object with "do" (array of 3 voice guidelines to follow) and "dont" (array of 3 things to avoid)
- contentBuckets: Array of 3-5 content categories, each with "key" (lowercase slug), "label" (display name), and "template" (one-line description of what content fits this bucket)

Be specific and actionable. Base suggestions on the actual business content, not generic advice.`;

const BRAND_EXTRACTION_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "brand_extraction",
    strict: true,
    schema: {
      type: "object",
      properties: {
        name: { type: "string" },
        description: { type: "string" },
        industry: { type: "string" },
        audience: { type: "string" },
        offers: { type: "string" },
        competitors: { type: "string" },
        suggestedTone: { type: "string" },
        suggestedGoal: { type: "string", enum: ["growth", "engagement", "leads"] },
        suggestedChannels: {
          type: "array",
          items: {
            type: "string",
            enum: ["INSTAGRAM", "TIKTOK", "X", "LINKEDIN", "FACEBOOK", "YOUTUBE"],
          },
        },
        voiceRules: {
          type: "object",
          properties: {
            do: { type: "array", items: { type: "string" } },
            dont: { type: "array", items: { type: "string" } },
          },
          required: ["do", "dont"],
          additionalProperties: false,
        },
        contentBuckets: {
          type: "array",
          items: {
            type: "object",
            properties: {
              key: { type: "string" },
              label: { type: "string" },
              template: { type: "string" },
            },
            required: ["key", "label", "template"],
            additionalProperties: false,
          },
        },
      },
      required: [
        "name",
        "description",
        "industry",
        "audience",
        "offers",
        "competitors",
        "suggestedTone",
        "suggestedGoal",
        "suggestedChannels",
        "voiceRules",
        "contentBuckets",
      ],
      additionalProperties: false,
    },
  },
};

const MAX_COMBINED_LENGTH = 600_000;

// ── Scrape ──────────────────────────────────────────────────────────────

/**
 * Fetch a URL and extract text content + metadata.
 * Uses Jina Reader for JS-rendered sites, falls back to direct fetch.
 */
export async function scrapeWebsite(url) {
  return scrapeUrl(url);
}

// ── Multi-source combine ────────────────────────────────────────────────

/**
 * Crawl/scrape + combine documents + text into one content blob for AI.
 *
 * Proportional budget: website 60%, documents 30%, text 10%.
 */
export async function crawlAndCombine({ url, text, documentTexts = [], onProgress }) {
  const sections = [];
  let images = [];

  // Website content
  if (url) {
    const crawled = await crawlWebsite(url, { onProgress });
    images = crawled.pages.flatMap((p) => p.images || []);
    for (const page of crawled.pages) {
      sections.push({
        source: "website",
        label: `Website page: ${page.url}`,
        content: page.text,
      });
    }
  }

  // Document content
  if (documentTexts.length > 0) {
    for (let i = 0; i < documentTexts.length; i++) {
      sections.push({
        source: "document",
        label: `Uploaded document ${i + 1}`,
        content: documentTexts[i],
      });
    }
  }

  // Text description
  if (text) {
    sections.push({
      source: "text",
      label: "Business description",
      content: text,
    });
  }

  // Proportional truncation — redistribute unused budgets to active sources
  const baseBudgets = { website: 0.6, document: 0.3, text: 0.1 };
  const grouped = { website: [], document: [], text: [] };
  for (const s of sections) grouped[s.source].push(s);

  // Redistribute budget from empty sources to active ones proportionally
  const activeSources = Object.keys(grouped).filter((k) => grouped[k].length > 0);
  const totalActiveBase = activeSources.reduce((sum, k) => sum + baseBudgets[k], 0);
  const budgets = {};
  for (const source of activeSources) {
    budgets[source] = baseBudgets[source] / totalActiveBase;
  }

  let combinedText = "";
  for (const source of activeSources) {
    const group = grouped[source];
    const budget = Math.floor(MAX_COMBINED_LENGTH * budgets[source]);
    const perItem = Math.floor(budget / group.length);
    for (const s of group) {
      const truncated = s.content.slice(0, perItem);
      combinedText += `\n\n--- ${s.label} ---\n${truncated}`;
    }
  }

  return { combinedText: combinedText.trim(), images };
}

// ── AI Extraction ──────────────────────────────────────────────────────

/**
 * Extract brand data from scraped website content via AI.
 */
export async function extractBrandData(content, { url, industryKey } = {}) {
  let userPrompt = `Analyze the following website content and extract brand profile data:\n\n${content.slice(0, MAX_TEXT_LENGTH)}`;
  if (url) userPrompt += `\n\nSource URL: ${url}`;

  const industryHints = getExtractionHints(industryKey);
  if (industryHints) {
    userPrompt += `\n\nNote: This business is in the ${industryKey.replace(/_/g, " ")} industry. Ensure your extraction reflects this.`;
  }

  const result = await generateStructuredContent({
    systemPrompt: BRAND_EXTRACTION_SYSTEM_PROMPT,
    userPrompt,
    responseFormat: BRAND_EXTRACTION_FORMAT,
    taskType: "parsing",
    temperature: EXTRACTION_TEMPERATURE,
    timeoutMs: EXTRACTION_TIMEOUT_MS,
  });

  return postProcess(result.parsed);
}

/**
 * Extract brand data from a text description via AI.
 */
export async function extractBrandFromText(description, { industryKey } = {}) {
  let userPrompt = `Analyze the following business description and extract brand profile data:\n\n${description.slice(0, MAX_TEXT_LENGTH)}`;

  const industryHints = getExtractionHints(industryKey);
  if (industryHints) {
    userPrompt += `\n\nNote: This business is in the ${industryKey.replace(/_/g, " ")} industry. Ensure your extraction reflects this.`;
  }

  const result = await generateStructuredContent({
    systemPrompt: BRAND_EXTRACTION_SYSTEM_PROMPT,
    userPrompt,
    responseFormat: BRAND_EXTRACTION_FORMAT,
    taskType: "parsing",
    temperature: EXTRACTION_TEMPERATURE,
    timeoutMs: EXTRACTION_TIMEOUT_MS,
  });

  return postProcess(result.parsed);
}

// ── Data Item Extraction ────────────────────────────────────────────────

/**
 * Extract structured data items (products, testimonials, FAQs, etc.)
 * from scraped content using the existing AI extraction pipeline.
 */
export async function extractDataItems(combinedText, { url, images, industryKey } = {}) {
  let hint = "Extract all products, inventory, services, testimonials, team members, FAQs, and any other structured business data";

  const industryHints = getExtractionHints(industryKey);
  if (industryHints) {
    hint += `\n\nIndustry-specific extraction focus (${industryKey}): ${industryHints.hints}`;
  }

  return parseToStructuredData(combinedText, {
    hint,
    sourceUrl: url,
    images,
  });
}

// ── Post-processing ────────────────────────────────────────────────────

function postProcess(data) {
  const VALID_CHANNELS = new Set(["INSTAGRAM", "TIKTOK", "X", "LINKEDIN", "FACEBOOK", "YOUTUBE"]);
  const VALID_GOALS = new Set(["growth", "engagement", "leads"]);

  return {
    name: String(data.name || "").slice(0, 120),
    description: String(data.description || "").slice(0, 5000),
    industry: String(data.industry || "").slice(0, 200),
    audience: String(data.audience || "").slice(0, 5000),
    offers: String(data.offers || "").slice(0, 5000),
    competitors: String(data.competitors || "").slice(0, 5000),
    suggestedTone: String(data.suggestedTone || "Professional and approachable"),
    suggestedGoal: VALID_GOALS.has(data.suggestedGoal) ? data.suggestedGoal : "growth",
    suggestedChannels: Array.isArray(data.suggestedChannels)
      ? data.suggestedChannels.filter((ch) => VALID_CHANNELS.has(ch)).slice(0, 6)
      : ["INSTAGRAM", "LINKEDIN"],
    voiceRules: {
      do: Array.isArray(data.voiceRules?.do)
        ? data.voiceRules.do.slice(0, 5).map((r) => String(r).slice(0, 500))
        : [],
      dont: Array.isArray(data.voiceRules?.dont)
        ? data.voiceRules.dont.slice(0, 5).map((r) => String(r).slice(0, 500))
        : [],
    },
    contentBuckets: Array.isArray(data.contentBuckets)
      ? data.contentBuckets.slice(0, 5).map((b) => ({
          key: String(b.key || "").replace(/[^a-z0-9_-]/g, "").slice(0, 40),
          label: String(b.label || "").slice(0, 120),
          template: String(b.template || "").slice(0, 2000),
        }))
      : [],
  };
}
