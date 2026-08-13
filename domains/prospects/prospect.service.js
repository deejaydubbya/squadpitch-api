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

const TOKEN_BYTES = 32;
const DEFAULT_TTL_DAYS = 21;
const UNCLAIMED_OWNER = "prospect:unclaimed";

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
  const propertyMediaAvailable = row.client.dataItems.some((item) => item.type === "PROPERTY" && (item.dataJson?.imageUrl || item.dataJson?.images?.length));
  const canonicalProspectDrafts = [];
  const seenProspectChannels = new Set();
  for (const draft of row.client.drafts) {
    const isPropertyDraft = draft.warnings?.some((warning) => warning.startsWith("prospectProperty:"));
    if (isPropertyDraft && seenProspectChannels.has(draft.channel)) continue;
    if (isPropertyDraft) seenProspectChannels.add(draft.channel);
    canonicalProspectDrafts.push(draft);
  }
  const eligiblePreviewItems = [
    ...row.client.dataItems.map((item) => ({ id: item.id, itemType: "DATA_ITEM", title: item.title, subtitle: item.type })),
    ...canonicalProspectDrafts.filter((draft) => !propertyMediaAvailable || draft._count.draftAssets > 0 || draft.mediaUrl).map((draft) => ({ id: draft.id, itemType: "DRAFT", title: draft.body.slice(0, 120), subtitle: draft.channel })),
  ];
  const expectedChannels = ["INSTAGRAM", "FACEBOOK", "LINKEDIN"];
  const readyChannels = expectedChannels.filter((channel) => canonicalProspectDrafts.some((draft) => draft.channel === channel && (!propertyMediaAvailable || draft._count.draftAssets > 0 || draft.mediaUrl)));
  const campaignReadiness = { status: readyChannels.length === 3 ? "COMPLETE" : readyChannels.length ? "PARTIAL" : "NEEDS_ATTENTION", readyChannels, expectedChannels, issues: expectedChannels.filter((channel) => !readyChannels.includes(channel)).map((channel) => ({ channel, code: "DRAFT_NOT_READY", message: `${channel.charAt(0)}${channel.slice(1).toLowerCase()} draft needs attention` })) };
  return {
    ...formatAdminProspect(row, row.client),
    preparationState: row.previewItems.length > 0 ? "SELECTED" : eligiblePreviewItems.length > 0 ? "READY_UNSELECTED" : "NOT_STARTED",
    sourcePreparationState: row.client.dataItems.some((item) => item.type === "PROPERTY" && typeof item.dataJson?.listingUrl === "string") && row.client.drafts.filter((draft) => draft.warnings?.some((warning) => warning.startsWith("prospectProperty:"))).length >= 3 ? "IMPORTED" : "NOT_IMPORTED",
    eligiblePreviewItems,
    selectedPreviewItems: row.previewItems.map((item) => ({ id: item.dataItemId || item.draftId, itemType: item.itemType, sortOrder: item.sortOrder })),
    campaignReadiness,
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

const UNSUPPORTED_PROPERTY_COPY = [
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

function validateGeneratedPropertyBody(body, item) {
  const text = String(body || "");
  const normalized = text.toLowerCase().replace(/[^a-z0-9]/g, "");
  const data = item.dataJson || {};
  const facts = [data.street, data.city, data.zip, data.price, data.bedrooms, data.bathrooms, data.sqft, data.yearBuilt]
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map((value) => String(value).toLowerCase().replace(/[^a-z0-9]/g, ""));
  if (!text.trim() || !facts.some((fact) => fact.length >= 3 && normalized.includes(fact))) return { valid: false, reason: "MISSING_VERIFIED_FACT" };
  const unsupported = UNSUPPORTED_PROPERTY_COPY.find((pattern) => pattern.test(text));
  const matchedText = unsupported ? text.match(unsupported)?.[0] : null;
  if (unsupported) return { valid: false, reason: "UNSUPPORTED_PROPERTY_CLAIM", matchedText };
  const blocks = text.split(/\n\s*\n|(?<=[.!?])\s+/).map((part) => part.trim()).filter((part) => part.length >= 12);
  const hasHook = /just listed|now available|take a look|explore|property listing|listing update|see the details/i.test(text);
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
  if (channel === "INSTAGRAM") return `🏡 Take a look at ${address}.\n\nNow available at ${detailLine}.\n\nWant to see the complete listing or schedule a showing? Message ${businessName}.\n\n#JustListed #RealEstate #PropertyTour`;
  if (channel === "FACEBOOK") return `Now available: ${address}\n\nHere are the key details from the listing:\n${detailLine}\n\nExplore the property photos, then contact ${businessName} to request the complete listing information or schedule a showing.`;
  return `Property listing update: ${address}\n\nThe current listing details include ${detailLine}.\n\nFor professionals and clients reviewing available properties, ${businessName} can provide the complete listing information and showing details.`;
}

export function listingPhotoKey(url) {
  try {
    const parsed = new URL(url);
    const photoNumber = parsed.pathname.match(/(?:^|[_/-])(P\d{2,})(?:[_./-]|$)/i)?.[1];
    if (photoNumber) return photoNumber.toUpperCase();
    return parsed.pathname.toLowerCase().replace(/(?:_|-)(?:thumb|small|medium|large|\d+x\d+)(?=\.|_|-)/g, "");
  } catch { return String(url); }
}

const PROPERTY_SCENES = ["main_front_exterior", "alternate_exterior", "side_rear_exterior", "yard_land", "garage_outbuilding", "kitchen", "living_interior", "bedroom", "bathroom", "porch_patio_deck", "other_detail", "unusable"];

function propertyScene(asset) {
  return asset.tags?.find((tag) => tag.startsWith("prospect-scene:"))?.slice(15) || "unclassified";
}

export function rankPropertyAssets(assets) {
  const weights = { main_front_exterior: 120, alternate_exterior: 100, side_rear_exterior: 70, porch_patio_deck: 55, yard_land: 50, kitchen: 45, living_interior: 42, bedroom: 35, bathroom: 32, other_detail: 20, garage_outbuilding: 8, unusable: -200, unclassified: 30 };
  return assets.map((asset, sourceIndex) => ({ asset, sourceIndex, scene: propertyScene(asset), score: (weights[propertyScene(asset)] ?? 0) + (asset.tags?.includes("prospect-clear-view") ? 15 : 0) - (asset.tags?.includes("prospect-obstructed") ? 30 : 0) + (asset.qualityScore || 0) * 5 + Math.min((asset.width || 0) * (asset.height || 0) / 1_000_000, 5) }))
    .sort((a, b) => b.score - a.score || a.sourceIndex - b.sourceIndex);
}

export function buildPropertyMediaPlan(assets) {
  const ranked = rankPropertyAssets(assets);
  const usable = ranked.filter(({ scene }) => scene !== "unusable");
  const exteriors = usable.filter(({ scene }) => ["main_front_exterior", "alternate_exterior", "side_rear_exterior"].includes(scene));
  const heroPool = exteriors.length ? exteriors : usable;
  const heroFor = (index) => heroPool[Math.min(index, heroPool.length - 1)]?.asset || null;
  const supportPool = usable.filter(({ scene }) => ["kitchen", "living_interior", "porch_patio_deck", "yard_land", "bedroom", "bathroom"].includes(scene));
  const galleryFor = (hero, count, heroIndex) => {
    if (!hero) return [];
    const alternateExterior = heroPool.length > 1 ? heroPool[(heroIndex + 1) % heroPool.length] : null;
    const supporting = supportPool.length ? supportPool[heroIndex % supportPool.length] : null;
    const ordered = [hero, alternateExterior?.asset, supporting?.asset, ...usable.map(({ asset }) => asset)].filter(Boolean);
    return [...new Map(ordered.map((asset) => [asset.id, asset])).values()].slice(0, count);
  };
  const instagramHero = heroFor(0);
  const facebookHero = heroFor(1);
  const linkedinHero = heroFor(2);
  return { featured: instagramHero, INSTAGRAM: galleryFor(instagramHero, 3, 0), FACEBOOK: galleryFor(facebookHero, 3, 1), LINKEDIN: galleryFor(linkedinHero, 1, 2) };
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
  const candidates = [...new Map([item.dataJson?.originalImageUrl, ...(item.dataJson?.images || [])]
    .filter((url) => typeof url === "string" && /images-listings\.coldwellbanker\.com/i.test(url))
    .filter((url) => !/mls_logos|logo|\.svg(?:\?|$)/i.test(url))
    .map((url) => [listingPhotoKey(url), url])).values()]
    .slice(0, 7);
  const existing = await prisma.mediaAsset.findMany({ where: { clientId, tags: { has: `property:${item.id}` }, status: "READY", assetType: "image" }, orderBy: { createdAt: "asc" } });
  const assets = [...existing];
  for (const externalUrl of candidates.slice(existing.length)) {
    try {
      assertSafeExternalUrl(externalUrl);
      const response = await fetch(externalUrl, { redirect: "follow", signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "Squadpitch listing importer", Accept: "image/*" } });
      if (!response.ok) continue;
      assertSafeExternalUrl(response.url);
      const length = Number(response.headers.get("content-length") || 0);
      if (length > 10 * 1024 * 1024) continue;
      const buffer = Buffer.from(await response.arrayBuffer());
      const mimeType = sniffImageMime(buffer);
      if (!mimeType || buffer.length > 10 * 1024 * 1024) continue;
      const uploaded = await getImageStorageService().upload(buffer, { folder: `squadpitch/prospects/${clientId}` });
      assets.push(await prisma.mediaAsset.create({ data: { clientId, source: "IMPORTED", status: "READY", url: uploaded.url, publicId: uploaded.publicId, width: uploaded.width ?? null, height: uploaded.height ?? null, bytes: uploaded.bytes ?? buffer.length, mimeType, assetType: "image", filename: `property-${assets.length + 1}`, altText: `${item.title} photo ${assets.length + 1}`, tags: ["property", "prospect-preview", `property:${item.id}`], createdBy: actor } }));
    } catch {}
  }
  if (!assets.length) return { item, assets: [] };
  const classified = [];
  for (let index = 0; index < assets.length; index += 3) classified.push(...await Promise.all(assets.slice(index, index + 3).map((asset) => classifyPropertyAsset(asset, actor))));
  const plan = buildPropertyMediaPlan(classified);
  const featured = plan.featured || classified[0];
  const dataJson = { ...item.dataJson, imageUrl: featured.url, primaryMediaAssetId: featured.id };
  return { item: await prisma.workspaceDataItem.update({ where: { id: item.id }, data: { dataJson } }), assets: classified };
}

export async function prepareProspect(id, input, adminSub) {
  const prospect = await prisma.prospectWorkspace.findUnique({ where: { id }, include: { client: true } });
  if (!prospect || prospect.client.lifecycle !== "PROSPECT") throw Object.assign(new Error("Prospect workspace not found"), { status: 404, code: "NOT_FOUND" });
  if (prospect.client.industryKey !== "real_estate") throw importFailure("Automatic listing preparation is currently available for Real Estate prospects only");
  const sourceUrl = input.sourceUrl || prospect.sourceUrl;
  if (!sourceUrl) throw importFailure("No listing URL was supplied", { actions: ["ENTER_PROPERTY_ADDRESS", "ADD_PROPERTY_MANUALLY"] });

  const analysis = await analyzeUrl(prospect.clientId, { url: sourceUrl });
  const candidate = analysis.detectedType === "single_listing" ? analysis.listings?.[0] : null;
  if (!candidate?.normalized || !isUsableProspectListing(candidate.normalized, analysis.confidence) || candidate.validation?.valid === false) {
    throw importFailure("We couldn't import this listing automatically.", { actions: ["RETRY_IMPORT", "ENTER_PROPERTY_ADDRESS", "ADD_PROPERTY_MANUALLY"], reason: analysis.reason || analysis.detectedType });
  }
  const selectedListing = { ...fillAddressFromTitle(candidate.normalized), sourceUrl };
  const confirmed = await confirmUrl(prospect.clientId, { url: sourceUrl, selectedListing });
  await enrichListingById(prospect.clientId, confirmed.dataItemId).catch(() => null);
  let item = await prisma.workspaceDataItem.findFirst({ where: { id: confirmed.dataItemId, clientId: prospect.clientId, type: "PROPERTY", status: "ACTIVE" } });
  if (!item) throw importFailure("The listing was resolved but the property could not be saved");
  let propertyAssets = [];
  try { ({ item, assets: propertyAssets } = await cachePropertyImages(prospect.clientId, item, adminSub)); } catch { propertyAssets = []; }

  const existing = await prisma.draft.findMany({ where: { clientId: prospect.clientId, status: "DRAFT", warnings: { has: `prospectProperty:${item.id}` } }, orderBy: { createdAt: "desc" } });
  const drafts = [];
  for (const draft of existing) {
    if (drafts.some((candidate) => candidate.channel === draft.channel)) continue;
    const validation = validateGeneratedPropertyBody(draft.body, item);
    if (validation.valid) drafts.push(draft);
    else await prisma.draft.update({ where: { id: draft.id }, data: { status: "FAILED", warnings: { push: `PROSPECT_PROPERTY_FACT_GUARD:${validation.reason}` } } });
  }
  for (const channel of ["INSTAGRAM", "FACEBOOK", "LINKEDIN"]) {
    if (drafts.some((draft) => draft.channel === channel)) continue;
    let accepted = null;
    const rejectedPhrases = [];
    for (let attempt = 1; attempt <= 3 && !accepted; attempt += 1) {
      const retryFeedback = rejectedPhrases.length ? ` Earlier attempts were rejected for these unsupported phrases: ${rejectedPhrases.map((phrase) => `"${phrase}"`).join(", ")}. Do not repeat those claims or close paraphrases.` : "";
      const draft = await generateDraft({ clientId: prospect.clientId, kind: "POST", channel, bucketKey: "just_listed", templateType: "just_listed", guidance: `Write a substantive, platform-specific ${channel} post for a private NEW_LISTING preview using ONLY facts present in the linked property record (${item.title}). Include a clear hook, verified listing facts, safe framing, a distinct CTA, and platform-appropriate hashtags. Do not describe the home's layout, finishes, light, charm, functionality, potential, suitability, community, parks, shops, dining, schools, amenities, market, financing, or any fact absent from the record. Do not infer anything from photos.${retryFeedback}`, createdBy: adminSub, dataItemId: item.id, contentAngle: "just_listed" });
      if (!draft || draft.status === "FAILED") continue;
      const validation = validateGeneratedPropertyBody(draft.body, item);
      if (!validation.valid) {
        if (validation.matchedText) rejectedPhrases.push(validation.matchedText.slice(0, 80));
        await prisma.draft.update({ where: { id: draft.id }, data: { status: "FAILED", warnings: { push: `PROSPECT_PROPERTY_FACT_GUARD:${validation.reason}` } } });
        continue;
      }
      accepted = await prisma.draft.update({ where: { id: draft.id }, data: { warnings: { push: `prospectProperty:${item.id}` } } });
    }
    if (!accepted) {
      const body = buildVerifiedPropertyFallback(item, channel, prospect.client.name);
      accepted = await prisma.draft.create({ data: {
        clientId: prospect.clientId, kind: "POST", status: "DRAFT", channel,
        bucketKey: "just_listed", generationGuidance: "Verified-facts fallback after three rejected prospect generation attempts",
        body, hooks: [], hashtags: [], warnings: [`prospectProperty:${item.id}`, "PROSPECT_PROPERTY_VERIFIED_FALLBACK"],
        createdBy: adminSub,
      } });
    }
    drafts.push(accepted);
  }
  const mediaPlan = buildPropertyMediaPlan(propertyAssets);
  for (const draft of drafts) {
    const selectedAssets = mediaPlan[draft.channel] || [];
    const uniqueAssets = [...new Map(selectedAssets.map((asset) => [asset.id, asset])).values()];
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
  return { itemId: item.id, draftIds: drafts.map((draft) => draft.id), imageImported: propertyAssets.length > 0, importedImageCount: propertyAssets.length, importQuality: candidate.quality, preparationState: "READY_UNSELECTED" };
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

export async function getPublicPreview(previewToken) {
  if (typeof previewToken !== "string" || previewToken.length < 40 || previewToken.length > 100) return null;
  const row = await prisma.prospectWorkspace.findUnique({
    where: { previewTokenHash: digestSecret(previewToken) },
    include: {
      client: { include: { brandProfile: true, _count: { select: { dataItems: true, drafts: true } } } },
      previewItems: {
        orderBy: { sortOrder: "asc" },
        include: {
          dataItem: true,
          draft: { include: { draftAssets: { take: 10, orderBy: { orderIndex: "asc" }, include: { asset: true } } } },
        },
      },
    },
  });
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
      status: typeof item.dataJson?.status === "string" ? item.dataJson.status : null,
    } } : {}),
  }));
  const selectedByPlatform = new Map();
  for (const selection of row.previewItems) {
    const draft = selection.draft;
    if (selection.itemType !== "DRAFT" || !["DRAFT", "PENDING_REVIEW", "APPROVED"].includes(draft?.status)) continue;
    const propertyDraft = draft.warnings?.some((warning) => warning.startsWith("prospectProperty:"));
    if (propertyDraft && items.some((item) => item.imageUrl) && !draft.draftAssets?.length) continue;
    const current = selectedByPlatform.get(draft.channel);
    if (!current || draft.createdAt > current.draft.createdAt) selectedByPlatform.set(draft.channel, { draft, sortOrder: selection.sortOrder });
  }
  const drafts = [...selectedByPlatform.values()].sort((a, b) => a.sortOrder - b.sortOrder).map(({ draft }) => ({ channel: draft.channel, body: draft.body, mediaUrl: draft.mediaUrl, media: (draft.draftAssets ?? []).map(({ asset, orderIndex }) => ({ url: asset.url, thumbnailUrl: asset.thumbnailUrl, assetType: asset.assetType, altText: asset.altText, orderIndex })) }));
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

