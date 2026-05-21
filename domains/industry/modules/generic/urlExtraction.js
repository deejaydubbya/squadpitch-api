// industry-04 — generic URL extractor.
//
// Used when a workspace pastes a URL and the industry doesn't
// have its own URL-extraction module. Wraps scrapeUrl() and
// returns a neutral preview shape — NO property/listing fields,
// NO MLS guesses, NO beds/baths assumptions.
//
// Used by:
//   - urlCampaignIntake.analyzeUrl for non-real-estate / no-
//     industry workspaces (returns this preview so the FE can
//     show "we pulled this from the URL" + offer "use as idea"
//     or future "save as content asset").
//   - Future industry modules can compose this with their own
//     domain-specific extraction.

import { scrapeUrl } from "../../../studio/scrapeUrl.js";

/**
 * Analyze a URL with no industry assumptions. Returns a neutral
 * structured preview suitable for any vertical.
 *
 * Failure-tolerant: if the scrape fails entirely, returns a
 * minimal stub with `confidence: 0` and a warning, rather than
 * throwing — the caller decides whether to surface the warning
 * or just route the user into a freeform idea flow.
 *
 * @param {string} url — already validated by
 *   urlCampaignIntake.assertSafeExternalUrl().
 * @returns {Promise<{
 *   kind: 'generic_url',
 *   url: string,
 *   title: string|null,
 *   description: string|null,
 *   siteName: string|null,
 *   ogImage: string|null,
 *   images: string[],
 *   bodySummary: string|null,
 *   links: string[],
 *   detectedBusinessName: string|null,
 *   confidence: number,
 *   warnings: string[],
 * }>}
 */
export async function analyzeGenericUrl(url) {
  let scraped;
  const warnings = [];
  try {
    scraped = await scrapeUrl(url, { extractLinks: true });
  } catch (err) {
    return {
      kind: "generic_url",
      url,
      title: null,
      description: null,
      siteName: null,
      ogImage: null,
      images: [],
      bodySummary: null,
      links: [],
      detectedBusinessName: null,
      confidence: 0,
      warnings: [`Could not scrape: ${err.message ?? "unknown error"}`],
    };
  }

  const title = nonEmpty(scraped.title);
  const description = nonEmpty(scraped.metaDescription);
  const ogImage = nonEmpty(scraped.ogImage);
  const images = Array.isArray(scraped.images) ? scraped.images.slice(0, 12) : [];
  const links = Array.isArray(scraped.links) ? scraped.links.slice(0, 50) : [];
  const bodySummary = summarizeBody(scraped.text);
  const siteName = deriveSiteName(url, title);
  const detectedBusinessName = deriveBusinessName({ title, siteName });

  // Confidence = simple heuristic: how much useful data did we
  // actually extract? Title + body text is the floor; description
  // and images are bonuses. Capped at 0.9 — we never claim
  // certainty for generic page extraction.
  let confidence = 0;
  if (title) confidence += 0.3;
  if (bodySummary) confidence += 0.3;
  if (description) confidence += 0.15;
  if (ogImage || images.length > 0) confidence += 0.15;
  confidence = Math.min(0.9, confidence);

  if (!title && !bodySummary) {
    warnings.push("Page didn't return a title or body text. The site may be blocking scrapers.");
  }

  return {
    kind: "generic_url",
    url,
    title,
    description,
    siteName,
    ogImage,
    images,
    bodySummary,
    links,
    detectedBusinessName,
    confidence,
    warnings,
  };
}

// ── helpers ──────────────────────────────────────────────────

function nonEmpty(s) {
  if (typeof s !== "string") return null;
  const trimmed = s.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function summarizeBody(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  // 600 chars is enough for the FE to show a meaningful "what's
  // on this page" snippet without paying for a full LLM summary.
  // Stop at a sentence boundary if possible.
  if (trimmed.length <= 600) return trimmed;
  const cut = trimmed.slice(0, 600);
  const lastSentence = cut.lastIndexOf(". ");
  if (lastSentence > 300) return cut.slice(0, lastSentence + 1);
  return cut + "…";
}

function deriveSiteName(url, title) {
  try {
    const parsed = new URL(url);
    // OG-style "Title | Site Name" / "Title - Site Name" → trailing chunk.
    if (title) {
      const sep = /[|\-–—·•] /;
      const parts = title.split(sep);
      if (parts.length > 1) {
        const candidate = parts[parts.length - 1].trim();
        if (candidate.length > 0 && candidate.length < 60) return candidate;
      }
    }
    // Fall back to the hostname (strip leading www.).
    return parsed.hostname.replace(/^www\./i, "");
  } catch {
    return null;
  }
}

function deriveBusinessName({ title, siteName }) {
  // Best guess: if the title looks like "Page Title | Brand", the
  // brand is siteName. Otherwise fall back to siteName (hostname).
  if (siteName && !looksLikeDomain(siteName)) return siteName;
  if (title && title.length < 80) {
    // Strip common "tagline – Brand" patterns: take the longest
    // chunk that looks like a brand name (no slashes, no dots).
    const candidate = title.split(/[|\-–—·•]/)[0].trim();
    if (candidate.length > 0 && candidate.length < 60) return candidate;
  }
  return siteName ?? null;
}

function looksLikeDomain(s) {
  return /\.[a-z]{2,}$/i.test(s);
}
