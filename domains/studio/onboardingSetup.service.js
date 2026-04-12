// Onboarding setup service — scrape website + AI brand extraction.
//
// Used by the onboarding flow to analyze a business URL or description
// and extract structured brand/voice data for workspace setup.

import * as cheerio from "cheerio";
import { generateStructuredContent } from "./generation/openai.provider.js";

const FETCH_TIMEOUT_MS = 15_000;
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

// ── Scrape ──────────────────────────────────────────────────────────────

/**
 * Fetch a URL and extract text content + metadata using cheerio.
 */
export async function scrapeWebsite(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw Object.assign(new Error("Invalid URL"), { status: 400 });
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw Object.assign(new Error("Only http/https URLs are supported"), { status: 400 });
  }

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

  const $ = cheerio.load(html);

  // Extract metadata before removing elements
  const title = $("title").first().text().trim() || "";
  const metaDescription =
    $('meta[name="description"]').attr("content")?.trim() ||
    $('meta[property="og:description"]').attr("content")?.trim() ||
    "";
  const ogImage =
    $('meta[property="og:image"]').attr("content")?.trim() || "";
  const images = [];
  $("img[src]").each((_, el) => {
    const src = $(el).attr("src");
    if (src) images.push(src);
  });

  // Extract text
  $("script, style, nav, footer, header, iframe, noscript").remove();
  let text = $("article").text() || $("main").text() || $("body").text();
  text = text.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH);

  if (text.length < 10) {
    throw Object.assign(new Error("Could not extract meaningful content from URL"), { status: 422 });
  }

  return { text, title, metaDescription, ogImage, images: images.slice(0, 20) };
}

// ── AI Extraction ──────────────────────────────────────────────────────

/**
 * Extract brand data from scraped website content via AI.
 */
export async function extractBrandData(content, { url } = {}) {
  let userPrompt = `Analyze the following website content and extract brand profile data:\n\n${content.slice(0, MAX_TEXT_LENGTH)}`;
  if (url) userPrompt += `\n\nSource URL: ${url}`;

  const result = await generateStructuredContent({
    systemPrompt: BRAND_EXTRACTION_SYSTEM_PROMPT,
    userPrompt,
    responseFormat: BRAND_EXTRACTION_FORMAT,
    temperature: EXTRACTION_TEMPERATURE,
    timeoutMs: EXTRACTION_TIMEOUT_MS,
  });

  return postProcess(result.parsed);
}

/**
 * Extract brand data from a text description via AI.
 */
export async function extractBrandFromText(description) {
  const userPrompt = `Analyze the following business description and extract brand profile data:\n\n${description.slice(0, MAX_TEXT_LENGTH)}`;

  const result = await generateStructuredContent({
    systemPrompt: BRAND_EXTRACTION_SYSTEM_PROMPT,
    userPrompt,
    responseFormat: BRAND_EXTRACTION_FORMAT,
    temperature: EXTRACTION_TEMPERATURE,
    timeoutMs: EXTRACTION_TIMEOUT_MS,
  });

  return postProcess(result.parsed);
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
