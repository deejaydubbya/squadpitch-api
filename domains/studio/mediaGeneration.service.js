// Content Studio media asset management + AI image generation.
//
// Handles two asset sources:
//   UPLOAD       — direct file upload → Cloudinary → READY
//   AI_GENERATED — enqueue Fal.ai job → PENDING → GENERATING → READY/FAILED
//
// Assets can optionally be linked to a draft for publishing.

import { prisma } from "../../prisma.js";
import { getImageStorageService, getVideoStorageService, validateVideoBuffer } from "../../services/storage/imageStorage.js";
import { loadClientGenerationContext } from "./generation/clientOrchestrator.js";
import { getMediaGenQueue } from "../../lib/queues.js";
import { getJobPriorityForUser } from "../billing/billing.service.js";

// ── List / Get ──────────────────────────────────────────────────────────

export async function listAssets({
  clientId,
  source,
  status,
  draftId,
  assetType,
  search,
  folderId,
  tag,
  limit = 50,
  cursor,
}) {
  const where = { clientId };
  if (source) where.source = source;
  if (status) where.status = status;
  if (draftId) where.draftId = draftId;
  if (assetType) where.assetType = assetType;
  if (folderId === "UNFILED") {
    where.folderId = null;
  } else if (folderId) {
    where.folderId = folderId;
  }
  if (tag) {
    where.tags = { has: tag };
  }
  if (search) {
    where.OR = [
      { renderedPrompt: { contains: search, mode: "insensitive" } },
      { filename: { contains: search, mode: "insensitive" } },
      { caption: { contains: search, mode: "insensitive" } },
    ];
  }

  return prisma.mediaAsset.findMany({
    where,
    include: { _count: { select: { draftAssets: true } } },
    orderBy: { createdAt: "desc" },
    take: limit,
    ...(cursor && { skip: 1, cursor: { id: cursor } }),
  });
}

export async function getAsset(assetId) {
  return prisma.mediaAsset.findUnique({
    where: { id: assetId },
  });
}

// ── Upload ──────────────────────────────────────────────────────────────

export async function uploadAsset({
  clientId,
  buffer,
  filename,
  altText,
  caption,
  draftId,
  folderId,
  tags,
  createdBy,
  source,
}) {
  const storage = getImageStorageService();
  const uploaded = await storage.upload(buffer, {
    folder: `squadpitch/${clientId}/uploads`,
  });

  const asset = await prisma.mediaAsset.create({
    data: {
      clientId,
      source: source ?? "UPLOAD",
      status: "READY",
      url: uploaded.url,
      publicId: uploaded.publicId,
      width: uploaded.width,
      height: uploaded.height,
      bytes: uploaded.bytes,
      mimeType: uploaded.format ? `image/${uploaded.format}` : null,
      filename: filename ?? null,
      altText: altText ?? null,
      caption: caption ?? null,
      draftId: draftId ?? null,
      folderId: folderId ?? null,
      tags: tags ?? [],
      createdBy,
    },
  });

  // If attached to a draft that has no mediaUrl, set it automatically.
  if (draftId) {
    await maybeSetDraftMedia(draftId, asset.url, "image");
  }

  return asset;
}

// ── Video Upload ────────────────────────────────────────────────────────

export async function uploadVideoAsset({
  clientId,
  buffer,
  mimeType,
  filename,
  altText,
  caption,
  draftId,
  createdBy,
}) {
  // Pre-flight validation
  validateVideoBuffer(buffer, mimeType);

  const storage = getVideoStorageService();
  const uploaded = await storage.upload(buffer, {
    folder: `squadpitch/${clientId}/uploads`,
  });

  // Post-flight duration check
  const maxDuration = parseInt(process.env.VIDEO_MAX_DURATION_SEC || "600", 10);
  if (uploaded.durationSec && uploaded.durationSec > maxDuration) {
    // Delete the uploaded video from Cloudinary
    try { await storage.delete(uploaded.publicId); } catch { /* best-effort */ }
    throw {
      status: 422,
      code: "VIDEO_TOO_LONG",
      message: `Video duration ${uploaded.durationSec}s exceeds ${maxDuration}s limit`,
    };
  }

  const asset = await prisma.mediaAsset.create({
    data: {
      clientId,
      source: "UPLOAD",
      status: "READY",
      assetType: "video",
      url: uploaded.url,
      publicId: uploaded.publicId,
      width: uploaded.width,
      height: uploaded.height,
      bytes: uploaded.bytes,
      mimeType: mimeType || (uploaded.format ? `video/${uploaded.format}` : null),
      thumbnailUrl: uploaded.thumbnailUrl,
      videoDurationSec: uploaded.durationSec,
      filename: filename ?? null,
      altText: altText ?? null,
      caption: caption ?? null,
      draftId: draftId ?? null,
      createdBy,
    },
  });

  if (draftId) {
    await maybeSetDraftMedia(draftId, asset.url, "video");
  }

  return asset;
}

