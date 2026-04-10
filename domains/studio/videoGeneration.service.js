// Content Studio AI video generation.
//
// Enqueues Fal.ai video generation jobs. Mirrors the image generation
// flow in mediaGeneration.service.js but uses video-specific models,
// aspect ratios, and the cs-video-gen queue.

import { prisma } from "../../prisma.js";
import { getVideoGenQueue } from "../../lib/queues.js";

/** Map channels to Fal aspect ratio strings. */
const VIDEO_CHANNEL_ASPECT_RATIOS = {
  INSTAGRAM: "9:16",   // vertical (Reels)
  TIKTOK:    "9:16",   // vertical
  YOUTUBE:   "16:9",   // landscape
  FACEBOOK:  "16:9",   // landscape
  LINKEDIN:  "16:9",   // landscape
  X:         "16:9",   // landscape
  BLOG:      "16:9",   // landscape
};

const DEFAULT_VIDEO_MODEL =
  process.env.FAL_DEFAULT_VIDEO_MODEL || "fal-ai/kling-video/v1.5/pro/text-to-video";

export async function enqueueVideoGeneration({
  clientId,
  guidance,
  draftId,
  channel,
  createdBy,
}) {
  const modelId = DEFAULT_VIDEO_MODEL;

  const asset = await prisma.mediaAsset.create({
    data: {
      clientId,
      source: "AI_GENERATED",
      status: "PENDING",
      assetType: "video",
      draftId: draftId ?? null,
      falModelId: modelId,
      renderedPrompt: guidance,
      createdBy,
    },
  });

  // Merge channel-based aspect ratio
  const aspectRatio = (channel ? VIDEO_CHANNEL_ASPECT_RATIOS[channel] : null) ?? "16:9";

  const queue = getVideoGenQueue();
  if (queue) {
    await queue.add("generate-video", {
      assetId: asset.id,
      aspectRatio,
    });
  }

  return asset;
}
