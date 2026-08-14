import crypto from "node:crypto";
import { prisma } from "../../prisma.js";
import { assertSafeExternalUrl } from "./urlCampaignIntake.service.js";
import { getImageStorageService } from "../../services/storage/imageStorage.js";
import { sniffImageMime } from "../../lib/mimeDetect.js";
import { extractFromImage } from "./generation/openai.provider.js";

export const PROPERTY_SCENES = ["aerial", "main_front_exterior", "alternate_exterior", "side_rear_exterior", "backyard", "yard_land", "floorplan", "garage_outbuilding", "kitchen", "living_interior", "dining_room", "bedroom", "bathroom", "porch", "patio", "other_interior", "other_detail", "unusable"];
const INTERNAL_PREFIXES = ["property:", "prospect-scene:", "source-key:"];
const INTERNAL_EXACT = new Set(["property", "prospect-preview", "prospect-clear-view", "prospect-obstructed"]);
const SCENE_PRESENTATION = {
  aerial: ["aerial", "Aerial View"], main_front_exterior: ["front exterior", "Front Exterior"], alternate_exterior: ["exterior", "Exterior"], side_rear_exterior: ["exterior", "Rear Exterior"],
  backyard: ["backyard", "Backyard"], yard_land: ["backyard", "Yard"], floorplan: ["floorplan", "Floor Plan"], garage_outbuilding: ["garage", "Garage"], kitchen: ["kitchen", "Kitchen"],
  living_interior: ["living room", "Living Room"], dining_room: ["dining room", "Dining Room"], bedroom: ["bedroom", "Bedroom"], bathroom: ["bathroom", "Bathroom"], porch: ["porch", "Porch"], patio: ["patio", "Patio"], other_interior: ["interior", "Other Interior"], other_detail: ["other", "Other"], unusable: ["other", "Other"],
};

