// URL-01 — Campaign URL intake.
//
// Single backend workflow that takes a URL and tells the FE:
//   - Is this a single listing? An index of listings? A normal
//     business page? Unknown?
//   - When it's a listing, returns one or more preview rows the
//     user can review or pick from.
//   - When the user confirms, saves/updates the listing as a
//     WorkspaceDataItem and returns the dataItemId + a Create
//     assistant URL the FE can route to.
//
// Used by: dashboard quick-input, Create assistant URL source,
// Property Library, future onboarding flows. Reuses
// listingIngestion.ingestUrlListing + confirmUrlListing so we
// never duplicate normalization logic.

import crypto from "node:crypto";
import { prisma } from "../../prisma.js";
import { ingestUrlListing, confirmUrlListing } from "./listingIngestion.service.js";
import { scrapeUrl } from "./scrapeUrl.js";
// industry-04 — dispatch URL extraction through the industry
// module registry. Real-estate workspaces continue to use the
// listing extractor (preserves existing behavior); non-RE / no-
// industry workspaces use the neutral generic analyzer and
// never see property/listing fields.
import { getIndustryModuleOrGeneric } from "../industry/modules/index.js";

// Caps on the listing-index crawl path. Conservative on purpose —
// every analyze call is interactive (user typed a URL + is
// waiting) so we'd rather return a few clean previews than risk a
// 30-second crawl. Bump after we see how it behaves in prod.
const MAX_INDEX_CANDIDATES = 20;
const MAX_INDEX_PREVIEWS = 10;
const PER_PREVIEW_TIMEOUT_MS = 12_000;

// URL path patterns that strongly imply "this is a listing detail
// page". Generic enough to work across real-estate platforms
// (Zillow/Redfin/Realtor, MLS sites, agent sites, custom sites)
// and adjacent verticals (autos: /vehicles/, /inventory/). Order
// doesn't matter — first-match scoring.
const LISTING_PATH_PATTERNS = [
  /\/listing(?:s)?\/[^/]+/i,
  /\/property\/[^/]+/i,
  /\/properties\/[^/]+/i,
  /\/homedetails\//i,
  /\/homes?\/[^/]+/i,
  /\/for-sale\/[^/]+/i,
  /\/real-?estate\/[^/]+/i,
  /\/mls[/_-][^/]+/i,
  /\/detail\/[^/]+/i,
  /\/p\/[^/]+/i,
  /\/inventory\/[^/]+/i,
  /\/vehicle(?:s)?\/[^/]+/i,
  /\/auto\/[^/]+/i,
];

// ── Safe URL validation ────────────────────────────────────────

const PRIVATE_IPV4_RANGES = [
  // 10.0.0.0/8
  /^10\./,
  // 172.16.0.0/12
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  // 192.168.0.0/16
  /^192\.168\./,
  // 127.0.0.0/8 (loopback)
  /^127\./,
  // 169.254.0.0/16 (link-local)
  /^169\.254\./,
  // 100.64.0.0/10 (CG-NAT)
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "0.0.0.0",
  // IPv6 loopback + unspecified
  "::1",
  "::",
]);

export class UnsafeUrlError extends Error {
  constructor(message, reason) {
    super(message);
    this.status = 400;
    this.code = "UNSAFE_URL";
    this.reason = reason;
  }
}

