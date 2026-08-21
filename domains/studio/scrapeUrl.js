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

// Common image extensions for bare URL extraction
const IMAGE_EXTENSIONS = /\.(jpe?g|png|webp|avif|gif|bmp|tiff?)(\?[^\s)]*)?$/i;

// CDN domains commonly used for property/product images
const IMAGE_CDN_PATTERNS = [
  /rdcpix\.com/i,
  /zillowstatic\.com/i,
  /photos\.zillowstatic/i,
  /ssl\.cdn-redfin\.com/i,
  /media\.crmls\.org/i,
  /ap\.rdcpix\.com/i,
  /photos\.realtor\.com/i,
  /listhub\.s3\.amazonaws/i,
  /cbstatic\.com\/.*\/photo/i,
  /coldwellbanker\.com\/.*\/photo/i,
  /img\.cdnchk\.com/i,
];

// URL path segments that suggest an image (for CDN URLs without file extensions)
const IMAGE_PATH_SIGNALS = /\/(photo|photos|image|images|media|gallery|listing-photo|property-photo|img)\//i;

// Query params that indicate an image resize/transform
const IMAGE_QUERY_SIGNALS = /[?&](w|width|h|height|resize|crop|fit|auto=format|format=)/i;

/**
 * Test if a URL is likely an image — by extension, CDN domain, or path pattern.
 */
function looksLikeImageUrl(url) {
  if (IMAGE_EXTENSIONS.test(url)) return true;
  if (IMAGE_CDN_PATTERNS.some((p) => p.test(url))) return true;
  if (IMAGE_PATH_SIGNALS.test(url) && IMAGE_QUERY_SIGNALS.test(url)) return true;
  return false;
}

/**
 * Extract image URLs from JSON-LD structured data in HTML.
 * Handles SingleFamilyResidence, Product, RealEstateListing, etc.
 */
function extractJsonLdImages($) {
  const images = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($(el).html());
      collectImagesFromJsonLd(data, images);
    } catch {}
  });
  return images;
}

function collectImagesFromJsonLd(obj, images, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 10) return;
  if (Array.isArray(obj)) {
    for (const item of obj) collectImagesFromJsonLd(item, images, depth + 1);
    return;
  }

  // Fields that commonly hold image URLs or image objects
  const imageFields = ['image', 'photo', 'photos', 'thumbnail', 'logo', 'primaryImageOfPage', 'associatedMedia'];
  for (const field of imageFields) {
    const val = obj[field];
    if (!val) continue;
    if (typeof val === 'string') { images.push(val); continue; }
    if (Array.isArray(val)) {
      for (const item of val) {
        if (typeof item === 'string') images.push(item);
        else if (item?.url) images.push(item.url);
        else if (item?.contentUrl) images.push(item.contentUrl);
        else if (typeof item === 'object') collectImagesFromJsonLd(item, images, depth + 1);
      }
      continue;
    }
    if (val.url) images.push(val.url);
    else if (val.contentUrl) images.push(val.contentUrl);
    else if (typeof val === 'object') collectImagesFromJsonLd(val, images, depth + 1);
  }

  // Recurse into common nested structures
  for (const key of ['@graph', 'mainEntity', 'about', 'itemListElement', 'hasPart']) {
    if (obj[key]) collectImagesFromJsonLd(obj[key], images, depth + 1);
  }
}

/**
 * Extract image URLs from text/markdown — matches standard extensions,
 * known CDN domains, and image-like path/query patterns.
 */