export async function inspectClaim(claimToken) {
  if (typeof claimToken !== "string" || claimToken.length < 40 || claimToken.length > 100) return { valid: false };
  const row = await prisma.prospectWorkspace.findUnique({ where: { claimTokenHash: digestSecret(claimToken) }, include: { client: { select: { name: true, lifecycle: true } } } });
  if (!row || row.claimStatus !== "CLAIMABLE" || row.client.lifecycle !== "PROSPECT" || row.claimExpiresAt <= new Date()) return { valid: false };
  return { valid: true, businessName: row.client.name, prospectName: row.prospectName, expiresAt: row.claimExpiresAt };
}

export async function claimWorkspace({ claimToken, user, auth0Sub, verifiedEmail }) {
  if (!verifiedEmail || !user?.id || !auth0Sub) throw Object.assign(new Error("A verified email is required to claim this workspace"), { status: 403, code: "VERIFIED_EMAIL_REQUIRED" });
  const tokenHash = digestSecret(claimToken || "");
  const outcome = await prisma.$transaction(async (tx) => {
    const row = await tx.prospectWorkspace.findUnique({ where: { claimTokenHash: tokenHash }, include: { client: true } });
    if (!row || row.claimStatus !== "CLAIMABLE" || row.client.lifecycle !== "PROSPECT") throw Object.assign(new Error("This claim link is invalid or no longer available"), { status: 409, code: "CLAIM_UNAVAILABLE" });
    if (row.claimExpiresAt <= new Date()) {
      await tx.prospectWorkspace.updateMany({ where: { id: row.id, claimStatus: "CLAIMABLE" }, data: { claimStatus: "EXPIRED", claimTokenHash: null } });
      return { claimError: "CLAIM_EXPIRED" };
    }
    if (verifiedEmail.toLowerCase() !== row.prospectEmail.toLowerCase()) throw Object.assign(new Error("Sign in with the invited email address to claim this workspace"), { status: 403, code: "CLAIM_EMAIL_MISMATCH" });
    const claimedAt = new Date();
    const updated = await tx.prospectWorkspace.updateMany({
      where: { id: row.id, claimTokenHash: tokenHash, claimStatus: "CLAIMABLE", claimExpiresAt: { gt: claimedAt } },
      data: { claimStatus: "CLAIMED", claimTokenHash: null, claimedAt, claimedByUserId: user.id, claimedByAuth0Sub: auth0Sub },
    });
    if (updated.count !== 1) throw Object.assign(new Error("This workspace was already claimed"), { status: 409, code: "CLAIM_RACE_LOST" });
    await tx.client.update({ where: { id: row.clientId }, data: { lifecycle: "CUSTOMER", status: "ACTIVE", createdBy: auth0Sub } });
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
    createdAt: row.createdAt,
  };
}

export const _internal = { TOKEN_BYTES, DEFAULT_TTL_DAYS, UNCLAIMED_OWNER };
