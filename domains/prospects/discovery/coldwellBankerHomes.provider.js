import * as cheerio from "cheerio";
import { absoluteSameDomain, normalizePublicUrl } from "./urlIdentity.js";

const PROFILE_RE = /\/agent\/[^/]+\/aid_(\d+)(?:\/|$)/i;
const INACTIVE_RE = /\b(sold|closed|pending|contingent|off[- ]market|historical|previous sale)\b/i;
const LISTING_RE = /\/[^/]+\/pid_\d+\/?$/i;
const DIRECTORY_RE = /^(.*\/agents)(?:\/p_(\d+))?\/?$/i;

function clean(value) { return String(value || "").replace(/\s+/g, " ").trim(); }
const ZIP_RE = /^\d{5}(?:-\d{4})?$/;
const STREET_RE = /^\d+[A-Za-z]?(?:[-/]\d+[A-Za-z]?)?\s+\S.+$/;

function addressFromFullText(value) {
  const match = clean(value).match(/^(.+?),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i);
  return match ? { streetAddress: match[1], city: match[2], state: match[3], postalCode: match[4] } : {};
}
function streetFromCardText(value) { return clean(value).replace(/^(?:active|for sale)\s+/i, "").split(/\s+\$[\d,.]+|\s+\d+(?:\.\d+)?\s*(?:beds?|bd)\b/i)[0].trim() || null; }

export function normalizeColdwellListingAddress(input = {}, listingUrl = null) {
  const fromFull = addressFromFullText(input.fullAddress || input.address || "");
  const streetAddress = clean(input.streetAddress || input.street || fromFull.streetAddress) || null;
  const city = clean(input.city || fromFull.city) || null;
  const state = clean(input.state || fromFull.state).toUpperCase() || null;
  const postalCode = clean(input.postalCode || input.zip || fromFull.postalCode) || null;
  const zipGluedToHouse = /^\d{5}(?:-\d{4})?(?:\d+|\s+\d+)\s/i.test(streetAddress || "");
  const zipAppended = /\s\d{5}(?:-\d{4})?$/.test(streetAddress || "");
  const zipInsideStreet = postalCode && (streetAddress || "").replace(/\D/g, "").startsWith(postalCode.replace(/\D/g, "")) && streetAddress !== postalCode;
  const repeatedStreet = /^(.{4,}?)\s+\1$/i.test(streetAddress || "");
  const escapedCity = city?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cityAppended = escapedCity ? new RegExp(`\\s${escapedCity}$`, "i").test(streetAddress || "") : false;
  const validStreet = !streetAddress || STREET_RE.test(streetAddress);
  const validPostalCode = !postalCode || ZIP_RE.test(postalCode);
  const suspicious = Boolean(zipGluedToHouse || zipAppended || zipInsideStreet || repeatedStreet || cityAppended || !validStreet || !validPostalCode);
  if (suspicious) return { streetAddress: null, city: city || null, state: state || null, postalCode: validPostalCode ? postalCode : null, fullAddress: null, addressParsingStatus: "SUSPICIOUS", listingUrl };
  const statePostal = [state, postalCode].filter(Boolean).join(" ");
  const fullAddress = [streetAddress, city, statePostal].filter(Boolean).join(", ") || null;
  return { streetAddress, city, state, postalCode, fullAddress, addressParsingStatus: streetAddress ? (city && state && postalCode ? "COMPLETE" : "PARTIAL") : "INCOMPLETE", listingUrl };
}

function jsonLdValues($) {
  const values = [];
  const visit = (value) => { if (!value || typeof value !== "object") return; if (Array.isArray(value)) return value.forEach(visit); values.push(value); if (Array.isArray(value["@graph"])) value["@graph"].forEach(visit); };
  $("script[type='application/ld+json']").each((_i, node) => { try { visit(JSON.parse($(node).text())); } catch {} });
  return values;
}