function extractBareImageUrls(text) {
  const urls = [];
  const urlRegex = /https?:\/\/[^\s"'<>)\]]+/g;
  let match;
  while ((match = urlRegex.exec(text)) !== null) {
    const url = match[0].replace(/[.,;!]+$/, ''); // trim trailing punctuation
    if (looksLikeImageUrl(url)) {
      urls.push(url);
    }
  }
  return urls;
}

/**
 * Extract linked image URLs from markdown [text](url) patterns.
 * Captures images that appear as regular links rather than ![](url).
 */
function extractLinkedImageUrls(markdown) {
  const urls = [];
  const linkRegex = /\[.*?\]\((https?:\/\/[^\s)]+)\)/g;
  let match;
  while ((match = linkRegex.exec(markdown)) !== null) {
    const url = match[1];
    if (looksLikeImageUrl(url)) {
      urls.push(url);
    }
  }
  return urls;
}

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

  // Jina succeeded — enrich with JSON-LD images if the page has few markdown images
  if (jinaResult.ok) {
    if (extractLinks && jinaResult.data) {
      jinaResult.data.links = extractLinksFromMarkdown(jinaResult.rawMarkdown || "", origin);
    }
    // If Jina found few images, do a quick direct fetch for additional sources
    if (jinaResult.data && jinaResult.data.images.length < 5) {
      try {
        const quickRes = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            Accept: "text/html",
          },
          signal: AbortSignal.timeout(8000),
          redirect: "follow",
        });
        if (quickRes.ok) {
          const html = await quickRes.text();
          const $ = cheerio.load(html);
          const supplementalImgs = [];
          const resolveHref = (href) => {
            if (!href) return "";
            try { return new URL(href, url).toString(); } catch { return ""; }
          };
          // JSON-LD structured data
          supplementalImgs.push(...extractJsonLdImages($));
          // Standard img tags
          $("img[src]").each((_, el) => {
            const src = $(el).attr("src");
            if (src) supplementalImgs.push(resolveHref(src));
          });
          // Lazy-loaded images
          $("img[data-src], img[data-lazy-src], img[data-original]").each((_, el) => {
            const src = $(el).attr("data-src") || $(el).attr("data-lazy-src") || $(el).attr("data-original");
            if (src) supplementalImgs.push(resolveHref(src));
          });
          // noscript fallback images
          $("noscript").each((_, el) => {
            const inner = cheerio.load($(el).html() || "");
            inner("img[src]").each((_, img) => {
              const src = inner(img).attr("src");
              if (src) supplementalImgs.push(resolveHref(src));
            });
          });
          // Inline background-image CSS
          $("[style]").each((_, el) => {
            const style = $(el).attr("style") || "";
            const bgMatch = style.match(/background-image\s*:\s*url\(\s*['"]?(https?:\/\/[^'")\s]+)['"]?\s*\)/i);
            if (bgMatch) supplementalImgs.push(resolveHref(bgMatch[1]));
          });
          // Bare image URLs in HTML source (catches CDN URLs in scripts/data)
          for (const bareUrl of extractBareImageUrls($.html())) {
            supplementalImgs.push(bareUrl);
          }
          if (supplementalImgs.length > 0) {
            const existing = new Set(jinaResult.data.images);
            for (const img of supplementalImgs) {
              if (img && !existing.has(img) && !img.startsWith("data:") && !img.includes("1x1") && !img.includes("pixel")) {
                jinaResult.data.images.push(img);
                existing.add(img);
              }
            }
            // Re-cap at 100
            jinaResult.data.images = jinaResult.data.images.slice(0, 100);
          }
        }
      } catch {
        // Non-critical
      }
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
  const imageSet = new Set();
  const imgRegex = /!\[.*?\]\((https?:\/\/[^\s)]+)\)/g;
  let imgMatch;
  while ((imgMatch = imgRegex.exec(markdown)) !== null) {
    imageSet.add(imgMatch[1]);
  }

  // Also extract bare image URLs from the markdown text (gallery images
  // often appear as plain URLs rather than markdown image syntax)
  for (const bareUrl of extractBareImageUrls(markdown)) {
    imageSet.add(bareUrl);
  }

  // Extract linked image URLs from markdown [text](url) patterns
  // (galleries often render images as regular links, not ![](url))
  for (const linkedUrl of extractLinkedImageUrls(markdown)) {
    imageSet.add(linkedUrl);
  }
  const images = [...imageSet];

  // Extract og:image from Jina's metadata if present
  const ogMatch = markdown.match(/og:image[:\s]+(https?:\/\/[^\s]+)/i);
  const ogImage = ogMatch ? ogMatch[1] : "";

  // For Jina path, try to get a real icon since markdown doesn't include link[rel=icon]
  let logoUrl = ogImage;
  try {
    const origin = new URL(url).origin;
    logoUrl = await fetchBestIcon(origin) || ogImage;
  } catch {}

  return {
    ok: true,
    data: { text, title, metaDescription: "", ogImage, logoUrl, images: images.slice(0, 100) },
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

  // Extract logo/icon URL from link tags (best to worst)
  const resolveHref = (href) => {
    if (!href) return "";
    try { return new URL(href, url).toString(); } catch { return ""; }
  };
  const appleTouchIcon = resolveHref($('link[rel="apple-touch-icon"]').attr("href"));
  const iconPng = resolveHref($('link[rel="icon"][type="image/png"]').attr("href"));
  const iconAny = resolveHref($('link[rel="icon"]').attr("href")) ||
    resolveHref($('link[rel="shortcut icon"]').attr("href"));
  const logoUrl = appleTouchIcon || iconPng || iconAny || ogImage || "";

  const imageSet = new Set();

  // Standard img[src] tags
  $("img[src]").each((_, el) => {
    const src = $(el).attr("src");
    if (src) imageSet.add(resolveHref(src));
  });

  // Lazy-loaded images (data-src, data-lazy-src, data-original)
  $("img[data-src], img[data-lazy-src], img[data-original], img[data-lazy]").each((_, el) => {
    const src = $(el).attr("data-src") || $(el).attr("data-lazy-src") || $(el).attr("data-original") || $(el).attr("data-lazy");
    if (src) imageSet.add(resolveHref(src));
  });

  // srcset (take the largest resolution)
  $("img[srcset], source[srcset]").each((_, el) => {
    const srcset = $(el).attr("srcset");
    if (!srcset) return;
    const parts = srcset.split(",").map((s) => s.trim().split(/\s+/));
    // Take the last entry (typically highest resolution)
    const last = parts[parts.length - 1];
    if (last?.[0]) imageSet.add(resolveHref(last[0]));
  });

  // Images inside noscript tags (fallback for JS-loaded galleries)
  $("noscript").each((_, el) => {
    const inner = cheerio.load($(el).html() || "");
    inner("img[src]").each((_, img) => {
      const src = inner(img).attr("src");
      if (src) imageSet.add(resolveHref(src));
    });
  });

  // Inline background-image CSS (galleries sometimes use div backgrounds)
  $("[style]").each((_, el) => {
    const style = $(el).attr("style") || "";
    const bgMatch = style.match(/background-image\s*:\s*url\(\s*['"]?(https?:\/\/[^'")\s]+)['"]?\s*\)/i);
    if (bgMatch) imageSet.add(resolveHref(bgMatch[1]));
  });

  // JSON-LD structured data (property listings, products, etc.)
  const jsonLdImages = extractJsonLdImages($);
  for (const img of jsonLdImages) imageSet.add(resolveHref(img));

  // Extract bare image URLs from page text (catches CDN URLs in scripts/data attrs)
  const bodyText = $.html();
  for (const bareUrl of extractBareImageUrls(bodyText)) {
    imageSet.add(bareUrl);
  }

  // Filter out tiny icons, tracking pixels, and data URIs
  const images = [...imageSet].filter((u) =>
    u && !u.startsWith("data:") && !u.includes("1x1") && !u.includes("pixel") && u.length > 10
  );

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

  const result = { text, title, metaDescription, ogImage, logoUrl, images: images.slice(0, 100) };
  if (extractLinks) {
    result.links = extractLinksFromCheerio($, origin);
  }
  return result;
}

