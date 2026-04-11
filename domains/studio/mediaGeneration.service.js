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

// ── List / Get ──────────────────────────────────────────────────────────

export async function listAssets({
  clientId,
  source,
  status,
  draftId,
  assetType,
  limit = 50,
  cursor,
}) {
  const where = { clientId };
  if (source) where.source = source;
  if (status) where.status = status;
  if (draftId) where.draftId = draftId;
  if (assetType) where.assetType = assetType;

  return prisma.mediaAsset.findMany({
    where,
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
  createdBy,
}) {
  const storage = getImageStorageService();
  const uploaded = await storage.upload(buffer, {
    folder: `squadpitch/${clientId}/uploads`,
  });

  const asset = await prisma.mediaAsset.create({
    data: {
      clientId,
      source: "UPLOAD",
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
  if (queue) {
    await queue.add("generate", {
      assetId: asset.id,
      overrides: Object.keys(mergedOverrides).length > 0 ? mergedOverrides : null,
    });
  }

  return asset;
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
    draftId: asset.draftId,
    displayOrder: asset.displayOrder,
    falModelId: asset.falModelId,
    renderedPrompt: asset.renderedPrompt,
    seed: asset.seed != null ? asset.seed.toString() : null,
    externalJobId: asset.externalJobId,
    durationMs: asset.durationMs,
    errorMessage: asset.errorMessage,
    createdBy: asset.createdBy,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt,
  };
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