// Validates a user-supplied URL is safe to fetch server-side.
// Rejects non-http(s) schemes, localhost / private IP ranges, and
// known-bad pseudo-schemes (javascript:, data:, file:). The
// returned URL is the parsed object so the caller doesn't have to
// re-parse.
//
// SECURITY: this is the only place server-side outbound fetches
// from user input should validate. Adding new fetch sites that
// take a user URL? Route through here first.
export function assertSafeExternalUrl(input) {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new UnsafeUrlError("URL is required", "missing");
  }
  const raw = input.trim();

  // Cheap pre-parse scheme blocklist — `new URL` would parse
  // these too, but the typed error message is friendlier.
  const lower = raw.toLowerCase();
  for (const bad of ["javascript:", "data:", "file:", "vbscript:"]) {
    if (lower.startsWith(bad)) {
      throw new UnsafeUrlError(`URLs with the ${bad} scheme are not allowed`, "scheme");
    }
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new UnsafeUrlError("URL is not parseable", "parse");
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new UnsafeUrlError(
      `Only http and https URLs are allowed (got ${parsed.protocol})`,
      "scheme",
    );
  }

  const host = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new UnsafeUrlError(`Host ${host} is not allowed`, "loopback");
  }

  // IPv4 private/loopback/link-local range blocks. Pure regex
  // check is sufficient because the URL parser normalizes the
  // host already.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    for (const range of PRIVATE_IPV4_RANGES) {
      if (range.test(host)) {
        throw new UnsafeUrlError(`Private IP ${host} is not allowed`, "private_ip");
      }
    }
  }

  // IPv6 fc00::/7 (unique local) is the rough IPv6 equivalent of
  // private IPv4 ranges. Block conservatively.
  if (host.startsWith("[fc") || host.startsWith("[fd") || host.startsWith("[fe80")) {
    throw new UnsafeUrlError(`Private IPv6 host ${host} is not allowed`, "private_ip");
  }

  return parsed;
}

// ── Analyze ────────────────────────────────────────────────────

// industry-01 — listing extraction is real-estate-only.
// industry-04 — non-RE workspaces now get a NEUTRAL generic
// preview (title / description / siteName / images / body
// summary) via the generic module's URL analyzer, so the user
// sees what's on the page and can route it into the idea flow.
// The listing extractor is never called for non-RE workspaces.
async function getWorkspaceIndustryKey(clientId) {
  if (!clientId) return null;
  const row = await prisma.client.findUnique({
    where: { id: clientId },
    select: { industryKey: true },
  });
  return row?.industryKey ?? null;
}

export async function analyzeUrl(clientId, { url, preferredIntent, singleListingOnly = false } = {}) {
  const parsed = assertSafeExternalUrl(url);
  const intent = preferredIntent === "single_post" || preferredIntent === "campaign"
    ? preferredIntent
    : null;

  const industryKey = await getWorkspaceIndustryKey(clientId);
  const industryModule = getIndustryModuleOrGeneric(industryKey);

  // industry-04 — non-RE workspaces route through the generic
  // analyzer. No property fields, no listing extractor calls;
  // just a neutral preview the user can use as a freeform idea
  // source. Listed as detectedType='generic_page' so the FE can
  // branch on it.
  if (industryModule.key !== "real_estate") {
    const generic = await industryModule.urlExtraction.analyze(parsed.toString());
    return {
      url: parsed.toString(),
      detectedType: "generic_page",
      confidence: generic.confidence,
      listings: [],
      genericPreview: generic,
      suggestedNextStep: "use_as_idea",
      preferredIntent: intent,
    };
  }

  // Strategy: try treating the URL as a single listing first. If
  // ingestUrlListing's extraction quality is "good" or better,
  // we're done — return one preview. Otherwise scrape with link
  // extraction so we can decide between listing_index and
  // business_page / unknown.
  const singleAttempt = await tryIngestSingle(clientId, parsed.toString());
  if (singleAttempt.confidence >= 0.6) {
    return {
      url: parsed.toString(),
      detectedType: "single_listing",
      confidence: singleAttempt.confidence,
      listings: [singleAttempt.preview],
      suggestedNextStep: "review_listing",
      preferredIntent: intent,
    };
  }

  // Automated prospect preparation already knows it was given a canonical
  // listing URL. Do not perform the same expensive scrape a second time just
  // to classify the page as an index/business page.
  if (singleListingOnly) {
    return {
      url: parsed.toString(),
      detectedType: singleAttempt.preview ? "single_listing" : "unknown",
      confidence: singleAttempt.confidence,
      listings: singleAttempt.preview ? [singleAttempt.preview] : [],
      suggestedNextStep: singleAttempt.preview ? "review_listing" : "use_as_idea",
      preferredIntent: intent,
      reason: singleAttempt.preview ? null : "Could not extract listing details",
    };
  }

  // Not a confident single listing — pull links from the page and
  // see how many look like listing details.
  let scraped;
  try {
    scraped = await scrapeUrl(parsed.toString(), { extractLinks: true });
  } catch (err) {
    // Even scraping failed — fall back to single-listing preview
    // (lower confidence) so the user can at least review/edit
    // and use it as a starting point.
    return {
      url: parsed.toString(),
      detectedType: "unknown",
      confidence: 0.2,
      listings: singleAttempt.preview ? [singleAttempt.preview] : [],
      suggestedNextStep: singleAttempt.preview ? "review_listing" : "use_as_idea",
      preferredIntent: intent,
      reason: `Could not scrape: ${err.message}`,
    };
  }

  const candidateLinks = scoreListingLinks(scraped.links ?? [], parsed.origin)
    .slice(0, MAX_INDEX_CANDIDATES);

  if (candidateLinks.length >= 2) {
    const indexPreviews = await crawlIndexPreviews(clientId, candidateLinks);
    if (indexPreviews.length >= 2) {
      return {
        url: parsed.toString(),
        detectedType: "listing_index",
        confidence: 0.7,
        listings: indexPreviews,
        suggestedNextStep: "choose_listing",
        preferredIntent: intent,
      };
    }
    // We saw listing-like links but couldn't extract enough
    // useful detail — fall through to business_page so the user
    // can use the page as an idea / brand context.
  }

  // Has some listing data (price OR address) but not enough for
  // high-confidence single. Surface as a low-confidence single.
  if (singleAttempt.confidence >= 0.3) {
    return {
      url: parsed.toString(),
      detectedType: "single_listing",
      confidence: singleAttempt.confidence,
      listings: [singleAttempt.preview],
      suggestedNextStep: "review_listing",
      preferredIntent: intent,
    };
  }

  // Heuristic: pages with substantial body text and a recognized
  // business-y title behave like business_pages. Anything else
  // is unknown — user can still use it as an idea source.
  const detectedType = scraped.text && scraped.text.length > 200
    ? "business_page"
    : "unknown";
  return {
    url: parsed.toString(),
    detectedType,
    confidence: detectedType === "business_page" ? 0.5 : 0.2,
    listings: [],
    suggestedNextStep: detectedType === "business_page" ? "import_business_page" : "use_as_idea",
    preferredIntent: intent,
  };
}