// ── Delete ──────────────────────────────────────────────────────────────

export async function deleteAsset(assetId) {
  const asset = await prisma.mediaAsset.findUnique({
    where: { id: assetId },
  });
  if (!asset) return null;

  // Remove from Cloudinary if we have a publicId.
  if (asset.publicId) {
    try {
      const storage = asset.assetType === "video"
        ? getVideoStorageService()
        : getImageStorageService();
      await storage.delete(asset.publicId);
    } catch {
      // Best-effort; the DB row is the source of truth.
    }
  }

  return prisma.mediaAsset.delete({
    where: { id: assetId },
  });
}

// ── Attach / Detach ─────────────────────────────────────────────────────

export async function attachAssetToDraft({ assetId, draftId, displayOrder }) {
  const asset = await prisma.mediaAsset.update({
    where: { id: assetId },
    data: {
      draftId,
      ...(displayOrder !== undefined && { displayOrder }),
    },
  });

  if (asset.url) {
    await maybeSetDraftMedia(draftId, asset.url, asset.assetType || "image");
  }

  return asset;
}

export async function detachAssetFromDraft(assetId) {
  return prisma.mediaAsset.update({
    where: { id: assetId },
    data: { draftId: null },
  });
}

// ── AI Generation (enqueue) ─────────────────────────────────────────────

/** Map channels to default aspect ratios. */
const CHANNEL_ASPECT_RATIOS = {
  INSTAGRAM: { width: 1080, height: 1080 },   // 1:1 square
  TIKTOK:    { width: 1080, height: 1920 },   // 9:16 vertical
  YOUTUBE:   { width: 1280, height: 720 },    // 16:9 landscape
  FACEBOOK:  { width: 1200, height: 630 },    // ~1.9:1
  LINKEDIN:  { width: 1200, height: 627 },    // ~1.91:1
  X:         { width: 1200, height: 675 },    // 16:9
};

export async function enqueueGeneration({
  clientId,
  guidance,
  draftId,
  channel,
  overrides,
  createdBy,
  userId,
}) {
  const ctx = await loadClientGenerationContext(clientId);
  const mediaProfile = ctx.media;

  if (!mediaProfile) {
    throw { status: 400, code: "NO_MEDIA_PROFILE", message: "Client has no media profile" };
  }

  const renderedPrompt = buildImagePrompt(mediaProfile, guidance);
  const { modelId, loraConfig } = resolveModelConfig(mediaProfile);

  const asset = await prisma.mediaAsset.create({
    data: {
      clientId,
      source: "AI_GENERATED",
      status: "PENDING",
      draftId: draftId ?? null,
      falModelId: modelId,
      renderedPrompt,
      negativePrompt: DEFAULT_NEGATIVE_PROMPT,
      loraSnapshot: loraConfig?.path ?? null,
      loraScaleSnapshot: loraConfig?.scale ?? null,
      createdBy,
    },
  });

  // Merge channel-based aspect ratio into overrides.
  const channelDims = channel ? CHANNEL_ASPECT_RATIOS[channel] : null;
  const mergedOverrides = {
    ...(channelDims ?? {}),
    ...(overrides ?? {}),
  };

  const queue = getMediaGenQueue();
  let queued = false;
  if (queue) {
    const priority = userId ? await getJobPriorityForUser(userId) : 5;
    await queue.add("generate", {
      assetId: asset.id,
      overrides: Object.keys(mergedOverrides).length > 0 ? mergedOverrides : null,
    }, { priority });
    queued = true;
  }

  return { ...asset, queued };
}

// ── Prompt building (pure) ──────────────────────────────────────────────

/**
 * Build the image generation prompt. Order matters — Flux/SDXL weight tokens
 * from the front, so subject guidance comes first, style/character second,
 * and LoRA trigger word last (where the model expects it).
 */
export function buildImagePrompt(mediaProfile, guidance) {
  const parts = [];

  // 1. Subject / guidance first (highest weight)
  if (mediaProfile.basePromptTemplate) {
    parts.push(mediaProfile.basePromptTemplate.replace("{guidance}", guidance));
  } else {
    parts.push(guidance);
  }

  // 2. Visual style (composition, lighting, mood)
  if (mediaProfile.visualStyle) {
    parts.push(mediaProfile.visualStyle);
  } else {
    // Baseline quality modifiers when no visual style is configured (e.g. during onboarding)
    parts.push("professional photography, high quality, sharp focus, well-lit");
  }

  // 3. Character prompt (identity details)
  if (mediaProfile.characterPrompt) {
    parts.push(mediaProfile.characterPrompt);
  }

  // 4. LoRA trigger word last
  if (mediaProfile.loraTriggerWord) {
    parts.push(mediaProfile.loraTriggerWord);
  }

  return parts.join(", ").trim();
}

const DEFAULT_NEGATIVE_PROMPT =
  "blurry, low quality, text, watermark, logo, distorted, deformed, disfigured, bad anatomy, extra limbs, cropped, out of frame";

