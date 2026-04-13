// Multi-page website crawler for onboarding.
//
// Discovers subpages via sitemap.xml + internal links, then scrapes
// up to 50 pages in parallel for richer brand extraction.

import { scrapeUrl } from "./scrapeUrl.js";

const SITEMAP_TIMEOUT_MS = 10_000;
const MAX_PAGES = 50;
const CONCURRENCY = 5;

// Paths that tend to have useful brand info, scored by priority.
const PRIORITY_PATTERNS = [
  /\/about/i,
  /\/services/i,
  /\/products/i,
  /\/inventory/i,
  /\/vehicles/i,
  /\/listings/i,
  /\/catalog/i,
  /\/shop/i,
  /\/store/i,
  /\/cars/i,
  /\/team/i,
  /\/pricing/i,
  /\/features/i,
  /\/solutions/i,
  /\/who-we-are/i,
  /\/what-we-do/i,
  /\/our-story/i,
];

/**
 * Crawl a website: scrape the root page + up to 9 subpages discovered
 * from sitemap.xml and internal links.
 *
 * @param {string} rootUrl
 * @param {{ maxPages?: number }} options
 * @returns {Promise<{ pages: Array<{ url: string, text: string, title: string, images: string[] }>, totalPages: number, failedPages: number }>}
 */
export async function crawlWebsite(rootUrl, { maxPages = MAX_PAGES, onProgress } = {}) {
  const origin = new URL(rootUrl).origin;

  // 1. Scrape root page (with link extraction)
  const rootResult = await scrapeUrl(rootUrl, { extractLinks: true });

  if (onProgress) {
    onProgress({ event: "crawl:page", url: rootUrl, title: rootResult.title, pageNum: 1, totalExpected: 1 });
  }

  // 2. Discover subpage URLs from sitemap + root page links
  const [sitemapUrls, linkUrls] = await Promise.all([
    fetchSitemapUrls(origin).catch(() => []),
    Promise.resolve(rootResult.links || []),
  ]);

  // Dedupe and filter to same origin, exclude root
  const seen = new Set([normalizeTrailingSlash(rootUrl)]);
  const candidates = [];

  for (const url of [...sitemapUrls, ...linkUrls]) {
    const normalized = normalizeTrailingSlash(url);
    if (seen.has(normalized)) continue;
    try {
      const parsed = new URL(normalized);
      if (parsed.origin !== origin) continue;
      // Skip anchors, assets, and common non-content paths
      if (parsed.hash && !parsed.pathname.slice(1)) continue;
      if (isAssetUrl(parsed.pathname)) continue;
      seen.add(normalized);
      candidates.push(normalized);
    } catch {
      continue;
    }
  }

  // 3. Score and sort by priority patterns
  candidates.sort((a, b) => scorePath(b) - scorePath(a));

  // 4. Take top N-1 subpages (root counts as 1)
  const subpageUrls = candidates.slice(0, maxPages - 1);

  const totalExpected = 1 + subpageUrls.length;
  if (onProgress && subpageUrls.length > 0) {
    onProgress({ event: "crawl:discovered", totalExpected });
  }

  // 5. Scrape subpages in parallel with concurrency limit
  let pageNum = 1; // root was 1
  const subpageResults = await scrapeWithConcurrency(subpageUrls, CONCURRENCY, (page) => {
    pageNum++;
    if (onProgress) {
      onProgress({ event: "crawl:page", url: page.url, title: page.title, pageNum, totalExpected });
    }
  });

  // 6. Assemble results
  const pages = [
    { url: rootUrl, text: rootResult.text, title: rootResult.title, images: rootResult.images },
  ];
  let failedPages = 0;

  for (const result of subpageResults) {
    if (result.status === "fulfilled" && result.value) {
      pages.push(result.value);
    } else {
      failedPages++;
    }
  }

  return { pages, totalPages: pages.length, failedPages };
}

// ── Sitemap parsing ───────────────────────────────────────────────────

async function fetchSitemapUrls(origin) {
  let xml;
  try {
    const res = await fetch(`${origin}/sitemap.xml`, {
      signal: AbortSignal.timeout(SITEMAP_TIMEOUT_MS),
      headers: { Accept: "application/xml, text/xml, */*" },
    });
    if (!res.ok) return [];
    xml = await res.text();
  } catch {
    return [];
  }

  // Extract <loc> entries via regex (avoids XML parser dependency)
  const urls = [];
  const locRegex = /<loc>\s*(https?:\/\/[^<]+?)\s*<\/loc>/gi;
  let match;
  while ((match = locRegex.exec(xml)) !== null) {
    urls.push(match[1]);
  }
  return urls;
}

// ── Helpers ───────────────────────────────────────────────────────────

function normalizeTrailingSlash(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    if (u.pathname.endsWith("/") && u.pathname.length > 1) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return url;
  }
}

const ASSET_EXTENSIONS = new Set([
  ".jpg", ".jpeg", ".png", ".gif", ".svg", ".webp", ".ico",
  ".css", ".js", ".map", ".woff", ".woff2", ".ttf", ".eot",
  ".pdf", ".zip", ".tar", ".gz", ".mp4", ".mp3", ".wav",
]);

function isAssetUrl(pathname) {
  const ext = pathname.slice(pathname.lastIndexOf(".")).toLowerCase();
  return ASSET_EXTENSIONS.has(ext);
}

function scorePath(url) {
  try {
    const pathname = new URL(url).pathname;
    for (let i = 0; i < PRIORITY_PATTERNS.length; i++) {
      if (PRIORITY_PATTERNS[i].test(pathname)) return PRIORITY_PATTERNS.length - i;
    }
  } catch {}
  return 0;
}

async function scrapeWithConcurrency(urls, concurrency, onPageDone) {
  const results = [];
  let index = 0;

  async function worker() {
    while (index < urls.length) {
      const i = index++;
      const url = urls[i];
      try {
        const scraped = await scrapeUrl(url);
        const page = { url, text: scraped.text, title: scraped.title, images: scraped.images };
        results[i] = { status: "fulfilled", value: page };
        if (onPageDone) onPageDone(page);
      } catch {
        results[i] = { status: "rejected", reason: `Failed to scrape ${url}` };
      }
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, urls.length) }, () => worker());
  await Promise.all(workers);
  return results;
}
