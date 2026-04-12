// Shared URL scraper — Jina Reader with direct-fetch fallback.
//
// Jina Reader (r.jina.ai) renders JavaScript and returns clean markdown,
// which handles SPAs like Zillow, Airbnb, etc. If Jina is unavailable we
// fall back to a basic fetch + cheerio parse.

import * as cheerio from "cheerio";
import { env } from "../../config/env.js";

const JINA_TIMEOUT_MS = 30_000;
const DIRECT_TIMEOUT_MS = 15_000;
const MAX_TEXT_LENGTH = 500_000;

// User-friendly message for sites that block automated access
const BLOCKED_MSG =
  "This website blocks automated access. Try pasting the page content as text instead.";

/**
 * Scrape a URL and return extracted text + metadata.
 *
 * Tries Jina Reader first (handles JS-rendered pages), falls back to
 * direct fetch + cheerio if Jina fails.
 *
 * @param {string} url
 * @param {{ extractLinks?: boolean }} options
 * @returns {Promise<{ text: string, title: string, metaDescription: string, ogImage: string, images: string[], links?: string[] }>}
 */
export async function scrapeUrl(url, { extractLinks = false } = {}) {
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

  const origin = extractLinks ? parsed.origin : null;

  // Try Jina Reader first
  const jinaResult = await scrapeWithJina(url);

  // Jina succeeded — return the content
  if (jinaResult.ok) {
    if (extractLinks && jinaResult.data) {
      jinaResult.data.links = extractLinksFromMarkdown(jinaResult.rawMarkdown || "", origin);
    }
    return jinaResult.data;
  }

  // Jina says the site is blocked — surface the error directly
  if (jinaResult.blocked) {
    throw Object.assign(new Error(BLOCKED_MSG), { status: 422 });
  }

  // Jina failed for a non-blocking reason — try direct fetch
  try {
    return await scrapeDirectly(url, { extractLinks, origin });
  } catch (err) {
    // If direct fetch also gets a 4xx, the site is blocking us
    if (err.message?.includes("HTTP 4")) {
      throw Object.assign(new Error(BLOCKED_MSG), { status: 422 });
    }
    throw err;
  }
}

// ── Jina Reader ───────────────────────────────────────────────────────────

const BLOCKED_SIGNALS = [
  "returned error 403",
  "returned error 401",
  "requiring captcha",
  "access to this page has been denied",
  "access denied",
  "please verify you are a human",
  "are not a robot",
  "securitycompromiseerror",
  "ddos attack suspected",
  "blocked until",
];

async function scrapeWithJina(url) {
  let res;
  try {
    const headers = {
      Accept: "text/markdown",
      "X-Return-Format": "markdown",
    };
    if (env.JINA_API_KEY) {
      headers.Authorization = `Bearer ${env.JINA_API_KEY}`;
    }
    res = await fetch(`https://r.jina.ai/${url}`, {
      headers,
      signal: AbortSignal.timeout(JINA_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, blocked: false };
  }

  // Jina HTTP-level block (429, 451, etc.)
  if (res.status === 429 || res.status === 451) {
    return { ok: false, blocked: true };
  }

  if (!res.ok) {
    return { ok: false, blocked: false };
  }

  const markdown = await res.text();
  const lower = markdown.toLowerCase();

  // Check for block signals in the response body
  if (BLOCKED_SIGNALS.some((sig) => lower.includes(sig))) {
    return { ok: false, blocked: true };
  }

  const text = markdown.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_LENGTH);
  if (text.length < 10) {
    return { ok: false, blocked: false };
  }

  // Extract title from first markdown heading if present
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : "";

  // Extract image URLs from markdown ![alt](url) syntax
  const images = [];
  const imgRegex = /!\[.*?\]\((https?:\/\/[^\s)]+)\)/g;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(markdown)) !== null) {
    images.push(imgMatch[1]);
  }

  // Extract og:image from Jina's metadata if present
  const ogMatch = markdown.match(/og:image[:\s]+(https?:\/\/[^\s]+)/i);
  const ogImage = ogMatch ? ogMatch[1] : "";

  return {
    ok: true,
    data: { text, title, metaDescription: "", ogImage, images: images.slice(0, 50) },
    rawMarkdown: markdown,
  };
}

// ── Link extraction helpers ───────────────────────────────────────────────

const SKIP_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp", ".ico",
  ".css", ".js", ".map", ".woff", ".woff2", ".ttf", ".eot",
  ".pdf", ".zip", ".tar", ".gz", ".mp4", ".mp3",
]);

function shouldSkipLink(href) {
  if (!href || href.startsWith("#") || href.startsWith("mailto:") || href.startsWith("tel:")) return true;
  const ext = href.slice(href.lastIndexOf(".")).toLowerCase().split("?")[0];
  return SKIP_EXTENSIONS.has(ext);
}

function extractLinksFromMarkdown(markdown, origin) {
  if (!origin) return [];
  const links = new Set();
  const linkRegex = /\[.*?\]\((https?:\/\/[^\s)]+)\)/g;
  let m;
  while ((m = linkRegex.exec(markdown)) !== null) {
    const href = m[1];
    if (shouldSkipLink(href)) continue;
    try {
      const parsed = new URL(href);
      if (parsed.origin === origin) links.add(parsed.origin + parsed.pathname);
    } catch {}
  }
  return [...links];
}

function extractLinksFromCheerio($, origin) {
  if (!origin) return [];
  const links = new Set();
  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (shouldSkipLink(href)) return;
    try {
      const resolved = new URL(href, origin);
      if (resolved.origin === origin) links.add(resolved.origin + resolved.pathname);
    } catch {}
  });
  return [...links];
}

// ── Direct fetch + cheerio (fallback) ─────────────────────────────────────

async function scrapeDirectly(url, { extractLinks = false, origin = null } = {}) {
  let html;
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml,text/plain",
      },
      signal: AbortSignal.timeout(DIRECT_TIMEOUT_MS),
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
    throw Object.assign(
      new Error(`Failed to fetch URL: ${err.message}`),
      { status: 502 }
    );
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
    throw Object.assign(
      new Error("Could not extract meaningful content from URL"),
      { status: 422 }
    );
  }

  const result = { text, title, metaDescription, ogImage, images: images.slice(0, 20) };
  if (extractLinks) {
    result.links = extractLinksFromCheerio($, origin);
  }
  return result;
}