function structuredAddress($) {
  for (const value of jsonLdValues($)) {
    const address = value?.address?.streetAddress ? value.address : value?.["@type"] === "PostalAddress" ? value : null;
    if (address) return { streetAddress: address.streetAddress, city: address.addressLocality, state: address.addressRegion, postalCode: address.postalCode };
  }
  return {
    streetAddress: $("[itemprop='streetAddress']").first().attr("content") || $("[itemprop='streetAddress']").first().text(),
    city: $("[itemprop='addressLocality']").first().attr("content") || $("[itemprop='addressLocality']").first().text(),
    state: $("[itemprop='addressRegion']").first().attr("content") || $("[itemprop='addressRegion']").first().text(),
    postalCode: $("[itemprop='postalCode']").first().attr("content") || $("[itemprop='postalCode']").first().text(),
  };
}

function coldwellGalleryImages($, pageUrl) {
  const candidates = [];
  const add = (raw, descriptor = 0) => {
    if (!raw) return;
    try {
      const url = new URL(raw, pageUrl);
      const match = url.pathname.match(/^(\/p\/[^/]+\/[^/]+)\/([^/]+)\/[^/]+$/i);
      if (!/(?:^|\.)m\d*\.cbhomes\.com$/i.test(url.hostname) || !match) return;
      candidates.push({ url: url.toString(), gallery: match[1].toLowerCase(), photo: `${match[1]}/${match[2]}`.toLowerCase(), descriptor });
    } catch {}
  };
  $("img,source").each((_i, node) => {
    for (const attribute of ["data-srcset", "srcset"]) {
      const srcset = $(node).attr(attribute);
      if (!srcset) continue;
      for (const part of srcset.split(",")) {
        const [url, size = "0"] = part.trim().split(/\s+/);
        add(url, Number(size.replace(/\D/g, "")) || 0);
      }
    }
    add($(node).attr("data-src") || $(node).attr("data-lazy-src") || $(node).attr("data-original") || $(node).attr("src"));
  });
  const galleryCounts = new Map();
  for (const candidate of candidates) galleryCounts.set(candidate.gallery, (galleryCounts.get(candidate.gallery) || 0) + 1);
  const dominantGallery = [...galleryCounts].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (!dominantGallery) return [];
  const bestByPhoto = new Map();
  for (const candidate of candidates.filter(({ gallery }) => gallery === dominantGallery)) {
    const existing = bestByPhoto.get(candidate.photo);
    if (!existing || candidate.descriptor > existing.descriptor) bestByPhoto.set(candidate.photo, candidate);
  }
  return [...bestByPhoto.values()].map(({ url }) => url);
}
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
    const $ = cheerio.load(html), current = normalizePublicUrl(url);
    const currentMatch = new URL(current).pathname.match(DIRECTORY_RE);
    if (!currentMatch) return [];
    const directoryPath = currentMatch[1].toLowerCase(), currentPage = Number(currentMatch[2] || 1), candidates = [];
    $("a[href]").each((_i, node) => {
      const href = absoluteSameDomain($(node).attr("href"), url);
      if (!href) return;
      const normalized = normalizePublicUrl(href), match = normalized && new URL(normalized).pathname.match(DIRECTORY_RE);
      if (!match || match[1].toLowerCase() !== directoryPath) return;
      const page = Number(match[2] || 1);
      if (page <= currentPage) return;
      const semantics = `${clean($(node).text())} ${clean($(node).attr("rel"))} ${clean($(node).attr("aria-label"))}`;
      candidates.push({ url: normalized, page, semanticNext: /\bnext\b/i.test(semantics) });
    });
    const forward = candidates.filter((candidate) => candidate.page === currentPage + 1);
    const semantic = candidates.filter((candidate) => candidate.semanticNext);
    const next = (forward.length ? forward : semantic.length ? semantic : candidates).sort((a, b) => a.page - b.page)[0];
    return next ? [next.url] : [];
  },
  parseProfile(url, html) {
    const $ = cheerio.load(html), structured = jsonLdPeople($)[0] || {};
    const pageTitle = clean($("meta[property='og:title']").attr("content") || $("title").text()).split(",")[0];
    const fullName = clean(structured.name || pageTitle || $("h1").first().text());
    const visibleEmail = clean($.root().text()).match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
    const email = clean(structured.email || structured.contactPoint?.email || $("a[href^='mailto:']").first().attr("href")?.slice(7).split("?")[0] || visibleEmail);
    const profileIdentity = this.identity(url);
    const listingLinks = [];
    $("a[href]").each((_i, node) => { const href = absoluteSameDomain($(node).attr("href"), url); if (!href || !/\/listings\/?$/i.test(new URL(href).pathname) || this.identity(href).providerExternalId !== profileIdentity.providerExternalId) return; const label = clean($(node).text()); const context = clean($(node).closest("section,article,[class*='listing'],[id*='listing']").text()); const score = (/view all listings|all listings/i.test(label) ? 4 : /view all/i.test(label) ? 3 : /current listings|my listings/i.test(`${label} ${context}`) ? 2 : 1); listingLinks.push({ href, score }); });
    let listingsUrl = listingLinks.sort((a, b) => b.score - a.score)[0]?.href || null;
    if (!listingsUrl && profileIdentity.normalizedProfileUrl) listingsUrl = `${profileIdentity.normalizedProfileUrl}/listings/`;
    const structuredImage = typeof structured.image === "string" ? structured.image : structured.image?.url;
    let profileImage = null;
    $("[class*='agent'],[class*='profile'],[class*='headshot'],header").find("img").each((_i, image) => { if (profileImage) return; const src = absoluteSameDomain($(image).attr("src") || $(image).attr("data-src"), url) || $(image).attr("src") || $(image).attr("data-src"); const description = `${$(image).attr("alt") || ""} ${$(image).attr("class") || ""} ${src || ""}`; if (src && !/logo|brand|listing|property|home/i.test(description)) profileImage = src; });
    const ogImage = $("meta[property='og:image']").attr("content");
    const ogDescription = `${$("meta[property='og:image:alt']").attr("content") || ""} ${ogImage || ""}`;
    const reliableOgImage = ogImage && !/logo|brand|listing|property|home/i.test(ogDescription) && (fullName.split(" ").filter(Boolean).some((part) => new RegExp(part, "i").test(ogDescription)) || (profileIdentity.providerExternalId && ogDescription.includes(profileIdentity.providerExternalId))) ? ogImage : null;
    const parts = fullName.split(" ");
    return { ...profileIdentity, firstName: parts[0] || null, lastName: parts.slice(1).join(" ") || null, fullName: fullName || "Unknown agent", email: email || null, phone: clean(structured.telephone || $("a[href^='tel:']").first().text()) || null, brokerage: clean(structured.worksFor?.name || structured.affiliation?.name || $("[class*='company'],[class*='brokerage']").first().text()) || null, office: clean($("[class*='office']").first().text()) || null, profileUrl: profileIdentity.normalizedProfileUrl, headshotUrl: structuredImage || profileImage || reliableOgImage || null, listingsUrl };
  },
  parseListings(url, html) {
    const $ = cheerio.load(html), listings = [], seen = new Set();
    $("a[href]").each((_i, node) => { const href = absoluteSameDomain($(node).attr("href"), url); if (!href || !LISTING_RE.test(new URL(href).pathname)) return; const container = $(node).closest("article,li,[class*='listing'],[class*='property'],[data-listing-id]"); const containerText = clean(container.text() || $(node).parent().text() || $(node).text()); if (INACTIVE_RE.test(containerText)) return; const listingUrl = normalizePublicUrl(href); if (!listingUrl || seen.has(listingUrl)) return; seen.add(listingUrl); const listingId = new URL(listingUrl).pathname.match(/pid_(\d+)/i)?.[1] || null; const price = containerText.match(/\$[\d,.]+/)?.[0] || null; const facts = containerText.match(/(\d+(?:\.\d+)?)\s*(?:beds?|bd).*?(\d+(?:\.\d+)?)\s*(?:baths?|ba).*?([\d,]+)\s*(?:sq\.?\s*ft|sqft)/i); const addressNode = container.find("[class*='address'],address").first(); const rawAddress = clean($(node).attr("aria-label") || addressNode.attr("data-address") || addressNode.text() || $(node).text()) || null; const component = (name) => clean(container.find(`[itemprop='${name}']`).first().attr("content") || container.find(`[itemprop='${name}']`).first().text()); const parsedFull = addressFromFullText(rawAddress); const normalizedAddress = normalizeColdwellListingAddress({ streetAddress: component("streetAddress") || parsedFull.streetAddress || streetFromCardText(rawAddress), city: component("addressLocality") || parsedFull.city, state: component("addressRegion") || parsedFull.state, postalCode: component("postalCode") || parsedFull.postalCode }, listingUrl); const photos = [...new Set(container.find("img").map((_j, image) => $(image).attr("src") || $(image).attr("data-src")).get().filter(Boolean))]; listings.push({ listingId, listingUrl, sourceUrl: listingUrl, address: normalizedAddress.fullAddress || normalizedAddress.streetAddress, ...normalizedAddress, price, beds: facts ? Number(facts[1]) : null, baths: facts ? Number(facts[2]) : null, squareFeet: facts ? Number(facts[3].replace(/,/g, "")) : null, photoUrls: photos, status: "ACTIVE", verifiedAt: new Date().toISOString() }); });
    return listings;
  },
  parseListingDetail(url, html) {
    const $ = cheerio.load(html);
    const structured = structuredAddress($);
    const heading = clean($("h1").first().text() || $("meta[property='og:title']").attr("content") || $("title").text());
    const parsedHeading = addressFromFullText(heading);
    const normalized = normalizeColdwellListingAddress({ streetAddress: structured.streetAddress || parsedHeading.streetAddress || streetFromCardText(heading), city: structured.city || parsedHeading.city, state: structured.state || parsedHeading.state, postalCode: structured.postalCode || parsedHeading.postalCode }, normalizePublicUrl(url));
    const photoUrls = coldwellGalleryImages($, url);
    return { listingUrl: normalizePublicUrl(url), sourceUrl: normalizePublicUrl(url), address: normalized.fullAddress || normalized.streetAddress, ...normalized, photoUrls };
  },
  discoverListingPages(url, html, profileUrl) {
    const $ = cheerio.load(html), currentPath = new URL(url).pathname, currentPage = Number(currentPath.match(/\/p_(\d+)\/?$/i)?.[1] || 1);
    const providerId = this.identity(profileUrl).providerExternalId, candidates = [];
    $("a[href]").each((_i, node) => {
      const href = absoluteSameDomain($(node).attr("href"), url);
      if (!href) return;
      const target = new URL(href), page = Number(target.pathname.match(/\/p_(\d+)\/?$/i)?.[1]);
      if (!page || page <= currentPage) return;
      let original = target.searchParams.get("originalURL") || "";
      try { original = decodeURIComponent(decodeURIComponent(original)); } catch {}
      if (!new RegExp(`/agent/[^/]+/aid_${providerId}/listings/?$`, "i").test(original)) return;
      const semantics = `${clean($(node).text())} ${clean($(node).attr("rel"))} ${clean($(node).attr("aria-label"))}`;
      candidates.push({ url: href, page, semanticNext: /\bnext\b/i.test(semantics) });
    });
    const next = (candidates.filter((item) => item.page === currentPage + 1).length ? candidates.filter((item) => item.page === currentPage + 1) : candidates.filter((item) => item.semanticNext)).sort((a, b) => a.page - b.page)[0];
    return next ? [next.url] : [];
  },
};
