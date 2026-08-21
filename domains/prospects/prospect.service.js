import crypto from "node:crypto";
import { Prisma } from "@prisma/client";
import { prisma } from "../../prisma.js";
import { analyzeUrl, confirmUrl, assertSafeExternalUrl } from "../studio/urlCampaignIntake.service.js";
import { enrichListingById } from "../industry/propertyEnrichment.service.js";
import { generateDraft } from "../studio/generation/aiGenerationService.js";
import { getImageStorageService } from "../../services/storage/imageStorage.js";
import { sniffImageMime } from "../../lib/mimeDetect.js";
import { extractFromImage } from "../studio/generation/openai.provider.js";
import { trackAiUsage } from "../billing/aiUsageTracking.service.js";
import { getProspectPreparationQueue } from "../../lib/queues.js";
import { logEvent } from "../../lib/logger.js";
import { normalizeIdentityEmail } from "../../lib/auth0Identity.js";
import { selectCanonicalProspectDrafts } from "../../lib/prospectDraftVisibility.js";
import { ingestPropertyMedia } from "../studio/propertyMedia.service.js";

const TOKEN_BYTES = 32;
const DEFAULT_TTL_DAYS = 21;
const UNCLAIMED_OWNER = "prospect:unclaimed";
const PROSPECT_CHANNELS = Object.freeze(["INSTAGRAM", "FACEBOOK", "LINKEDIN"]);
const DEFAULT_REAL_ESTATE_CHANNELS = Object.freeze(["INSTAGRAM", "FACEBOOK"]);

function normalizeProspectChannels(channels, fallback = PROSPECT_CHANNELS) {
  const selected = [...new Set((channels || []).filter((channel) => PROSPECT_CHANNELS.includes(channel)))];
  return selected.length ? selected : [...fallback];
}

export function generateSecret() {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

export function digestSecret(secret) {
  return crypto.createHash("sha256").update(secret, "utf8").digest("hex");
}

function expiresAt(days = DEFAULT_TTL_DAYS) {
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000);
}

function slugify(value) {
  return value.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 70) || "prospect";
}

async function availableSlug(tx, name) {
  const base = `${slugify(name)}-preview`;
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const slug = suffix === 1 ? base : `${base}-${suffix}`;
    if (!(await tx.client.findUnique({ where: { slug }, select: { id: true } }))) return slug;
  }
  return `${base}-${crypto.randomBytes(4).toString("hex")}`;
}

export async function createProspect(input, adminSub) {
  const previewToken = generateSecret();
  const claimToken = generateSecret();
  const claimExpiresAt = expiresAt(input.claimTtlDays);
  const result = await prisma.$transaction(async (tx) => {
    const client = await tx.client.create({
      data: {
        name: input.businessName,
        logoUrl: input.profileImageUrl || null,
        slug: await availableSlug(tx, input.businessName),
        industryKey: input.industryKey,
        lifecycle: "PROSPECT",
        status: "DRAFT",
        createdBy: UNCLAIMED_OWNER,
        brandProfile: {
          create: {
            industry: input.industryKey,
            website: input.websiteUrl || null,
            updatedBy: adminSub,
          },
        },
      },
    });
    const prospect = await tx.prospectWorkspace.create({
      data: {
        clientId: client.id,
        prospectName: input.prospectName,
        prospectEmail: input.prospectEmail.toLowerCase(),
        websiteUrl: input.websiteUrl || null,
        sourceUrl: input.sourceUrl || null,
        acquisitionSource: input.acquisitionSource || null,
        operatorNote: input.operatorNote || null,
        selectedChannels: normalizeProspectChannels(input.selectedChannels, input.industryKey === "real_estate" ? DEFAULT_REAL_ESTATE_CHANNELS : PROSPECT_CHANNELS),
        previewTokenHash: digestSecret(previewToken),
        claimTokenHash: digestSecret(claimToken),
        claimIssuedAt: new Date(),
        claimExpiresAt,
        createdByAdminSub: adminSub,
      },
    });
    return { client, prospect };
  });
  return { ...formatAdminProspect(result.prospect, result.client), previewToken, claimToken };
}