async function tryIngestSingle(_clientId, url) {
  try {
    const { preview, normalized, quality } = await ingestUrlListing(_clientId, url);
    // Map extraction quality to a confidence score so analyze()
    // can decide between single_listing / listing_index. We're
    // intentionally generous — the user reviews the preview
    // before save, so a 0.6 here means "show this and let them
    // confirm" not "auto-create".
    const confidence = scoreFromQuality(quality, normalized);
    const previewId = makePreviewId(url, normalized);
    return {
      confidence,
      preview: preview
        ? {
            previewId,
            sourceUrl: url,
            normalized,
            validation: preview.validation ?? null,
            quality,
          }
        : null,
    };
  } catch {
    return { confidence: 0, preview: null };
  }
}

function scoreFromQuality(quality, normalized) {
  if (!quality) return 0;
  // The quality.score is the percentage of weighted fields that
  // were extracted. Combine with a couple of strong-signal
  // checks (price + address.street) for a final confidence band.
  const base = (quality.score ?? 0) / 100;
  const hasPrice = normalized?.price != null && normalized.price > 0;
  const hasAddress = Boolean(normalized?.address?.street);
  let boost = 0;
  if (hasPrice && hasAddress) boost = 0.3;
  else if (hasPrice || hasAddress) boost = 0.15;
  return Math.min(1, base + boost);
}

function scoreListingLinks(links, origin) {
  const seen = new Set();
  const scored = [];
  for (const link of links) {
    let url;
    try {
      url = new URL(link, origin);
    } catch {
      continue;
    }
    if (url.origin !== origin) continue;
    const path = url.pathname;
    if (path === "/" || path === "") continue;
    if (isAssetPath(path)) continue;
    const normalizedHref = `${url.origin}${url.pathname}`;
    if (seen.has(normalizedHref)) continue;
    seen.add(normalizedHref);

    let score = 0;
    for (const pattern of LISTING_PATH_PATTERNS) {
      if (pattern.test(path)) {
        score += 1;
        break;
      }
    }
    // Deep paths with id-looking segments → likely a listing
    // detail. e.g. `/property/12345-elm-st` outranks `/about`.
    const segments = path.split("/").filter(Boolean);
    if (segments.length >= 2) score += 0.5;
    if (/\d{2,}|[a-f0-9]{8,}/i.test(segments[segments.length - 1] ?? "")) score += 0.5;

    if (score > 0) scored.push({ href: normalizedHref, score });
  }
  return scored.sort((a, b) => b.score - a.score);
}

