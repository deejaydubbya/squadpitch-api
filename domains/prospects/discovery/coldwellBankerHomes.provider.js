import * as cheerio from "cheerio";
import { absoluteSameDomain, normalizePublicUrl } from "./urlIdentity.js";

const PROFILE_RE = /\/agent\/[^/]+\/aid_(\d+)(?:\/|$)/i;
const SOLD_RE = /\b(sold|closed|pending|contingent|off[- ]market|historical)\b/i;
const LISTING_RE = /\/(?:property|home|listing|real-estate)\//i;

function clean(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
function nameFromProfileUrl(value) {
  try {
    const slug = new URL(value).pathname.match(/\/agent\/([^/]+)\/aid_\d+/i)?.[1];
    return slug ? slug.split("-").filter(Boolean).map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ") : null;
  } catch { return null; }
}
function jsonLdPeople($) {
  const people = [];
  $("script[type='application/ld+json']").each((_i, node) => { try { const raw = JSON.parse($(node).text()); const values = Array.isArray(raw) ? raw : raw?.["@graph"] || [raw]; for (const value of values) if (value?.["@type"] === "Person" || value?.["@type"]?.includes?.("Person")) people.push(value); } catch {} });
  return people;
}

export const coldwellBankerHomesProvider = {
  key: "COLDWELL_BANKER_HOMES",
  label: "Coldwell Banker Homes",
  supports(url) { return /(^|\.)coldwellbankerhomes\.com$/i.test(new URL(url).hostname); },
  classify(url, html) {
    const path = new URL(url).pathname;
    if (/\/agent\/[^/]+\/aid_\d+\/listings\/?$/i.test(path)) return "AGENT_LISTINGS";
    if (PROFILE_RE.test(path)) return "AGENT_PROFILE";
    if (/\/agents\/(?:p_\d+\/?)?$/i.test(path) || this.discoverAgentLinks(url, html).length > 1) return "AGENT_DIRECTORY";
    return "UNSUPPORTED";
  },
  identity(profileUrl) {
    const normalizedProfileUrl = normalizePublicUrl(profileUrl)?.replace(/\/listings$/, "") || null;
    const match = normalizedProfileUrl?.match(PROFILE_RE);
    return { provider: this.key, providerExternalId: match?.[1] || null, normalizedProfileUrl };
  },
  discoverAgentLinks(url, html) {
    const $ = cheerio.load(html), seen = new Set(), output = [];
    $("a[href]").each((_i, node) => { const href = absoluteSameDomain($(node).attr("href"), url); if (!href || !PROFILE_RE.test(new URL(href).pathname) || /\/listings\/?$/i.test(new URL(href).pathname)) return; const identity = this.identity(href); const key = identity.providerExternalId || identity.normalizedProfileUrl; if (!key || seen.has(key)) return; seen.add(key); const label = clean($(node).text() || $(node).attr("aria-label") || $(node).attr("title") || $(node).find("img").attr("alt")) || nameFromProfileUrl(href); output.push({ profileUrl: identity.normalizedProfileUrl, ...identity, label }); });
    return output;
  },
  discoverDirectoryPages(url, html) {
    const $ = cheerio.load(html), current = normalizePublicUrl(url), pages = [];
    $("a[href]").each((_i, node) => { const href = absoluteSameDomain($(node).attr("href"), url); if (!href) return; const normalized = normalizePublicUrl(href); const label = clean($(node).text()); const rel = clean($(node).attr("rel")); const pagination = /next/i.test(`${label} ${rel} ${$(node).attr("aria-label") || ""}`) || /(?:page|pg)=\d+/i.test(new URL(href).search) || /\/p_\d+\/?$/i.test(new URL(href).pathname); if ((normalized !== current || pagination) && /\/agents\/(?:p_\d+\/?)?$/i.test(new URL(href).pathname) && pagination) pages.push(href); });
    return [...new Set(pages)];
  },
  parseProfile(url, html) {
    const $ = cheerio.load(html), structured = jsonLdPeople($)[0] || {};
    const pageTitle = clean($("meta[property='og:title']").attr("content") || $("title").text()).split(",")[0];
    const fullName = clean(structured.name || pageTitle || $("h1").first().text());
    const visibleEmail = clean($.root().text()).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
    const email = clean(structured.email || structured.contactPoint?.email || $("a[href^='mailto:']").first().attr("href")?.slice(7).split("?")[0] || visibleEmail);
    const profileIdentity = this.identity(url);
    let listingsUrl = null;
    $("a[href]").each((_i, node) => { if (listingsUrl) return; const href = absoluteSameDomain($(node).attr("href"), url); const label = clean($(node).text()); if (href && /listings|properties|homes for sale/i.test(`${href} ${label}`) && this.identity(href).providerExternalId === profileIdentity.providerExternalId) listingsUrl = href; });
    if (!listingsUrl && profileIdentity.normalizedProfileUrl) listingsUrl = `${profileIdentity.normalizedProfileUrl}/listings/`;
    const parts = fullName.split(" ");
    return { ...profileIdentity, firstName: parts[0] || null, lastName: parts.slice(1).join(" ") || null, fullName: fullName || "Unknown agent", email: email || null, phone: clean(structured.telephone || $("a[href^='tel:']").first().text()) || null, brokerage: clean(structured.worksFor?.name || structured.affiliation?.name || $("[class*='company'],[class*='brokerage']").first().text()) || null, office: clean($("[class*='office']").first().text()) || null, profileUrl: profileIdentity.normalizedProfileUrl, headshotUrl: typeof structured.image === "string" ? structured.image : structured.image?.url || $("meta[property='og:image']").attr("content") || null, listingsUrl };
  },
  parseListings(url, html) {
    const $ = cheerio.load(html), listings = [], seen = new Set();
    $("a[href]").each((_i, node) => { const href = absoluteSameDomain($(node).attr("href"), url); const containerText = clean($(node).closest("article,li,[class*='listing'],[class*='property']").text() || $(node).text()); if (!href || !LISTING_RE.test(new URL(href).pathname) || SOLD_RE.test(containerText)) return; const listingUrl = normalizePublicUrl(href); if (!listingUrl || seen.has(listingUrl)) return; seen.add(listingUrl); const price = containerText.match(/\$[\d,.]+/)?.[0] || null; const address = clean($(node).attr("aria-label") || $(node).text()) || null; listings.push({ listingUrl, sourceUrl: listingUrl, address, price, status: "ACTIVE", verifiedAt: new Date().toISOString() }); });
    return listings.slice(0, 25);
  },
};