export function resolveModelConfig(mediaProfile) {
  const hasLora = Boolean(mediaProfile.loraModelUrl);

  if (hasLora) {
    return {
      modelId: "fal-ai/flux-lora",
      loraConfig: {
        path: mediaProfile.loraModelUrl,
        scale: mediaProfile.loraScale ?? 1.0,
      },
    };
  }

  return {
    modelId: "fal-ai/flux/dev",
    loraConfig: null,
  };
}

// ── Link / Unlink (many-to-many via DraftAsset) ─────────────────────────

export async function linkAssetToDraft(assetId, draftId, role, orderIndex) {
  const draftAsset = await prisma.draftAsset.upsert({
    where: { draftId_assetId: { draftId, assetId } },
    update: { role: role ?? null, orderIndex: orderIndex ?? 0 },
    create: { draftId, assetId, role: role ?? null, orderIndex: orderIndex ?? 0 },
  });

  // Also set the draft's primary media if it has none.
  const asset = await prisma.mediaAsset.findUnique({
    where: { id: assetId },
    select: { url: true, assetType: true },
  });
  if (asset?.url) {
    await maybeSetDraftMedia(draftId, asset.url, asset.assetType || "image");
  }

  return draftAsset;
}

export async function unlinkAssetFromDraft(assetId, draftId) {
  await prisma.draftAsset.deleteMany({
    where: { draftId, assetId },
  });

  // Backward compat: if the asset's old FK matches, clear it.
  const asset = await prisma.mediaAsset.findUnique({
    where: { id: assetId },
    select: { draftId: true },
  });
  if (asset?.draftId === draftId) {
    await prisma.mediaAsset.update({
      where: { id: assetId },
      data: { draftId: null },
    });
  }
}

export async function getAssetUsageCount(assetId) {
  return prisma.draftAsset.count({ where: { assetId } });
}

export async function getAssetUsage(assetId) {
  return prisma.draftAsset.findMany({
    where: { assetId },
    include: {
      draft: {
        select: { id: true, channel: true, body: true, status: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
}

// ── Format ──────────────────────────────────────────────────────────────

export function formatAsset(asset) {
  if (!asset) return null;
  return {
    id: asset.id,
    clientId: asset.clientId,
    source: asset.source,
    status: asset.status,
    progressStage: asset.progressStage ?? null,
    assetType: asset.assetType ?? "image",
    url: asset.url,
    publicId: asset.publicId,
    width: asset.width,
    height: asset.height,
    bytes: asset.bytes,
    mimeType: asset.mimeType,
    thumbnailUrl: asset.thumbnailUrl ?? null,
    videoDurationSec: asset.videoDurationSec ?? null,
    filename: asset.filename,
    altText: asset.altText,
    caption: asset.caption,
    folderId: asset.folderId ?? null,
    tags: asset.tags ?? [],
    draftId: asset.draftId,
    displayOrder: asset.displayOrder,
    falModelId: asset.falModelId,
    renderedPrompt: asset.renderedPrompt,
    seed: asset.seed != null ? asset.seed.toString() : null,
    externalJobId: asset.externalJobId,
    durationMs: asset.durationMs,
    errorMessage: asset.errorMessage,
    usageCount: asset._count?.draftAssets ?? 0,
    createdBy: asset.createdBy,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
}

// ── Folders ──────────────────────────────────────────────────────────────

export async function listFolders(clientId) {
  return prisma.assetFolder.findMany({
    where: { clientId },
    include: { _count: { select: { assets: true } } },
    orderBy: { name: "asc" },
  });
}

export async function createFolder({ clientId, name }) {
  return prisma.assetFolder.create({
    data: { clientId, name: name.trim() },
    include: { _count: { select: { assets: true } } },
  });
}

export async function renameFolder(folderId, name) {
  return prisma.assetFolder.update({
    where: { id: folderId },
    data: { name: name.trim() },
    include: { _count: { select: { assets: true } } },
  });
}

export async function deleteFolder(folderId) {
  return prisma.assetFolder.delete({
    where: { id: folderId },
  });
}

export async function moveAssetToFolder(assetId, folderId) {
  return prisma.mediaAsset.update({
    where: { id: assetId },
    data: { folderId: folderId ?? null },
  });
}

// ── Tags ─────────────────────────────────────────────────────────────────

export async function updateAssetTags(assetId, tags) {
  return prisma.mediaAsset.update({
    where: { id: assetId },
    data: { tags },
  });
}

// ── Internal helpers ────────────────────────────────────────────────────

async function maybeSetDraftMedia(draftId, url, mediaType = "image") {
  const draft = await prisma.draft.findUnique({
    where: { id: draftId },
    select: { mediaUrl: true },
  });
  if (draft && !draft.mediaUrl) {
    await prisma.draft.update({
      where: { id: draftId },
      data: { mediaUrl: url, mediaType },
    });
  }
}