export function isSystemMediaTag(tag) { return INTERNAL_EXACT.has(tag) || INTERNAL_PREFIXES.some((prefix) => tag.startsWith(prefix)); }
export function visibleMediaTags(tags = []) { return tags.filter((tag) => !isSystemMediaTag(tag)); }
export function propertyImageSourceKey(url) {
  try {
    const parsed = new URL(url);
    const photo = parsed.pathname.match(/(?:^|[_/-])(P\d{2,})(?:[_./-]|$)/i)?.[1];
    const path = photo ? photo.toUpperCase() : parsed.pathname.toLowerCase().replace(/(?:_|-)(?:thumb|small|medium|large|\d+x\d+)(?=\.|_|-)/g, "");
    return crypto.createHash("sha256").update(`${parsed.hostname.toLowerCase()}|${path}`).digest("hex");
  } catch { return crypto.createHash("sha256").update(String(url)).digest("hex"); }
}
export function scenePresentation(scene) { const [tag, title] = SCENE_PRESENTATION[scene] || SCENE_PRESENTATION.other_detail; return { tags: [tag], title }; }
function folderName(item) { const d = item.dataJson || {}; return `Property — ${[d.street, d.city].filter(Boolean).join(", ") || item.title}`.slice(0, 120); }
function sourceImages(item) { const d = item.dataJson || {}; const preserved = Array.isArray(d.sourceImages) && d.sourceImages.length ? d.sourceImages : null; return (preserved || [d.originalImageUrl, d.imageUrl, ...(Array.isArray(d.images) ? d.images.map((v) => typeof v === "string" ? v : v?.url) : [])]).filter((v) => typeof v === "string" && /^https?:\/\//i.test(v) && !/mls_logos|logo|\.svg(?:\?|$)/i.test(v)); }

async function classify(asset) {
  const existingScene = asset.tags?.find((tag) => tag.startsWith("prospect-scene:"))?.slice(15);
  if (existingScene) return { scene: existingScene, obstructed: asset.tags.includes("prospect-obstructed"), clearWholePropertyView: asset.tags.includes("prospect-clear-view") };
  try {
    const result = await extractFromImage({ base64: asset.url, timeoutMs: 20_000, prompt: `Classify this real-estate image. Return JSON: category (exactly one of ${PROPERTY_SCENES.join(", ")}), obstructed boolean, clearWholePropertyView boolean.` });
    return { scene: PROPERTY_SCENES.includes(result.parsed?.category) ? result.parsed.category : "other_detail", obstructed: !!result.parsed?.obstructed, clearWholePropertyView: !!result.parsed?.clearWholePropertyView };
  } catch { return { scene: "other_detail", obstructed: false, clearWholePropertyView: false }; }
}

export async function ingestPropertyMedia(clientId, item, actor) {
  const folder = await prisma.assetFolder.upsert({ where: { propertyDataItemId: item.id }, create: { clientId, name: folderName(item), propertyDataItemId: item.id }, update: { name: folderName(item) } });
  const unique = [...new Map(sourceImages(item).map((url) => [propertyImageSourceKey(url), url])).entries()];
  const legacy = await prisma.mediaAsset.findMany({ where: { clientId, tags: { has: `property:${item.id}` }, propertyDataItemId: null }, orderBy: { createdAt: "asc" } });
  const assets = [];
  for (const [sourceKey, externalUrl] of unique) {
    let asset = await prisma.mediaAsset.findUnique({ where: { clientId_propertyDataItemId_sourceKey: { clientId, propertyDataItemId: item.id, sourceKey } } });
    if (!asset && legacy.length) {
      asset = await prisma.mediaAsset.update({ where: { id: legacy.shift().id }, data: { sourceKey, propertyDataItemId: item.id, folderId: folder.id } });
    }
    if (!asset) {
      try {
        assertSafeExternalUrl(externalUrl);
        const response = await fetch(externalUrl, { redirect: "follow", signal: AbortSignal.timeout(15_000), headers: { "User-Agent": "Squadpitch listing importer", Accept: "image/*" } });
        if (!response.ok) continue;
        assertSafeExternalUrl(response.url);
        const buffer = Buffer.from(await response.arrayBuffer());
        const mimeType = sniffImageMime(buffer);
        if (!mimeType || buffer.length > 10 * 1024 * 1024) continue;
        const uploaded = await getImageStorageService().upload(buffer, { folder: `squadpitch/properties/${clientId}/${item.id}` });
        asset = await prisma.mediaAsset.create({ data: { clientId, source: "IMPORTED", status: "READY", url: uploaded.url, publicId: uploaded.publicId, width: uploaded.width ?? null, height: uploaded.height ?? null, bytes: uploaded.bytes ?? buffer.length, mimeType, assetType: "image", folderId: folder.id, propertyDataItemId: item.id, sourceKey, tags: ["property", `property:${item.id}`, `source-key:${sourceKey}`], createdBy: actor } });
      } catch { continue; }
    }
    const classification = await classify(asset);
    const presentation = scenePresentation(classification.scene);
    const systemTags = [`prospect-scene:${classification.scene}`, ...(classification.obstructed ? ["prospect-obstructed"] : []), ...(classification.clearWholePropertyView ? ["prospect-clear-view"] : [])];
    asset = await prisma.mediaAsset.update({ where: { id: asset.id }, data: { folderId: folder.id, propertyDataItemId: item.id, filename: asset.filename && !/^property-\d+$|^untitled$/i.test(asset.filename) ? asset.filename : presentation.title, altText: asset.altText || `${presentation.title} — ${item.title}`, tags: [...new Set([...visibleMediaTags(asset.tags), ...presentation.tags, ...asset.tags.filter(isSystemMediaTag), ...systemTags])] } });
    assets.push(asset);
  }
  const canonicalUrls = assets.map((asset) => asset.url).filter(Boolean);
  const current = item.dataJson || {};
  const updatedItem = canonicalUrls.length ? await prisma.workspaceDataItem.update({ where: { id: item.id }, data: { dataJson: { ...current, sourceImages: sourceImages(item), images: canonicalUrls, imageUrl: canonicalUrls[0], primaryMediaAssetId: assets[0]?.id } } }) : item;
  return { item: updatedItem, assets, folder };
}

export async function reconcilePropertyMedia(clientId, actor) {
  const items = await prisma.workspaceDataItem.findMany({ where: { clientId, type: "PROPERTY", status: "ACTIVE" } });
  const results = [];
  for (const item of items) results.push(await ingestPropertyMedia(clientId, item, actor));
  return results;
}