function isAssetPath(path) {
  return /\.(jpe?g|png|gif|webp|svg|css|js|pdf|zip|xml|ico|woff2?)(\?|$)/i.test(path);
}

async function crawlIndexPreviews(clientId, candidates) {
  const previews = [];
  const seenSignatures = new Set();
  for (const { href } of candidates) {
    if (previews.length >= MAX_INDEX_PREVIEWS) break;
    let result;
    try {
      result = await Promise.race([
        ingestUrlListing(clientId, href),
        new Promise((_, reject) =>
          setTimeout(
            () => reject(new Error("per-preview timeout")),
            PER_PREVIEW_TIMEOUT_MS,
          ),
        ),
      ]);
    } catch {
      continue;
    }
    if (!result?.normalized) continue;
    const sig = signatureOf(result.normalized);
    if (seenSignatures.has(sig)) continue;
    seenSignatures.add(sig);
    previews.push({
      previewId: makePreviewId(href, result.normalized),
      sourceUrl: href,
      normalized: result.normalized,
      validation: result.preview?.validation ?? null,
      quality: result.quality ?? null,
    });
  }
  return previews;
}

function signatureOf(normalized) {
  const parts = [
    normalized?.title?.toLowerCase().trim().slice(0, 100),
    normalized?.address?.street?.toLowerCase().trim(),
    normalized?.address?.city?.toLowerCase().trim(),
    normalized?.price != null ? String(normalized.price) : null,
  ].filter(Boolean);
  return parts.join("|");
}

function makePreviewId(url, normalized) {
  return crypto
    .createHash("sha1")
    .update(`${url}::${signatureOf(normalized ?? {})}`)
    .digest("hex")
    .slice(0, 20);
}

// ── Confirm ────────────────────────────────────────────────────

export async function confirmUrl(clientId, { url, selectedListing } = {}) {
  if (!selectedListing || typeof selectedListing !== "object") {
    throw Object.assign(new Error("selectedListing is required"), { status: 400 });
  }
  // Source URL is recorded on the data item. We accept it from
  // either the explicit `url` param or the listing's sourceUrl
  // (set by analyze on every preview row).
  const sourceUrl = url ?? selectedListing.sourceUrl;
  if (sourceUrl) {
    assertSafeExternalUrl(sourceUrl);
  }

  // Hand off to the existing confirm path so we don't duplicate
  // dedupe/event-detection logic. URL-01 Bug 2 fix means the
  // duplicate response now reliably carries existingId.
  const result = await confirmUrlListing(clientId, {
    ...selectedListing,
    sourceUrl: sourceUrl ?? selectedListing.sourceUrl ?? null,
  });

  const dataItemId = result.listing?.id ?? result.existingId ?? null;
  if (!dataItemId) {
    throw Object.assign(new Error("Could not resolve dataItemId after confirm"), {
      status: 500,
      code: "CONFIRM_NO_DATA_ITEM",
    });
  }

  // Build the Create-assistant deep link so dashboard /
  // assistant / library can route to a single canonical
  // destination after confirm. Mirrors the existing property
  // campaign flow shape (`sourceType=property&sourceId=...`).
  const createUrl =
    `/workspaces/${clientId}/create?intent=campaign` +
    `&sourceType=property&sourceId=${encodeURIComponent(dataItemId)}`;

  return {
    dataItemId,
    created: result.created,
    existingId: result.created ? null : result.existingId ?? dataItemId,
    propertyData: serializePropertyData(result.listing),
    createUrl,
  };
}

function serializePropertyData(item) {
  if (!item) return null;
  return {
    id: item.id,
    title: item.title ?? null,
    summary: item.summary ?? null,
    tags: item.tags ?? [],
    dataJson: item.dataJson ?? null,
  };
}