export async function listProspects({ status, search } = {}) {
  const rows = await prisma.prospectWorkspace.findMany({
    where: {
      ...(status ? { claimStatus: status } : {}),
      ...(search ? { OR: [
        { prospectName: { contains: search, mode: "insensitive" } },
        { prospectEmail: { contains: search, mode: "insensitive" } },
        { client: { name: { contains: search, mode: "insensitive" } } },
      ] } : {}),
    },
    include: { client: true },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((row) => formatAdminProspect(row, row.client));
}

export async function getProspect(id) {
  const row = await prisma.prospectWorkspace.findUnique({
    where: { id },
    include: {
      client: { include: {
        dataItems: { where: { status: "ACTIVE" }, orderBy: { createdAt: "desc" } },
        drafts: { where: { status: { in: ["DRAFT", "PENDING_REVIEW", "APPROVED"] } }, orderBy: { createdAt: "desc" }, include: { _count: { select: { draftAssets: true } } } },
      } },
      previewItems: { orderBy: { sortOrder: "asc" } },
    },
  });
  if (!row) return null;
  await prisma.prospectPreparationRun.updateMany({
    where: { prospectWorkspaceId: id, status: { in: ["QUEUED", "RUNNING"] }, heartbeatAt: { lt: new Date(Date.now() - 15 * 60_000) } },
    data: { status: "FAILED", stage: "FAILED", failureCode: "STALE_RUN", failureMessage: "Preparation stopped reporting progress and can be retried.", completedAt: new Date() },
  });
  const preparationRun = await prisma.prospectPreparationRun.findFirst({ where: { prospectWorkspaceId: id }, orderBy: { createdAt: "desc" } });
  const propertyMediaAvailable = row.client.dataItems.some((item) => item.type === "PROPERTY" && (item.dataJson?.imageUrl || item.dataJson?.images?.length));
  const selectedChannels = normalizeProspectChannels(row.selectedChannels);
  const canonicalProspectDrafts = [];
  const seenProspectChannels = new Set();
  for (const draft of row.client.drafts) {
    const isPropertyDraft = draft.warnings?.some((warning) => warning.startsWith("prospectProperty:"));
    if (isPropertyDraft && seenProspectChannels.has(draft.channel)) continue;
    if (isPropertyDraft) seenProspectChannels.add(draft.channel);
    if (!isPropertyDraft || selectedChannels.includes(draft.channel)) canonicalProspectDrafts.push(draft);
  }
  const eligiblePreviewItems = [
    ...row.client.dataItems.map((item) => ({ id: item.id, itemType: "DATA_ITEM", title: item.title, subtitle: item.type })),
    ...canonicalProspectDrafts.filter((draft) => !propertyMediaAvailable || draft._count.draftAssets > 0 || draft.mediaUrl).map((draft) => ({ id: draft.id, itemType: "DRAFT", title: draft.body.slice(0, 120), subtitle: draft.channel })),
  ];
  const expectedChannels = selectedChannels;
  const readyChannels = expectedChannels.filter((channel) => canonicalProspectDrafts.some((draft) => draft.channel === channel && (!propertyMediaAvailable || draft._count.draftAssets > 0 || draft.mediaUrl)));
  const campaignReadiness = { status: readyChannels.length === expectedChannels.length ? (preparationRun?.status === "COMPLETE_WITH_WARNINGS" ? "COMPLETE_WITH_WARNINGS" : "COMPLETE") : readyChannels.length ? "PARTIAL" : "NEEDS_ATTENTION", readyChannels, expectedChannels, issues: expectedChannels.filter((channel) => !readyChannels.includes(channel)).map((channel) => ({ channel, code: "DRAFT_NOT_READY", message: `${channel.charAt(0)}${channel.slice(1).toLowerCase()} draft needs attention` })) };
  return {
    ...formatAdminProspect(row, row.client),
    preparationState: row.previewItems.length > 0 ? "SELECTED" : eligiblePreviewItems.length > 0 ? "READY_UNSELECTED" : "NOT_STARTED",
    sourcePreparationState: row.client.dataItems.some((item) => item.type === "PROPERTY" && typeof item.dataJson?.listingUrl === "string") && readyChannels.length === expectedChannels.length ? "IMPORTED" : "NOT_IMPORTED",
    eligiblePreviewItems,
    selectedPreviewItems: row.previewItems.map((item) => ({ id: item.dataItemId || item.draftId, itemType: item.itemType, sortOrder: item.sortOrder })),
    campaignReadiness,
    preparationRun,
    selectedChannels,
  };
}

export async function updatePreviewSelection(id, items, adminSub) {
  return prisma.$transaction(async (tx) => {
    const prospect = await tx.prospectWorkspace.findUnique({ where: { id }, include: { client: { select: { lifecycle: true } } } });
    if (!prospect || prospect.client.lifecycle !== "PROSPECT") throw Object.assign(new Error("Prospect workspace not found"), { status: 404, code: "NOT_FOUND" });
    const dataItemIds = items.filter((item) => item.itemType === "DATA_ITEM").map((item) => item.id);
    const draftIds = items.filter((item) => item.itemType === "DRAFT").map((item) => item.id);
    const [dataItemCount, selectedDrafts] = await Promise.all([
      tx.workspaceDataItem.count({ where: { id: { in: dataItemIds }, clientId: prospect.clientId, status: "ACTIVE" } }),
      tx.draft.findMany({ where: { id: { in: draftIds }, clientId: prospect.clientId, status: { in: ["DRAFT", "PENDING_REVIEW", "APPROVED"] } }, select: { id: true, channel: true, mediaUrl: true, _count: { select: { draftAssets: true } } } }),
    ]);
    if (dataItemCount !== dataItemIds.length || selectedDrafts.length !== draftIds.length) throw Object.assign(new Error("Every selected record must be an eligible member of this prospect workspace"), { status: 422, code: "INVALID_PREVIEW_SELECTION" });
    if (new Set(selectedDrafts.map((draft) => draft.channel)).size !== selectedDrafts.length) throw Object.assign(new Error("Select at most one current draft for each platform"), { status: 422, code: "DUPLICATE_PREVIEW_PLATFORM" });
    const selectedChannels = normalizeProspectChannels(prospect.selectedChannels);
    if (selectedDrafts.some((draft) => !selectedChannels.includes(draft.channel))) throw Object.assign(new Error("Preview drafts must use a selected preparation channel"), { status: 422, code: "UNSELECTED_PREVIEW_CHANNEL" });
    const property = await tx.workspaceDataItem.findFirst({ where: { clientId: prospect.clientId, type: "PROPERTY", status: "ACTIVE" }, select: { dataJson: true } });
    const propertyMediaAvailable = Boolean(property?.dataJson?.imageUrl || property?.dataJson?.images?.length);
    if (propertyMediaAvailable && selectedDrafts.some((draft) => draft._count.draftAssets === 0 && !draft.mediaUrl)) throw Object.assign(new Error("Attach listing media before selecting this property draft"), { status: 422, code: "PREVIEW_DRAFT_MEDIA_REQUIRED" });
    await tx.prospectPreviewItem.deleteMany({ where: { prospectWorkspaceId: id } });
    if (items.length) await tx.prospectPreviewItem.createMany({ data: items.map((item, sortOrder) => ({
      prospectWorkspaceId: id, itemType: item.itemType, dataItemId: item.itemType === "DATA_ITEM" ? item.id : null,
      draftId: item.itemType === "DRAFT" ? item.id : null, sortOrder, addedBy: adminSub,
    })) });
    return { items: items.map((item, sortOrder) => ({ ...item, sortOrder })) };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function rotateClaim(id, ttlDays = DEFAULT_TTL_DAYS) {
  const claimToken = generateSecret();
  const previewToken = generateSecret();
  const row = await prisma.$transaction(async (tx) => {
    const existing = await tx.prospectWorkspace.findUnique({ where: { id }, include: { client: true } });
    if (!existing) throw Object.assign(new Error("Prospect workspace not found"), { status: 404, code: "NOT_FOUND" });
    if (existing.client.lifecycle !== "PROSPECT" || existing.claimStatus === "CLAIMED") throw Object.assign(new Error("Claimed workspaces cannot issue new claim links"), { status: 409, code: "ALREADY_CLAIMED" });
    return tx.prospectWorkspace.update({ where: { id }, data: { claimTokenHash: digestSecret(claimToken), claimStatus: "CLAIMABLE", claimIssuedAt: new Date(), claimExpiresAt: expiresAt(ttlDays), previewTokenHash: digestSecret(previewToken), previewStatus: "ACTIVE" }, include: { client: true } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  return { ...formatAdminProspect(row, row.client), claimToken, previewToken };
}

export async function populateProspect(id, input, adminSub) {
  return prisma.$transaction(async (tx) => {
    const prospect = await tx.prospectWorkspace.findUnique({ where: { id }, include: { client: { select: { lifecycle: true } } } });
    if (!prospect || prospect.client.lifecycle !== "PROSPECT") throw Object.assign(new Error("Prospect workspace not found"), { status: 404, code: "NOT_FOUND" });
    let item = null;
    if (input.listing) {
      const source = await tx.workspaceDataSource.create({ data: { clientId: prospect.clientId, type: "MANUAL", name: "Admin prospect preview", config: { sourceUrl: input.listing.sourceUrl || prospect.sourceUrl || null, preparedBy: adminSub } } });
      item = await tx.workspaceDataItem.create({ data: { clientId: prospect.clientId, dataSourceId: source.id, type: "PROPERTY", title: input.listing.title, summary: input.listing.summary || null, dataJson: { imageUrl: input.listing.imageUrl || null, sourceUrl: input.listing.sourceUrl || prospect.sourceUrl || null, previewOnly: true }, tags: ["prospect-preview"] } });
    }
    const drafts = await Promise.all(input.posts.map((post) => tx.draft.create({ data: { clientId: prospect.clientId, kind: "POST", status: "DRAFT", channel: post.channel, generationGuidance: "Admin-prepared prospect preview", body: post.body, hooks: [], hashtags: [], warnings: ["Prospect preview draft — not published"], mediaUrl: post.mediaUrl || null, mediaType: post.mediaUrl ? "image" : null, createdBy: adminSub } })));
    return { itemId: item?.id ?? null, draftIds: drafts.map((draft) => draft.id) };
  });
}

function importFailure(message, details = {}) {
  return Object.assign(new Error(message), { status: 422, code: "PROSPECT_LISTING_IMPORT_FAILED", details });
}

function fillAddressFromTitle(listing) {
  const out = structuredClone(listing);
  const match = out.title?.match(/^(.+?),\s*([^,]+),\s*([A-Z]{2})\s+(\d{5})\b/i);
  if (match) {
    out.address = { street: out.address?.street || match[1], city: out.address?.city || match[2], state: out.address?.state || match[3].toUpperCase(), zip: out.address?.zip || match[4] };
  }
  return out;
}

export function isUsableProspectListing(listing, confidence = 0) {
  const normalized = fillAddressFromTitle(listing || {});
  const address = normalized.address || {};
  const hasCompleteAddress = Boolean(address.street && address.city && address.state && address.zip);
  const hasPrice = typeof normalized.price === "number" && normalized.price > 0;
  const hasAuthenticMedia = Array.isArray(normalized.images) && normalized.images.some((url) => typeof url === "string" && /images-listings\.coldwellbanker\.com/i.test(url));
  return confidence >= 0.6 || (confidence >= 0.5 && hasCompleteAddress && hasPrice && hasAuthenticMedia);
}

function titleCaseSlug(value) {
  const preserve = new Set(["n", "s", "e", "w", "ne", "nw", "se", "sw"]);
  return value.split("-").filter(Boolean).map((part) => preserve.has(part) ? part.toUpperCase() : `${part[0]?.toUpperCase() || ""}${part.slice(1)}`).join(" ");
}

export function coldwellListingFallback(selection) {
  const sourceUrl = selection?.listingUrl || selection?.sourceUrl;
  try {
    const parsed = new URL(sourceUrl);
    if (!/(?:^|\.)coldwellbankerhomes\.com$/i.test(parsed.hostname)) return null;
    const parts = parsed.pathname.split("/").filter(Boolean);
    const pidIndex = parts.findIndex((part) => part === "pid" || part.startsWith("pid_"));
    const statePart = parts[0], cityPart = parts[1], streetPart = parts[2];
    if (pidIndex < 3 || !/^[a-z]{2}$/i.test(statePart) || !/^\d+[a-z]?(?:-|$)/i.test(streetPart || "")) return null;
    const street = titleCaseSlug(streetPart);
    const city = titleCaseSlug(cityPart);
    const state = statePart.toUpperCase();
    return {
      title: `${street}, ${city}, ${state}`,
      description: null,
      price: typeof selection.price === "number" ? selection.price : null,
      status: "active",
      address: { street, city, state, zip: selection.postalCode || null },
      beds: selection.beds ?? null,
      baths: selection.baths ?? null,
      sqft: selection.squareFeet ?? null,
      images: (selection.photoUrls || []).filter((url) => !/spacer|pixel|1[-_/]x[-_/]1/i.test(url)),
      listingUrl: sourceUrl,
      sourceUrl,
      sourceType: "url",
      sourceId: selection.listingId || null,
      extractionFallback: "COLDWELL_CANONICAL_URL",
    };
  } catch { return null; }
}

export function preferDiscoveredListingGallery(listing, providerListing) {
  const providerImages = (providerListing?.images || []).filter((url) => typeof url === "string" && /^https?:\/\//i.test(url));
  return providerImages.length ? { ...listing, images: providerImages, imageUrl: providerImages[0], originalImageUrl: providerImages[0] } : listing;
}

const UNSUPPORTED_PROPERTY_COPY = [
  /\b(?:beautiful|charming|desirable|peaceful|stunning)\b/i,
  /\b(?:welcoming|lovely|serene|tranquil|cozy)\b/i,
  /\b(?:investment|investor)\s+(?:opportunity|potential)\b/i,
  /\b(?:great|excellent|fantastic)\s+(?:opportunity|find)\b/i,
  /\b(?:heart of|growing market|established quality|classic design)\b/i,
  /\b(?:comfort|comfortable|convenience|practicality)\b/i,
  /\b(?:entertain|entertaining|family gatherings?|lifestyle)\b/i,
  /\b(?:imagine|envision)\b/i,
  /friendly neighborhood/i, /close to (?:local )?amenities/i, /fresh finishes/i,
  /thoughtful layout/i, /modern living/i, /perfect for/i, /ideal for/i,
  /future expansion/i, /top-rated schools?/i, /great schools?/i, /open house/i,
  /price (?:drop|reduction)/i, /just sold/i, /recently sold/i,
  /concise look at the imported listing/i, /review the property details and photo/i,
  /property spotlight/i, /save this listing and contact/i,
  /\bspacious\b/i, /plenty of (?:room|space|potential)/i, /retains? (?:its )?charm/i,
  /modern conveniences?/i, /modern functionality/i, /natural light/i,
  /settle (?:in|down)/i, /looking to invest/i, /opportunity worth exploring/i,
  /family home/i, /place to entertain/i, /room (?:for your needs|to grow)/i,
  /personal touch/i, /comfort and functionality/i, /next chapter/i,
  /\b(?:solid )?opportunity\b/i, /curious about the neighborhood/i,
];

const CONDITION_CLAIMS = [
  /\bwell[- ]maintained\b/i, /\bupdated\b/i, /\brenovated\b/i,
  /\bmove[- ]in ready\b/i, /\bwell cared for\b/i, /\bpristine\b/i, /\bimmaculate\b/i,
];

const PROSPECT_BOILERPLATE = [
  /the current listing details include/i,
  /for professionals and clients reviewing available properties/i,
  /review the verified details/i,
  /the local market/i,
];

function verifiedSourceText(item) {
  const data = item.dataJson || {};
  return [item.summary, data.description, data.listingDescription, data.publicRemarks, data.remarks]
    .filter((value) => typeof value === "string")
    .join("\n");
}

function findUnsupportedPropertyClaim(text, item) {
  const condition = CONDITION_CLAIMS.find((pattern) => {
    const match = text.match(pattern)?.[0];
    return match && !verifiedSourceText(item).toLowerCase().includes(match.toLowerCase());
  });
  return condition || UNSUPPORTED_PROPERTY_COPY.find((pattern) => pattern.test(text));
}

export function validateGeneratedPropertyBody(body, item) {
  const text = String(body || "");
  const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const data = item.dataJson || {};
  const facts = [data.street, data.city, data.zip, data.price, data.bedrooms, data.bathrooms, data.sqft, data.yearBuilt]
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map((value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, ""));
  if (!text.trim() || !facts.some((fact) => fact.length >= 3 && normalized.includes(fact))) return { valid: false, reason: "MISSING_VERIFIED_FACT" };
  const unsupported = findUnsupportedPropertyClaim(text, item);
  const matchedText = unsupported ? text.match(unsupported)?.[0] : null;
  if (unsupported) return { valid: false, reason: "UNSUPPORTED_PROPERTY_CLAIM", matchedText };
  const blocks = text.split(/\n\s*\n|(?<=[.!?])\s+/).map((part) => part.trim()).filter((part) => part.length >= 12);
  const hasHook = /just listed|new (?:property )?listing|now available|take a look|explore|property listing|listing update|see the details/i.test(text);
  const hasCta = /contact|message|request|schedule|learn more|complete listing|showing/i.test(text);
  if (blocks.length < 3 || !hasHook || !hasCta) return { valid: false, reason: "INSUFFICIENT_SOCIAL_STRUCTURE" };
  return { valid: true };
}

export function buildVerifiedPropertyFallback(item, channel, businessName) {
  const data = item.dataJson || {};
  const address = [data.street, data.city, data.state, data.zip].filter(Boolean).join(", ") || item.title;
  const facts = [
    typeof data.price === "number" ? `$${data.price.toLocaleString("en-US")}` : null,
    typeof data.bedrooms === "number" ? `${data.bedrooms} bed${data.bedrooms === 1 ? "" : "s"}` : null,
    typeof data.bathrooms === "number" ? `${data.bathrooms} bath${data.bathrooms === 1 ? "" : "s"}` : null,
    typeof data.sqft === "number" ? `${data.sqft.toLocaleString("en-US")} sq ft` : null,
    typeof data.yearBuilt === "number" ? `Built in ${data.yearBuilt}` : null,
  ].filter(Boolean);
  const detailLine = facts.join(" · ");
  if (channel === "INSTAGRAM") return `🏡 New listing: ${address}.\n\nListed at ${detailLine}. Swipe through the listing photos for a closer look.\n\nMessage ${businessName} for details or to schedule a showing.\n\n#JustListed #RealEstate #PropertyTour`;
  if (channel === "FACEBOOK") return `Now available: ${address}.\n\nListed at ${detailLine}. Browse the listing photos for a closer look.\n\nContact ${businessName} for more information or to schedule a showing.`;
  return `New property listing: ${address}.\n\nListed at ${detailLine}.\n\nContact ${businessName} for complete listing details or showing information.\n\n#RealEstate #PropertyListing`;
}

function buildGenerationFacts(item) {
  const data = item.dataJson || {};
  return [
    ["address", [data.street, data.city, data.state, data.zip].filter(Boolean).join(", ") || item.title],
    ["price", typeof data.price === "number" ? `$${data.price.toLocaleString("en-US")}` : null],
    ["bedrooms", typeof data.bedrooms === "number" ? data.bedrooms : null],
    ["bathrooms", typeof data.bathrooms === "number" ? data.bathrooms : null],
    ["square feet", typeof data.sqft === "number" ? data.sqft : null],
    ["year built", typeof data.yearBuilt === "number" ? data.yearBuilt : null],
  ].filter(([, value]) => value !== null && value !== undefined && value !== "").map(([label, value]) => `${label}: ${value}`).join("; ");
}

const SAFE_HOOKS = {
  INSTAGRAM: "Take a look at this new listing",
  FACEBOOK: "A new property is now available",
  LINKEDIN: "New property listing",
};

const SAFE_CTAS = {
  INSTAGRAM: "Message us to request details or schedule a showing.",
  FACEBOOK: "Contact us to review the complete listing or schedule a showing.",
  LINKEDIN: "Contact the listing business for complete details and showing information.",
};

export function buildProspectAttemptGuidance({ item, channel, attempt, rejectedPhrases = [] }) {
  const allowedFacts = buildGenerationFacts(item);
  const contract = `Return the existing structured generation object. hooks must contain exactly one opening line and nothing else. body must contain only 2-3 natural sentences made directly from ALLOWED_FACTS; it must not repeat or paraphrase the hook, include the CTA, hashtags, links, or property-quality language. cta must contain only one neutral action from the allowed CTA vocabulary and must not repeat text from body. hashtags must contain only ${channel === "INSTAGRAM" ? "3-6 factual real-estate/location tags" : channel === "FACEBOOK" ? "0-3 factual tags" : "2-4 professional factual tags"}. Do not repeat any sentence or fact block. Avoid boilerplate such as \"the current listing details include\", \"for professionals and clients reviewing available properties\", \"review the verified details\", and \"the local market\".`;
  const common = `ALLOWED_FACTS: ${allowedFacts}. ALLOWED_NEUTRAL_FRAMING: just listed; now available; take a look; explore this listing; see or browse the listing photos; learn more; request details; schedule a showing; contact the verified business. FORBIDDEN unless explicitly present in ALLOWED_FACTS: beautiful, charming, spacious, stunning, desirable, peaceful, welcoming, perfect for, ideal for, great for, investment opportunity, family friendly, neighborhood quality, convenience or location quality, lifestyle, condition, renovation, layout, comfort, potential, suitability, community claims, or inferences from photos. Every factual property assertion must map directly to ALLOWED_FACTS. ${contract}`;
  if (attempt === 1) return `Create a grounded, natural ${channel} listing post. ${common} Platform style: ${channel === "INSTAGRAM" ? "concise visual introduction, verified facts, short CTA, hashtags" : channel === "FACEBOOK" ? "a fuller verified-fact overview and request-details/showing CTA" : "a professional listing update and business-oriented CTA"}.`;
  const feedback = rejectedPhrases.length ? `REJECTED_PREVIOUSLY: ${[...new Set(rejectedPhrases)].map((phrase) => `"${phrase}"`).join(", ")}.` : "The prior output failed factuality validation.";
  if (attempt === 2) return `Rewrite the prior ${channel} result under tighter constraints. ${feedback} Remove those claims and their synonyms; do not replace one subjective claim with another. ${common} Required order: neutral hook, verified fact sentences with an optional listing-photo invitation, CTA, then permitted hashtags.`;
  return `STRICT GROUNDED COMPOSITION for ${channel}. ${feedback} Use only these four components: (1) the neutral hook "${SAFE_HOOKS[channel]}", (2) natural sentences using exact verified facts from ALLOWED_FACTS and, when useful, a neutral invitation to browse the listing photos, (3) the CTA "${SAFE_CTAS[channel]}", and (4) permitted factual hashtags. Each component must be distinct. You may vary grammar but may not add any other property description or claim. ${common}`;
}

export function composeStructuredProspectBody(draft, channel) {
  if (!draft?.hooks?.length || !draft?.cta) return draft?.body || "";
  const hashtags = (draft.hashtags || []).map((tag) => `#${String(tag).replace(/^#+/, "")}`).join(" ");
  return [draft.hooks[0].trim(), draft.body?.trim(), draft.cta.trim(), channel === "FACEBOOK" && !hashtags ? null : hashtags].filter(Boolean).join("\n\n");
}

export function repairStructuredProspectDraft(draft, item) {
  if (!draft?.body) return draft;
  const hook = draft.hooks?.[0] || "";
  const cta = draft.cta || "";
  const componentText = new Set([hook, cta].map(normalizedCompositionText).filter(Boolean));
  const data = item.dataJson || {};
  const allowedNumbers = new Set([data.street?.match(/^\d+/)?.[0], data.zip, data.price, data.bedrooms, data.bathrooms, data.sqft, data.yearBuilt]
    .filter((value) => value !== null && value !== undefined).map((value) => String(value).replace(/[^0-9]/g, "")));
  const parts = String(draft.body).split(/\n+|(?<=[.!?])\s+/).map((part) => part.trim()).filter(Boolean);
  const safe = parts.filter((part) => {
    const normalized = normalizedCompositionText(part);
    if ([...componentText].some((component) => normalized === component || normalized.startsWith(component))) return false;
    if (findUnsupportedPropertyClaim(part, item)) return false;
    return !(part.match(/\$?[\d][\d,]*/g) || []).some((value) => !allowedNumbers.has(value.replace(/[^0-9]/g, "")));
  });
  return { ...draft, body: safe.join(" ") };
}

function normalizedCompositionText(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9#]+/g, " ").trim();
}

function wordSimilarity(left, right) {
  const a = new Set(normalizedCompositionText(left).split(/\s+/).filter((word) => word.length > 2));
  const b = new Set(normalizedCompositionText(right).split(/\s+/).filter((word) => word.length > 2));
  if (!a.size || !b.size) return 0;
  const shared = [...a].filter((word) => b.has(word)).length;
  return shared / Math.min(a.size, b.size);
}

export function validateProspectComposition(body, { hook = null, cta = null } = {}) {
  const text = String(body || "").trim();
  const paragraphs = text.split(/\n\s*\n/).map((part) => part.trim()).filter(Boolean);
  if (!text || paragraphs.some((part) => normalizedCompositionText(part).length < 3)) return { valid: false, reason: "EMPTY_POST_COMPONENT" };
  const normalizedParagraphs = paragraphs.map(normalizedCompositionText);
  if (new Set(normalizedParagraphs).size !== normalizedParagraphs.length) return { valid: false, reason: "DUPLICATE_POST_COMPONENT" };
  if (paragraphs.filter((part) => /^\s*(?:#\w+[\s]*)+$/u.test(part)).length > 1) return { valid: false, reason: "DUPLICATE_POST_COMPONENT" };
  const sentences = text.split(/\n+|(?<=[.!?])\s+/).map((part) => part.trim()).filter((part) => normalizedCompositionText(part).length >= 3);
  const normalizedSentences = sentences.map(normalizedCompositionText);
  if (new Set(normalizedSentences).size !== normalizedSentences.length) return { valid: false, reason: "DUPLICATE_POST_COMPONENT" };
  for (let index = 1; index < sentences.length; index += 1) {
    if (wordSimilarity(sentences[index - 1], sentences[index]) >= 0.8) return { valid: false, reason: "DUPLICATE_POST_COMPONENT" };
    const previousFacts = sentences[index - 1].match(/\$?[\d][\d,]*/g) || [];
    const currentFacts = sentences[index].match(/\$?[\d][\d,]*/g) || [];
    if (previousFacts.length >= 2 && previousFacts.filter((fact) => currentFacts.includes(fact)).length >= 2) return { valid: false, reason: "DUPLICATE_POST_COMPONENT" };
  }
  const normalizedBody = normalizedCompositionText(text);
  for (const component of [hook, cta].filter(Boolean)) {
    const normalized = normalizedCompositionText(component);
    if (normalized && normalizedBody.split(normalized).length - 1 > 1) return { valid: false, reason: "DUPLICATE_POST_COMPONENT" };
  }
  if (PROSPECT_BOILERPLATE.some((pattern) => pattern.test(text))) return { valid: false, reason: "PROSPECT_COPY_BOILERPLATE" };
  return { valid: true };
}

export function validateStructuredProspectDraft(draft, item, channel) {
  if (!draft?.hooks?.length || !draft?.cta || !draft?.body?.trim()) return { valid: false, reason: "INCOMPLETE_OUTPUT_CONTRACT" };
  const hook = draft.hooks[0].trim();
  const cta = draft.cta.trim();
  if (!/just listed|new (?:property )?listing|now available|take a look|explore|property listing|listing update/i.test(hook)) return { valid: false, reason: "UNSAFE_HOOK" };
  if (!/contact|message|request|schedule|learn more|showing|details/i.test(cta)) return { valid: false, reason: "UNSAFE_CTA" };
  const componentCopy = `${hook}\n${draft.body}\n${cta}`;
  const unsupported = findUnsupportedPropertyClaim(componentCopy, item);
  if (unsupported) return { valid: false, reason: "UNSUPPORTED_PROPERTY_CLAIM", matchedText: componentCopy.match(unsupported)?.[0] };
  const data = item.dataJson || {};
  const allowedNumbers = new Set([data.street?.match(/^\d+/)?.[0], data.zip, data.price, data.bedrooms, data.bathrooms, data.sqft, data.yearBuilt].filter((value) => value !== null && value !== undefined).map((value) => String(value).replace(/[^0-9]/g, "")));
  const numericClaims = draft.body.match(/\$?[\d][\d,]*/g) || [];
  const unsupportedNumber = numericClaims.find((value) => !allowedNumbers.has(value.replace(/[^0-9]/g, "")));
  if (unsupportedNumber) return { valid: false, reason: "UNSUPPORTED_NUMERIC_CLAIM", matchedText: unsupportedNumber };
  const normalizedBody = draft.body.toLowerCase().replace(/[^a-z0-9]/g, "");
  const verifiedFactsUsed = [data.street, data.city, data.zip, data.price, data.bedrooms, data.bathrooms, data.sqft, data.yearBuilt].filter((value) => value !== null && value !== undefined && value !== "").filter((value) => normalizedBody.includes(String(value).toLowerCase().replace(/[^a-z0-9]/g, "")));
  if (verifiedFactsUsed.length < 2) return { valid: false, reason: "INSUFFICIENT_VERIFIED_FACTS" };
  if (channel === "INSTAGRAM" && (!Array.isArray(draft.hashtags) || draft.hashtags.length < 2)) return { valid: false, reason: "INCOMPLETE_OUTPUT_CONTRACT" };
  const assembled = composeStructuredProspectBody(draft, channel);
  const composition = validateProspectComposition(assembled, { hook, cta });
  return composition.valid ? validateGeneratedPropertyBody(assembled, item) : composition;
}

export function evaluateProspectGenerationAttempt(draft, item, channel) {
  const repairedDraft = repairStructuredProspectDraft(draft, item);
  const body = composeStructuredProspectBody(repairedDraft, channel);
  return { repairedDraft, body, validation: validateStructuredProspectDraft(repairedDraft, item, channel) };
}

export function listingPhotoKey(url) {
  try {
    const parsed = new URL(url);
    const photoNumber = parsed.pathname.match(/(?:^|[_/-])(P\d{2,})(?:[_./-]|$)/i)?.[1];
    if (photoNumber) return photoNumber.toUpperCase();
    return parsed.pathname.toLowerCase().replace(/(?:_|-)(?:thumb|small|medium|large|\d+x\d+)(?=\.|_|-)/g, "");
  } catch { return String(url); }
}

export function propertyAssetIdentity(asset) {
  if (asset?.sourceKey) return `source:${asset.sourceKey}`;
  const providerId = asset?.providerImageId || asset?.sourceImageId || asset?.externalId || asset?.metadata?.providerImageId || asset?.metadata?.photoId;
  if (providerId) return `provider:${String(providerId).trim().toLowerCase()}`;
  const url = asset?.sourceUrl || asset?.url;
  if (url) {
    try {
      const parsed = new URL(url);
      const pathname = parsed.pathname.toLowerCase().replace(/(?:_|-)(?:thumb|small|medium|large|\d+x\d+)(?=\.|_|-)/g, "");
      return `url:${parsed.hostname.toLowerCase()}${pathname}`;
    } catch { return `url:${String(url).toLowerCase()}`; }
  }
  return asset?.id ? `asset:${asset.id}` : null;
}

const PROPERTY_SCENES = ["main_front_exterior", "alternate_exterior", "side_rear_exterior", "yard_land", "garage_outbuilding", "kitchen", "living_interior", "bedroom", "bathroom", "porch_patio_deck", "other_detail", "unusable"];

function propertyScene(asset) {
  return asset.tags?.find((tag) => tag.startsWith("prospect-scene:"))?.slice(15) || "unclassified";
}

export function rankPropertyAssets(assets) {
  const weights = { main_front_exterior: 120, alternate_exterior: 100, aerial: 75, side_rear_exterior: 70, porch: 55, patio: 55, porch_patio_deck: 55, backyard: 52, yard_land: 50, kitchen: 45, living_interior: 42, dining_room: 40, other_interior: 36, bedroom: 35, bathroom: 32, floorplan: 25, other_detail: 20, garage_outbuilding: 8, unusable: -200, unclassified: 30 };
  return assets.map((asset, sourceIndex) => ({ asset, sourceIndex, scene: propertyScene(asset), score: (weights[propertyScene(asset)] ?? 0) + (asset.tags?.includes("prospect-clear-view") ? 15 : 0) - (asset.tags?.includes("prospect-obstructed") ? 30 : 0) + (asset.qualityScore || 0) * 5 + Math.min((asset.width || 0) * (asset.height || 0) / 1_000_000, 5) }))
    .sort((a, b) => b.score - a.score || a.sourceIndex - b.sourceIndex);
}

export function buildPropertyMediaPlan(assets) {
  const ranked = rankPropertyAssets(assets);
  const usable = ranked.filter(({ scene }) => scene !== "unusable");
  const exteriors = usable.filter(({ scene }) => ["main_front_exterior", "alternate_exterior", "side_rear_exterior"].includes(scene));
  const heroPool = exteriors.length ? exteriors : usable;
  const heroFor = (index) => heroPool[Math.min(index, heroPool.length - 1)]?.asset || null;
  const contextualSupport = usable.filter(({ scene }) => ["kitchen", "living_interior", "dining_room", "other_interior", "backyard", "yard_land", "bedroom", "bathroom"].includes(scene));
  const detailSupport = usable.filter(({ scene }) => ["porch", "patio", "porch_patio_deck"].includes(scene));
  const supportPool = [...contextualSupport, ...detailSupport];
  const galleryFor = (hero, count, heroIndex) => {
    if (!hero) return [];
    const alternateExterior = heroPool.length > 1 ? heroPool[(heroIndex + 1) % heroPool.length] : null;
    // Keep the first two gallery positions exterior-led, then prefer useful
    // interior/context imagery over a higher-scoring close-up or detail.
    const supporting = supportPool.length ? supportPool[heroIndex % supportPool.length] : null;
    const ordered = [hero, alternateExterior?.asset, supporting?.asset, ...usable.map(({ asset }) => asset)].filter(Boolean);
    return [...new Map(ordered.map((asset) => [asset.id, asset])).values()].slice(0, count);
  };
  const instagramHero = heroFor(0);
  const facebookHero = heroFor(1);
  const linkedinHero = heroFor(2);
  return { featured: instagramHero, INSTAGRAM: galleryFor(instagramHero, 3, 0), FACEBOOK: galleryFor(facebookHero, 3, 1), LINKEDIN: galleryFor(linkedinHero, 1, 2) };
}

const FEATURE_SCENES = Object.freeze([
  { pattern: /\bkitchens?\b/i, scenes: ["kitchen"] },
  { pattern: /\b(?:primary |master )?bedrooms?\b/i, scenes: ["bedroom"] },
  { pattern: /\bbath(?:room)?s?\b/i, scenes: ["bathroom"] },
  { pattern: /\b(?:back\s?yards?|yards?|land)\b/i, scenes: ["backyard", "yard_land"] },
  { pattern: /\bpool(?:s|side)?\b/i, scenes: ["pool"] },
  { pattern: /\bfireplaces?\b/i, scenes: ["fireplace", "living_interior"] },
  { pattern: /\bgarages?\b/i, scenes: ["garage_outbuilding"] },
  { pattern: /\bbasements?\b/i, scenes: ["basement", "other_interior"] },
  { pattern: /\bliving (?:room|area)s?\b/i, scenes: ["living_interior"] },
  { pattern: /\b(?:views?|aerial)\b/i, scenes: ["aerial", "yard_land", "alternate_exterior"] },
  { pattern: /\b(?:patios?|porches?|decks?)\b/i, scenes: ["porch_patio_deck", "patio", "porch"] },
]);

function requestedFeatureScenes(body) {
  return FEATURE_SCENES.find(({ pattern }) => pattern.test(body || ""))?.scenes || [];
}

export function allocateProspectPreviewMedia(drafts, contextForDraft) {
  const usedPrimary = new Set();
  const allocations = drafts.map((draft) => {
    const assets = contextForDraft(draft)?.propertyAssets || [];
    const featureScenes = requestedFeatureScenes(draft.body);
    const ranked = rankPropertyAssets(assets)
      .filter(({ scene }) => scene !== "unusable")
      .map((candidate) => ({ ...candidate, identity: propertyAssetIdentity(candidate.asset), relevance: featureScenes.includes(candidate.scene) ? 1000 : 0 }))
      .filter(({ identity }, index, all) => identity && all.findIndex((item) => item.identity === identity) === index)
      .sort((a, b) => b.relevance - a.relevance || Number(usedPrimary.has(a.identity)) - Number(usedPrimary.has(b.identity)) || b.score - a.score || a.sourceIndex - b.sourceIndex);
    const primary = ranked[0] || null;
    const reuseUnavoidable = Boolean(primary) && usedPrimary.has(primary.identity);
    if (primary) usedPrimary.add(primary.identity);
    return { draft, ranked, primary, reuseUnavoidable };
  });
  const usedGallery = new Set(allocations.map(({ primary }) => primary?.identity).filter(Boolean));
  return allocations.map(({ draft, ranked, primary, reuseUnavoidable }) => {
    const count = draft.channel === "LINKEDIN" ? 1 : 3;
    const remaining = ranked.filter(({ identity }) => identity !== primary?.identity)
      .sort((a, b) => Number(usedGallery.has(a.identity)) - Number(usedGallery.has(b.identity)) || b.relevance - a.relevance || b.score - a.score || a.sourceIndex - b.sourceIndex);
    const selected = [primary, ...remaining].filter(Boolean).slice(0, count);
    selected.forEach(({ identity }) => usedGallery.add(identity));
    return { draft, assets: selected.map(({ asset }) => asset), reuseUnavoidable };
  });
}

async function classifyPropertyAsset(asset, actor) {
  if (!asset.url || asset.tags?.some((tag) => tag.startsWith("prospect-scene:"))) return asset;
  const prompt = `Classify this real-estate listing photo. Return JSON with category (exactly one of: ${PROPERTY_SCENES.join(", ")}), obstructed (boolean), and clearWholePropertyView (boolean). main_front_exterior means the primary residence shown substantially and clearly from the front; garage_outbuilding must not be used for a detached or secondary structure.`;
  try {
    const startedAt = Date.now();
    const result = await extractFromImage({ base64: asset.url, prompt, timeoutMs: 20_000 });
    const category = PROPERTY_SCENES.includes(result.parsed?.category) ? result.parsed.category : "other_detail";
    const semanticTags = [`prospect-scene:${category}`, ...(result.parsed?.obstructed ? ["prospect-obstructed"] : []), ...(result.parsed?.clearWholePropertyView ? ["prospect-clear-view"] : [])];
    const updated = await prisma.mediaAsset.update({ where: { id: asset.id }, data: { tags: [...new Set([...(asset.tags || []), ...semanticTags])] } });
    trackAiUsage({ userId: actor, clientId: asset.clientId, actionType: "EXTRACT_IMAGE", model: result.model, promptTokens: result.usage?.prompt_tokens ?? 0, completionTokens: result.usage?.completion_tokens ?? 0, taskName: "vision_auto_tag", schemaName: "prospect_property_scene", provider: "openai", latencyMs: Date.now() - startedAt, source: "prospect_preparation", artifactIds: { assetId: asset.id } });
    return updated;
  } catch { return asset; }
}

async function cachePropertyImages(clientId, item, actor) {
  // Six source images are enough to build the three compact preview
  // galleries. Avoid downloading and vision-classifying an entire MLS album.
  return ingestPropertyMedia(clientId, item, actor, { maxImages: 6 });
}

function initialPlatformStates(channels) {
  return Object.fromEntries(normalizeProspectChannels(channels).map((channel) => [channel, { status: "NOT_STARTED", attemptCount: 0, provenance: null, rejectionCategory: null, updatedAt: null }]));
}

async function updatePreparationRun(runId, data) {
  return prisma.prospectPreparationRun.update({ where: { id: runId }, data: { ...data, heartbeatAt: new Date() } });
}

async function updatePlatformRun(runId, channel, patch) {
  const run = await prisma.prospectPreparationRun.findUnique({ where: { id: runId }, select: { platformStates: true } });
  const current = run?.platformStates || initialPlatformStates([]);
  return updatePreparationRun(runId, { platformStates: { ...current, [channel]: { ...current[channel], ...patch, updatedAt: new Date().toISOString() } } });
}

export async function reconcileProspectPreparationRuns() {
  const staleRunningBefore = new Date(Date.now() - 15 * 60_000);
  const staleQueuedBefore = new Date(Date.now() - 2 * 60 * 60_000);
  const activeRuns = await prisma.prospectPreparationRun.findMany({
    where: { status: { in: ["QUEUED", "RUNNING"] } },
    select: { id: true, prospectWorkspaceId: true, status: true, heartbeatAt: true },
  });
  const stale = activeRuns.filter((run) => run.heartbeatAt < (run.status === "QUEUED" ? staleQueuedBefore : staleRunningBefore));
  const staleIds = new Set(stale.map((run) => run.id));
  const queuedWorkspaceIds = activeRuns.filter((run) => run.status === "QUEUED" && !staleIds.has(run.id)).map((run) => run.prospectWorkspaceId);
  const runningWorkspaceIds = activeRuns.filter((run) => run.status === "RUNNING" && !staleIds.has(run.id)).map((run) => run.prospectWorkspaceId);
  const results = await prisma.$transaction([
    ...(stale.length ? [
      prisma.prospectPreparationRun.updateMany({ where: { id: { in: stale.map((run) => run.id) }, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "FAILED", stage: "FAILED", failureCode: "STALE_RUN", failureMessage: "Preparation stopped reporting progress and can be retried.", completedAt: new Date() } }),
      prisma.agentOutreachProspect.updateMany({ where: { prospectWorkspaceId: { in: stale.map((run) => run.prospectWorkspaceId) }, status: { in: ["PREVIEW_PENDING", "PREVIEW_GENERATING"] } }, data: { status: "PREVIEW_FAILED", lastError: "Preparation stopped reporting progress and can be retried." } }),
    ] : []),
    ...(queuedWorkspaceIds.length ? [prisma.agentOutreachProspect.updateMany({ where: { prospectWorkspaceId: { in: queuedWorkspaceIds }, status: "PREVIEW_GENERATING" }, data: { status: "PREVIEW_PENDING" } })] : []),
    ...(runningWorkspaceIds.length ? [prisma.agentOutreachProspect.updateMany({ where: { prospectWorkspaceId: { in: runningWorkspaceIds }, status: "PREVIEW_PENDING" }, data: { status: "PREVIEW_GENERATING" } })] : []),
    prisma.agentOutreachProspect.updateMany({
      where: {
        status: { in: ["PREVIEW_PENDING", "PREVIEW_GENERATING"] },
        updatedAt: { lt: staleRunningBefore },
        prospectWorkspace: { preparationRuns: { none: { status: { in: ["QUEUED", "RUNNING"] } } } },
      },
      data: { status: "PREVIEW_FAILED", lastError: "Preview preparation is no longer active and can be retried." },
    }),
  ]);
  return { stale: stale.length, queued: queuedWorkspaceIds.length, running: runningWorkspaceIds.length, orphaned: results.at(-1)?.count || 0 };
}

export async function startProspectPreparation(id, input, adminSub) {
  let prospect = await prisma.prospectWorkspace.findUnique({ where: { id }, include: { client: { select: { lifecycle: true, industryKey: true } } } });
  if (!prospect || prospect.client.lifecycle !== "PROSPECT") throw Object.assign(new Error("Prospect workspace not found"), { status: 404, code: "NOT_FOUND" });
  if (prospect.client.industryKey !== "real_estate") throw importFailure("Automatic listing preparation is currently available for Real Estate prospects only");
  const selectedChannels = normalizeProspectChannels(input.selectedChannels || prospect.selectedChannels);
  if (input.selectedChannels) {
    prospect = await prisma.prospectWorkspace.update({ where: { id }, data: { selectedChannels }, include: { client: { select: { lifecycle: true, industryKey: true } } } });
    const removed = PROSPECT_CHANNELS.filter((channel) => !selectedChannels.includes(channel));
    if (removed.length) await prisma.prospectPreviewItem.deleteMany({ where: { prospectWorkspaceId: id, draft: { channel: { in: removed } } } });
  }
  const staleBefore = new Date(Date.now() - 15 * 60_000);
  await prisma.prospectPreparationRun.updateMany({ where: { prospectWorkspaceId: id, status: { in: ["QUEUED", "RUNNING"] }, heartbeatAt: { lt: staleBefore } }, data: { status: "FAILED", stage: "FAILED", failureCode: "STALE_RUN", failureMessage: "Preparation stopped reporting progress and can be retried.", completedAt: new Date() } });
  let run;
  try {
    run = await prisma.prospectPreparationRun.create({ data: { prospectWorkspaceId: id, requestedBy: adminSub, sourceUrl: input.sourceUrl || null, selectedListings: input.selectedListings || undefined, platformStates: initialPlatformStates(selectedChannels), expectedCount: selectedChannels.length, heartbeatAt: new Date() } });
  } catch (error) {
    if (error?.code !== "P2002") throw error;
    run = await prisma.prospectPreparationRun.findFirst({ where: { prospectWorkspaceId: id, status: { in: ["QUEUED", "RUNNING"] } }, orderBy: { createdAt: "desc" } });
    if (run) return { run, attached: true };
    throw error;
  }
  const queue = getProspectPreparationQueue();
  if (!queue) {
    await failPreparationRun(run.id, Object.assign(new Error("Preparation worker is unavailable"), { code: "QUEUE_UNAVAILABLE" }));
    throw Object.assign(new Error("Preparation worker is unavailable"), { status: 503, code: "QUEUE_UNAVAILABLE" });
  }
  try {
    await queue.add("prepare", { runId: run.id }, { jobId: run.id });
  } catch (error) {
    await failPreparationRun(run.id, Object.assign(error, { code: "QUEUE_ENQUEUE_FAILED" }));
    throw Object.assign(new Error("Preparation could not be queued"), { status: 503, code: "QUEUE_ENQUEUE_FAILED" });
  }
  return { run, attached: false };
}

export async function failPreparationRun(runId, error) {
  const message = error?.status && error.status < 500 ? error.message : "Preparation could not be completed. Retry when ready.";
  const run = await prisma.prospectPreparationRun.findUnique({ where: { id: runId }, select: { platformStates: true } });
  const terminal = new Set(["AI_ACCEPTED", "FALLBACK_ACCEPTED"]);
  const platformStates = Object.fromEntries(Object.entries(run?.platformStates || {}).map(([channel, state]) => [channel, terminal.has(state.status) ? state : { ...state, status: "FAILED", rejectionCategory: error?.code || "PREPARATION_FAILED", updatedAt: new Date().toISOString() }]));
  const result = await prisma.prospectPreparationRun.updateMany({ where: { id: runId, status: { in: ["QUEUED", "RUNNING"] } }, data: { status: "FAILED", stage: "FAILED", platformStates, failureCode: error?.code || "PREPARATION_FAILED", failureMessage: message, completedAt: new Date(), heartbeatAt: new Date() } });
  const failedRun = result.count ? await prisma.prospectPreparationRun.findUnique({ where: { id: runId }, select: { prospectWorkspaceId: true } }) : null;
  if (failedRun) await prisma.agentOutreachProspect.updateMany({ where: { prospectWorkspaceId: failedRun.prospectWorkspaceId }, data: { status: "PREVIEW_FAILED", lastError: message } });
  return result;
}

export async function executeProspectPreparation(runId) {
  const run = await prisma.prospectPreparationRun.findUnique({ where: { id: runId } });
  if (!run || !["QUEUED", "RUNNING"].includes(run.status)) return run;
  await updatePreparationRun(runId, { status: "RUNNING", stage: "IMPORTING_LISTING", startedAt: run.startedAt || new Date() });
  const id = run.prospectWorkspaceId;
  await prisma.agentOutreachProspect.updateMany({
    where: { prospectWorkspaceId: id, status: { in: ["PREVIEW_PENDING", "PREVIEW_GENERATING"] } },
    data: { status: "PREVIEW_GENERATING", lastError: null },
  });
  const input = { sourceUrl: run.sourceUrl || undefined };
  const adminSub = run.requestedBy;
  const prospect = await prisma.prospectWorkspace.findUnique({ where: { id }, include: { client: true } });
  if (!prospect || prospect.client.lifecycle !== "PROSPECT") throw Object.assign(new Error("Prospect workspace not found"), { status: 404, code: "NOT_FOUND" });
  if (prospect.client.industryKey !== "real_estate") throw importFailure("Automatic listing preparation is currently available for Real Estate prospects only");
  const requestedListings = Array.isArray(run.selectedListings) && run.selectedListings.length ? run.selectedListings : [{ listingUrl: input.sourceUrl || prospect.sourceUrl }];
  const listingSelections = requestedListings.map((listing) => ({ ...listing, sourceUrl: listing.listingUrl || listing.sourceUrl })).filter((listing) => listing.sourceUrl);
  if (!listingSelections.length) throw importFailure("No listing URL was supplied", { actions: ["ENTER_PROPERTY_ADDRESS", "ADD_PROPERTY_MANUALLY"] });

  const listingContexts = new Map();
  for (const selection of listingSelections) {
    if (listingContexts.has(selection.sourceUrl)) continue;
    const analysis = await analyzeUrl(prospect.clientId, { url: selection.sourceUrl, singleListingOnly: true });
    const candidate = analysis.detectedType === "single_listing" ? analysis.listings?.[0] : null;
    const fallback = coldwellListingFallback(selection);
    if ((!candidate?.normalized || !isUsableProspectListing(candidate.normalized, analysis.confidence) || candidate.validation?.valid === false) && !fallback) {
      throw importFailure("We couldn't import this listing automatically.", { actions: ["RETRY_IMPORT", "ENTER_PROPERTY_ADDRESS", "ADD_PROPERTY_MANUALLY"], reason: analysis.reason || analysis.detectedType });
    }
    const selectedListing = { ...preferDiscoveredListingGallery(fillAddressFromTitle(candidate?.normalized && isUsableProspectListing(candidate.normalized, analysis.confidence) && candidate.validation?.valid !== false ? candidate.normalized : fallback), fallback), sourceUrl: selection.sourceUrl };
    const confirmed = await confirmUrl(prospect.clientId, { url: selection.sourceUrl, selectedListing });
    await updatePreparationRun(runId, { stage: "ENRICHING" });
    await enrichListingById(prospect.clientId, confirmed.dataItemId).catch(() => null);
    let item = await prisma.workspaceDataItem.findFirst({ where: { id: confirmed.dataItemId, clientId: prospect.clientId, type: "PROPERTY", status: "ACTIVE" } });
    if (!item) throw importFailure("The listing was resolved but the property could not be saved");
    let propertyAssets = [];
    await updatePreparationRun(runId, { stage: "PROCESSING_MEDIA" });
    try { ({ item, assets: propertyAssets } = await cachePropertyImages(prospect.clientId, item, adminSub)); } catch { propertyAssets = []; }
    listingContexts.set(selection.sourceUrl, { item, propertyAssets, candidate });
  }

  const itemIds = [...new Set([...listingContexts.values()].map((context) => context.item.id))];
  const existing = await prisma.draft.findMany({ where: { clientId: prospect.clientId, status: "DRAFT", OR: itemIds.map((itemId) => ({ warnings: { has: `prospectProperty:${itemId}` } })) }, orderBy: { createdAt: "desc" } });
  const selectedChannels = normalizeProspectChannels(prospect.selectedChannels);
  const drafts = [];
  const draftContexts = new Map();
  for (const [channelIndex, channel] of selectedChannels.entries()) {
    const listing = listingSelections[channelIndex % listingSelections.length];
    const context = listingContexts.get(listing.sourceUrl);
    const { item, propertyAssets } = context;
    let reusable = existing.find((draft) => draft.channel === channel && draft.warnings?.includes(`prospectProperty:${item.id}`));
    if (reusable) {
      const composition = validateProspectComposition(reusable.body);
      const validation = composition.valid ? validateGeneratedPropertyBody(reusable.body, item) : composition;
      if (!validation.valid) {
        await prisma.draft.update({ where: { id: reusable.id }, data: { status: "FAILED", warnings: { push: `PROSPECT_PROPERTY_FACT_GUARD:${validation.reason}` } } });
        reusable = null;
      }
    }
    if (reusable) {
      drafts.push(reusable);
      draftContexts.set(reusable.id, context);
      const fallback = reusable.warnings?.includes("PROSPECT_PROPERTY_VERIFIED_FALLBACK");
      await updatePlatformRun(runId, channel, { status: fallback ? "FALLBACK_ACCEPTED" : "AI_ACCEPTED", attemptCount: fallback ? 3 : 0, provenance: fallback ? "FALLBACK" : "AI", rejectionCategory: fallback ? "PRIOR_ATTEMPTS_EXHAUSTED" : null });
      await updatePreparationRun(runId, { readyCount: drafts.filter((draft) => selectedChannels.includes(draft.channel)).length });
      continue;
    }
    await updatePreparationRun(runId, { stage: "GENERATING" });
    let accepted = null;
    const rejectedPhrases = [];
    const generationStartedAt = Date.now();
    let lastRejectionCategory = null;
    let acceptedAttempt = null;
    for (let attempt = 1; attempt <= 3 && !accepted; attempt += 1) {
      await updatePlatformRun(runId, channel, { status: attempt === 1 ? "GENERATING" : "RETRYING", attemptCount: attempt, rejectionCategory: null });
      const guidance = buildProspectAttemptGuidance({ item, channel, attempt, rejectedPhrases });
      const draft = await generateDraft({ clientId: prospect.clientId, kind: "POST", channel, bucketKey: "just_listed", templateType: "just_listed", guidance, createdBy: adminSub, dataItemId: item.id, contentAngle: "just_listed", generationProfile: "grounded_property" });
      if (!draft || draft.status === "FAILED") {
        lastRejectionCategory = String(draft?.warnings?.[0] || "").match(/^\[([^\]]+)\]/)?.[1] || "GENERATION_FAILED";
        logEvent("prospect.generation.attempt_rejected", { platform: channel, attempt, rejectionCategory: lastRejectionCategory, providerResult: "FAILED" });
        await updatePlatformRun(runId, channel, { status: "RETRYING", attemptCount: attempt, rejectionCategory: lastRejectionCategory });
        continue;
      }
      await updatePlatformRun(runId, channel, { status: "VALIDATING", attemptCount: attempt });
      const { body: assembledBody, validation } = evaluateProspectGenerationAttempt(draft, item, channel);
      if (!validation.valid) {
        lastRejectionCategory = validation.reason;
        if (validation.matchedText) rejectedPhrases.push(validation.matchedText.slice(0, 80));
        await prisma.draft.update({ where: { id: draft.id }, data: { status: "FAILED", warnings: { push: `PROSPECT_PROPERTY_FACT_GUARD:${validation.reason}` } } });
        logEvent("prospect.generation.attempt_rejected", { platform: channel, attempt, rejectionCategory: validation.reason, providerResult: "SUCCEEDED" });
        await updatePlatformRun(runId, channel, { status: "RETRYING", attemptCount: attempt, rejectionCategory: validation.reason });
        continue;
      }
      accepted = await prisma.draft.update({ where: { id: draft.id }, data: { body: assembledBody, warnings: { push: `prospectProperty:${item.id}` } } });
      acceptedAttempt = attempt;
      await updatePlatformRun(runId, channel, { status: "AI_ACCEPTED", attemptCount: attempt, provenance: "AI", rejectionCategory: null });
    }
    if (!accepted) {
      const body = buildVerifiedPropertyFallback(item, channel, prospect.client.name);
      const composition = validateProspectComposition(body);
      const fallbackValidation = composition.valid ? validateGeneratedPropertyBody(body, item) : composition;
      if (!fallbackValidation.valid) throw Object.assign(new Error("Verified fallback failed composition validation"), { code: fallbackValidation.reason });
      accepted = await prisma.draft.create({ data: {
        clientId: prospect.clientId, kind: "POST", status: "DRAFT", channel,
        bucketKey: "just_listed", generationGuidance: "Verified-facts fallback after three rejected prospect generation attempts",
        body, hooks: [], hashtags: [], warnings: [`prospectProperty:${item.id}`, "PROSPECT_PROPERTY_VERIFIED_FALLBACK"],
        createdBy: adminSub,
      } });
      await updatePlatformRun(runId, channel, { status: "FALLBACK_ACCEPTED", attemptCount: 3, provenance: "FALLBACK", rejectionCategory: lastRejectionCategory || "ATTEMPTS_EXHAUSTED" });
    }
    drafts.push(accepted);
    draftContexts.set(accepted.id, context);
    logEvent("prospect.generation.completed", { platform: channel, attempts: acceptedAttempt || 3, provenance: accepted.warnings?.includes("PROSPECT_PROPERTY_VERIFIED_FALLBACK") ? "FALLBACK" : "AI", rejectionCategory: accepted.warnings?.includes("PROSPECT_PROPERTY_VERIFIED_FALLBACK") ? (lastRejectionCategory || "ATTEMPTS_EXHAUSTED") : null, durationMs: Date.now() - generationStartedAt });
    await updatePreparationRun(runId, { readyCount: drafts.length });
  }
  await updatePreparationRun(runId, { stage: "SELECTING" });
  const allocations = allocateProspectPreviewMedia(drafts, (draft) => draftContexts.get(draft.id));
  const distinctSelected = new Set(allocations.map(({ assets }) => propertyAssetIdentity(assets[0])).filter(Boolean));
  logEvent("prospect.images.allocated", { postCount: drafts.length, distinctListingCount: new Set([...draftContexts.values()].map((context) => context?.item?.id).filter(Boolean)).size, availableImagesByListing: Object.fromEntries([...new Set([...draftContexts.values()])].map((context) => [context?.item?.id, context?.propertyAssets?.length || 0]).filter(([itemId]) => itemId)), distinctImagesSelected: distinctSelected.size, reuseUnavoidable: allocations.some(({ reuseUnavoidable }) => reuseUnavoidable) });
  for (const { draft, assets: uniqueAssets, reuseUnavoidable } of allocations) {
    if (reuseUnavoidable) logEvent("prospect.images.reuse_unavoidable", { draftId: draft.id, channel: draft.channel, availableImageCount: draftContexts.get(draft.id)?.propertyAssets?.length || 0 });
    await prisma.draft.update({ where: { id: draft.id }, data: { mediaUrl: uniqueAssets[0]?.url || null, mediaType: uniqueAssets.length ? "image" : null } });
    await prisma.draftAsset.deleteMany({ where: { draftId: draft.id } });
    if (uniqueAssets.length) await prisma.draftAsset.createMany({ data: uniqueAssets.map((asset, orderIndex) => ({ draftId: draft.id, assetId: asset.id, role: orderIndex === 0 ? "primary" : "gallery", orderIndex })) });
  }
  await prisma.$transaction(async (tx) => {
    const selected = await tx.prospectPreviewItem.findMany({ where: { prospectWorkspaceId: id, itemType: "DRAFT" }, include: { draft: { select: { channel: true } } }, orderBy: { sortOrder: "asc" } });
    for (const draft of drafts) {
      const samePlatform = selected.filter((item) => item.draft?.channel === draft.channel);
      if (!samePlatform.length || samePlatform.some((item) => item.draftId === draft.id)) continue;
      const retained = samePlatform[0];
      await tx.prospectPreviewItem.deleteMany({ where: { id: { in: samePlatform.map((item) => item.id) } } });
      await tx.prospectPreviewItem.create({ data: { prospectWorkspaceId: id, itemType: "DRAFT", draftId: draft.id, sortOrder: retained.sortOrder, addedBy: adminSub } });
    }
  });
  const finalRun = await prisma.prospectPreparationRun.findUnique({ where: { id: runId } });
  const warningCount = Object.values(finalRun.platformStates || {}).filter((state) => state.provenance === "FALLBACK").length;
  await updatePreparationRun(runId, { status: warningCount ? "COMPLETE_WITH_WARNINGS" : "COMPLETE", stage: "COMPLETE", readyCount: drafts.length, warningCount, completedAt: new Date() });
  const outreach = await prisma.agentOutreachProspect.findUnique({ where: { prospectWorkspaceId: id }, select: { id: true } });
  if (outreach) {
    await prisma.$transaction(async (tx) => {
      const previewItemIds = [...itemIds, ...drafts.map((draft) => draft.id)];
      await tx.prospectPreviewItem.deleteMany({ where: { prospectWorkspaceId: id } });
      await tx.prospectPreviewItem.createMany({ data: previewItemIds.map((recordId, sortOrder) => ({ prospectWorkspaceId: id, itemType: sortOrder < itemIds.length ? "DATA_ITEM" : "DRAFT", dataItemId: sortOrder < itemIds.length ? recordId : null, draftId: sortOrder < itemIds.length ? null : recordId, sortOrder, addedBy: adminSub })) });
      await tx.agentOutreachProspect.update({ where: { id: outreach.id }, data: { status: "READY_TO_EMAIL", previewGeneratedAt: new Date(), lastError: null, events: { create: { type: "preview_generated" } } } });
    });
  }
  const contexts = [...listingContexts.values()];
  return { itemId: contexts[0].item.id, itemIds, draftIds: drafts.map((draft) => draft.id), imageImported: contexts.some((context) => context.propertyAssets.length > 0), importedImageCount: contexts.reduce((total, context) => total + context.propertyAssets.length, 0), importQuality: contexts[0].candidate.quality, preparationState: "READY_UNSELECTED", runId };
}

export async function rotatePreview(id) {
  const previewToken = generateSecret();
  const row = await prisma.prospectWorkspace.update({
    where: { id }, data: { previewTokenHash: digestSecret(previewToken), previewStatus: "ACTIVE" }, include: { client: true },
  });
  return { ...formatAdminProspect(row, row.client), previewToken };
}

export async function revokeClaim(id) {
  return prisma.$transaction(async (tx) => {
    const existing = await tx.prospectWorkspace.findUnique({ where: { id }, include: { client: { select: { lifecycle: true } } } });
    if (!existing) throw Object.assign(new Error("Prospect workspace not found"), { status: 404, code: "NOT_FOUND" });
    if (existing.client.lifecycle !== "PROSPECT" || existing.claimStatus === "CLAIMED") throw Object.assign(new Error("Claimed workspaces cannot be revoked"), { status: 409, code: "ALREADY_CLAIMED" });
    return tx.prospectWorkspace.update({ where: { id }, data: { claimTokenHash: null, claimStatus: "REVOKED" } });
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
}

export async function revokePreview(id) {
  return prisma.prospectWorkspace.update({ where: { id }, data: { previewStatus: "REVOKED" } });
}

const previewInclude = {
  client: { include: { brandProfile: true, _count: { select: { dataItems: true, drafts: true } } } },
  previewItems: {
    orderBy: { sortOrder: "asc" },
    include: {
      dataItem: true,
      draft: { include: { draftAssets: { take: 10, orderBy: { orderIndex: "asc" }, include: { asset: true } } } },
    },
  },
};

function formatSafePreview(row) {
  if (!row || row.previewStatus !== "ACTIVE" || row.client.lifecycle !== "PROSPECT") return null;
  const claimAvailable = row.claimStatus === "CLAIMABLE" && row.claimExpiresAt > new Date();
  const items = row.previewItems.filter((selection) => selection.itemType === "DATA_ITEM" && selection.dataItem?.status === "ACTIVE").map(({ dataItem: item }) => ({
    type: item.type, title: item.title, summary: item.summary,
    imageUrl: typeof item.dataJson?.imageUrl === "string" ? item.dataJson.imageUrl : null,
    ...(item.type === "PROPERTY" ? { property: {
      address: [item.dataJson?.street, item.dataJson?.city, item.dataJson?.state, item.dataJson?.zip].filter(Boolean).join(", ") || item.title,
      price: typeof item.dataJson?.price === "number" ? item.dataJson.price : null,
      beds: typeof item.dataJson?.bedrooms === "number" ? item.dataJson.bedrooms : null,
      baths: typeof item.dataJson?.bathrooms === "number" ? item.dataJson.bathrooms : null,
      sqft: typeof item.dataJson?.sqft === "number" ? item.dataJson.sqft : null,
      yearBuilt: typeof item.dataJson?.yearBuilt === "number" ? item.dataJson.yearBuilt : null,
      status: typeof item.dataJson?.status === "string" ? item.dataJson.status : null,
    } } : {}),
  }));
  const previewDraftSelections = [];
  for (const selection of row.previewItems) {
    const draft = selection.draft;
    if (selection.itemType !== "DRAFT" || !["DRAFT", "PENDING_REVIEW", "APPROVED"].includes(draft?.status)) continue;
    if (!normalizeProspectChannels(row.selectedChannels).includes(draft.channel)) continue;
    const propertyDraft = draft.warnings?.some((warning) => warning.startsWith("prospectProperty:"));
    if (propertyDraft && items.some((item) => item.imageUrl) && !draft.draftAssets?.length) continue;
    previewDraftSelections.push(selection);
  }
  const drafts = selectCanonicalProspectDrafts(previewDraftSelections, normalizeProspectChannels(row.selectedChannels)).map(({ draft }) => ({ channel: draft.channel, body: draft.body, mediaUrl: draft.mediaUrl, media: (draft.draftAssets ?? []).map(({ asset, orderIndex }) => ({ url: asset.url, thumbnailUrl: asset.thumbnailUrl, assetType: asset.assetType, altText: asset.altText, orderIndex })) }));
  return {
    businessName: row.client.name,
    prospectName: row.prospectName,
    industryKey: row.client.industryKey,
    logoUrl: row.client.logoUrl,
    brand: row.client.brandProfile ? { description: row.client.brandProfile.description, website: row.client.brandProfile.website, city: row.client.brandProfile.city, state: row.client.brandProfile.state } : null,
    items,
    drafts,
    preparationState: items.length + drafts.length > 0 ? "SELECTED" : (row.client._count?.dataItems ?? 0) + (row.client._count?.drafts ?? 0) > 0 ? "READY_UNSELECTED" : "NOT_STARTED",
    claimAvailable,
    claimStatus: claimAvailable ? "CLAIMABLE" : row.claimStatus === "CLAIMED" ? "CLAIMED" : "UNAVAILABLE",
  };
}

export async function getPublicPreview(previewToken) {
  if (typeof previewToken !== "string" || previewToken.length < 40 || previewToken.length > 100) return null;
  const row = await prisma.prospectWorkspace.findUnique({ where: { previewTokenHash: digestSecret(previewToken) }, include: previewInclude });
  return formatSafePreview(row);
}

export async function getInvitationPreview(prospectId, verifiedEmail) {
  const email = normalizeIdentityEmail(verifiedEmail);
  if (!email || !prospectId) return null;
  const row = await prisma.prospectWorkspace.findFirst({
    where: { id: prospectId, prospectEmail: { equals: email, mode: "insensitive" }, claimStatus: "CLAIMABLE", claimExpiresAt: { gt: new Date() }, client: { lifecycle: "PROSPECT" } },
    include: previewInclude,
  });
  return formatSafePreview(row);
}

export async function inspectClaim(claimToken) {
  if (typeof claimToken !== "string" || claimToken.length < 40 || claimToken.length > 100) return { valid: false };
  const row = await prisma.prospectWorkspace.findUnique({ where: { claimTokenHash: digestSecret(claimToken) }, include: { client: { select: { name: true, lifecycle: true } } } });
  if (!row || row.claimStatus !== "CLAIMABLE" || row.client.lifecycle !== "PROSPECT" || row.claimExpiresAt <= new Date()) return { valid: false };
  return { valid: true, businessName: row.client.name, prospectName: row.prospectName, expiresAt: row.claimExpiresAt };
}

export async function discoverPendingClaims(verifiedEmail) {
  const email = normalizeIdentityEmail(verifiedEmail);
  if (!email) return [];
  const rows = await prisma.prospectWorkspace.findMany({
    where: { prospectEmail: { equals: email, mode: "insensitive" }, claimStatus: "CLAIMABLE", claimExpiresAt: { gt: new Date() }, client: { lifecycle: "PROSPECT" } },
    include: { client: { select: { id: true, name: true, industryKey: true, _count: { select: { drafts: true, dataItems: true } } } } },
    orderBy: { createdAt: "desc" },
  });
  return rows.map((row) => ({ id: row.id, clientId: row.clientId, businessName: row.client.name, industryKey: row.client.industryKey, sourceType: "PREPARED_WORKSPACE", prospectId: row.id, preparedPostCount: row.client._count.drafts, preparedPropertyCount: row.client._count.dataItems, selectedChannels: normalizeProspectChannels(row.selectedChannels), createdAt: row.createdAt, expiresAt: row.claimExpiresAt, previewPath: `/invitations/${row.id}/preview` }));
}

export async function claimWorkspace({ claimToken, prospectId, user, auth0Sub, verifiedEmail }) {
  if (!verifiedEmail || !user?.id || !auth0Sub) throw Object.assign(new Error("A verified email is required to claim this workspace"), { status: 403, code: "VERIFIED_EMAIL_REQUIRED" });
  if (!claimToken && !prospectId) throw Object.assign(new Error("A claim reference is required"), { status: 400, code: "CLAIM_REFERENCE_REQUIRED" });
  const tokenHash = claimToken ? digestSecret(claimToken) : null;
  const outcome = await prisma.$transaction(async (tx) => {
    const row = await tx.prospectWorkspace.findUnique({ where: tokenHash ? { claimTokenHash: tokenHash } : { id: prospectId }, include: { client: true } });
    if (row?.claimStatus === "CLAIMED" && row.claimedByUserId === user.id && row.claimedByAuth0Sub === auth0Sub) return { clientId: row.clientId, businessName: row.client.name, idempotent: true };
    if (!row || row.claimStatus !== "CLAIMABLE" || row.client.lifecycle !== "PROSPECT") throw Object.assign(new Error("This claim link is invalid or no longer available"), { status: 409, code: "CLAIM_UNAVAILABLE" });
    if (row.claimExpiresAt <= new Date()) {
      await tx.prospectWorkspace.updateMany({ where: { id: row.id, claimStatus: "CLAIMABLE" }, data: { claimStatus: "EXPIRED", claimTokenHash: null } });
      return { claimError: "CLAIM_EXPIRED" };
    }
    if (verifiedEmail.toLowerCase() !== row.prospectEmail.toLowerCase()) throw Object.assign(new Error("Sign in with the invited email address to claim this workspace"), { status: 403, code: "CLAIM_EMAIL_MISMATCH" });
    const claimedAt = new Date();
    const updated = await tx.prospectWorkspace.updateMany({
      where: { id: row.id, ...(tokenHash ? { claimTokenHash: tokenHash } : {}), claimStatus: "CLAIMABLE", claimExpiresAt: { gt: claimedAt } },
      data: { claimStatus: "CLAIMED", claimTokenHash: null, claimedAt, claimedByUserId: user.id, claimedByAuth0Sub: auth0Sub },
    });
    if (updated.count !== 1) throw Object.assign(new Error("This workspace was already claimed"), { status: 409, code: "CLAIM_RACE_LOST" });
    await tx.client.update({ where: { id: row.clientId }, data: { lifecycle: "CUSTOMER", status: "ACTIVE", createdBy: auth0Sub } });
    await tx.contentPreferences.upsert({ where: { clientId: row.clientId }, create: { clientId: row.clientId, preferredChannels: normalizeProspectChannels(row.selectedChannels) }, update: { preferredChannels: normalizeProspectChannels(row.selectedChannels) } });
    const outreach = await tx.agentOutreachProspect.findUnique({ where: { prospectWorkspaceId: row.id }, select: { id: true } });
    if (outreach) await tx.agentOutreachProspect.update({ where: { id: outreach.id }, data: { status: "CLAIMED", claimedAt, events: { create: { type: "CLAIMED", workspaceId: row.id, idempotencyKey: `outreach-claimed:${row.id}` } } } });
    return { clientId: row.clientId, businessName: row.client.name };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  if (outcome.claimError === "CLAIM_EXPIRED") throw Object.assign(new Error("This claim link has expired"), { status: 410, code: "CLAIM_EXPIRED" });
  return outcome;
}

export function formatAdminProspect(row, client) {
  return {
    id: row.id, clientId: row.clientId, businessName: client.name, industryKey: client.industryKey,
    prospectName: row.prospectName, prospectEmail: row.prospectEmail, websiteUrl: row.websiteUrl,
    sourceUrl: row.sourceUrl, acquisitionSource: row.acquisitionSource, operatorNote: row.operatorNote,
    previewStatus: row.previewStatus, claimStatus: row.claimStatus, claimIssuedAt: row.claimIssuedAt,
    claimExpiresAt: row.claimExpiresAt, claimedAt: row.claimedAt, claimedByUserId: row.claimedByUserId,
    selectedChannels: normalizeProspectChannels(row.selectedChannels),
    createdAt: row.createdAt,
  };
}

export const _internal = { TOKEN_BYTES, DEFAULT_TTL_DAYS, UNCLAIMED_OWNER };