// ── Property image filter ─────────────────────────────────────────────────

// URL path/filename segments that indicate non-property images (junk)
const JUNK_SIGNALS =
  /(?:^|[\/_-])(logo|icon|favicon|avatar|badge|social|sprite|button|placeholder|spacer|widget|share|tracking|pixel|blank|agent|headshot|profile[_-]?pic|broker[_-]?photo)(?:[\/_.-]|$)/i;

// Tiny embedded dimensions like 50x50, 100x75 — both dims under 150
const TINY_DIMENSIONS = /(?:^|[\/_-])(\d{1,3})x(\d{1,3})(?:[\/_.-]|$)/;

// Small explicit width param: w= or width= under 200
const SMALL_WIDTH_PARAM = /[?&](?:w|width)=(\d+)/i;

// Domains that never contain property photos
const JUNK_DOMAINS = /(?:maps\.googleapis\.com|maps\.gstatic\.com|facebook\.com|instagram\.com|youtube\.com|linkedin\.com|twitter\.com|x\.com)/i;
const COLDWELL_UI_MEDIA = /^https?:\/\/s\.cbhomes\.com\/p\/i\//i;

// Image file extensions we actually want to download
const REAL_IMAGE_EXT = /\.(jpe?g|png|webp|avif|gif|bmp|tiff?)(\?[^\s)]*)?$/i;

/**
 * Filter out junk/non-property image URLs using path heuristics.
 * Removes logos, icons, agent headshots, map tiles, SVGs, social links,
 * and URLs that aren't actually images.
 *
 * @param {string[]} urls - Raw image URLs
 * @returns {string[]} Filtered URLs likely to be property/product photos
 */
export function filterPropertyImages(urls) {
  return urls.filter((url) => {
    if (!url) return false;

    // Must start with http(s) — skip data URIs, relative paths, etc.
    if (!url.startsWith("http")) return false;

    // Exclude known junk domains (maps, social media)
    if (JUNK_DOMAINS.test(url)) return false;

    // Coldwell's static /p/i/ tree contains logos, controls, CTA thumbnails,
    // placeholders, and other interface chrome rather than listing photos.
    if (COLDWELL_UI_MEDIA.test(url)) return false;

    // Exclude SVGs — always icons/illustrations, never photos
    if (/\.svg(\?|$)/i.test(url)) return false;

    // Check junk path signals
    if (JUNK_SIGNALS.test(url)) return false;

    // Check tiny embedded dimensions (both under 150)
    const dimMatch = url.match(TINY_DIMENSIONS);
    if (dimMatch) {
      const w = parseInt(dimMatch[1], 10);
      const h = parseInt(dimMatch[2], 10);
      if (w < 150 && h < 150) return false;
    }

    // Check small explicit width param
    const widthMatch = url.match(SMALL_WIDTH_PARAM);
    if (widthMatch) {
      const w = parseInt(widthMatch[1], 10);
      if (w < 200) return false;
    }

    // Must look like an actual image: has a real image extension, is on a
    // known image CDN, or has image-like path/query signals.
    if (REAL_IMAGE_EXT.test(url)) return true;
    if (IMAGE_CDN_PATTERNS.some((p) => p.test(url))) return true;
    if (IMAGE_PATH_SIGNALS.test(url) && IMAGE_QUERY_SIGNALS.test(url)) return true;
    // _next/image wrappers that proxy a real image CDN URL
    if (/\/_next\/image\?/.test(url) && IMAGE_CDN_PATTERNS.some((p) => p.test(decodeURIComponent(url)))) return true;

    return false;
  });
}

// ── Favicon / icon fetcher ────────────────────────────────────────────────

const ICON_CANDIDATES = [
  "/apple-touch-icon.png",
  "/apple-touch-icon-precomposed.png",
  "/favicon-32x32.png",
  "/favicon.ico",
];

async function fetchBestIcon(origin) {
  // Quick approach: fetch root HTML head and parse link[rel=icon] tags
  try {
    const res = await fetch(origin, {
      headers: { Accept: "text/html", "User-Agent": "Mozilla/5.0" },
      signal: AbortSignal.timeout(5000),
      redirect: "follow",
    });
    if (res.ok) {
      const html = await res.text();
      const $ = cheerio.load(html);
      const resolveHref = (href) => {
        if (!href) return "";
        try { return new URL(href, origin).toString(); } catch { return ""; }
      };
      const icon =
        resolveHref($('link[rel="apple-touch-icon"]').attr("href")) ||
        resolveHref($('link[rel="icon"][type="image/png"]').attr("href")) ||
        resolveHref($('link[rel="icon"]').attr("href")) ||
        resolveHref($('link[rel="shortcut icon"]').attr("href"));
      if (icon) return icon;
    }
  } catch {}

  // Fallback: probe well-known paths
  for (const path of ICON_CANDIDATES) {
    try {
      const res = await fetch(`${origin}${path}`, {
        method: "HEAD",
        signal: AbortSignal.timeout(3000),
        redirect: "follow",
      });
      if (res.ok) return `${origin}${path}`;
    } catch {}
  }
  return "";
}
