// Content Studio AI video generation.
//
// Enqueues Fal.ai video generation jobs. Mirrors the image generation
// flow in mediaGeneration.service.js but uses video-specific models,
// aspect ratios, and the cs-video-gen queue.

import { prisma } from "../../prisma.js";
import { getVideoGenQueue } from "../../lib/queues.js";
import { getJobPriorityForUser } from "../billing/billing.service.js";
import { loadClientGenerationContext } from "./generation/clientOrchestrator.js";

/** Map channels to Fal aspect ratio strings. */
const VIDEO_CHANNEL_ASPECT_RATIOS = {
  INSTAGRAM: "9:16",   // vertical (Reels)
  TIKTOK:    "9:16",   // vertical
  YOUTUBE:   "16:9",   // landscape
  FACEBOOK:  "16:9",   // landscape
  LINKEDIN:  "16:9",   // landscape
  X:         "16:9",   // landscape
};

/** Channel-specific prompt hints for video generation. */
const VIDEO_CHANNEL_HINTS = {
  INSTAGRAM: "vertical format, fast-paced, eye-catching first frame, casual tone",
  TIKTOK:    "vertical format, dynamic transitions, trending style, energetic pacing",
  YOUTUBE:   "horizontal cinematic format, professional pacing, strong opening shot",
  FACEBOOK:  "horizontal format, accessible and engaging, clear narrative",
  LINKEDIN:  "horizontal format, professional and polished, business-appropriate",
  X:         "horizontal format, concise and impactful, attention-grabbing",
};

/**
 * Video generation presets — each preset defines prompt hints, suggested
 * duration, default aspect ratio, and shot style for a specific use case.
 */
export const VIDEO_PRESETS = {
  listing_walkthrough: {
    label: "Listing Walkthrough",
    promptHints: "cinematic property walkthrough, smooth camera movement through rooms, showcase key features, natural lighting, real estate showcase",
    suggestedDuration: "10",
    defaultAspectRatio: "16:9",
    shotStyle: "steady tracking shot, wide establishing angles, detail close-ups",
  },
  agent_introduction: {
    label: "Agent Introduction",
    promptHints: "professional introduction video, confident person speaking to camera, warm and approachable, branded background",
    suggestedDuration: "10",
    defaultAspectRatio: "9:16",
    shotStyle: "medium close-up, eye-level, well-lit face, shallow depth of field",
  },
  educational_tip: {
    label: "Educational Tip",
    promptHints: "educational explainer video, clear visual storytelling, informative graphics feel, engaging pacing",
    suggestedDuration: "10",
    defaultAspectRatio: "9:16",
    shotStyle: "dynamic cuts, text-friendly composition, clean background",
  },
  market_update: {
    label: "Market Update",
    promptHints: "professional market analysis visual, data-driven feel, modern graphics aesthetic, authoritative tone",
    suggestedDuration: "10",
    defaultAspectRatio: "16:9",
    shotStyle: "steady shot, professional backdrop, news-style framing",
  },
  testimonial_highlight: {
    label: "Testimonial Highlight",
    promptHints: "authentic testimonial moment, emotional connection, warm natural lighting, trust-building visual",
    suggestedDuration: "10",
    defaultAspectRatio: "9:16",
    shotStyle: "medium shot, natural setting, soft background blur",
  },
  brand_awareness: {
    label: "Brand Awareness",
    promptHints: "brand showcase video, lifestyle imagery, aspirational feel, polished production quality",
    suggestedDuration: "5",
    defaultAspectRatio: "16:9",
    shotStyle: "cinematic wide shots, golden hour lighting, smooth motion",
  },
  voiceover_broll: {
    label: "Voiceover B-Roll",
    promptHints: "atmospheric b-roll footage, complementary visuals for narration, smooth ambient shots, no people speaking",
    suggestedDuration: "10",
    defaultAspectRatio: "16:9",
    shotStyle: "slow pan, aerial perspective, detail shots, ambient movement",
  },
  talking_head: {
    label: "Talking Head",
    promptHints: "person speaking directly to camera, confident and engaging, well-framed headshot, professional setting",
    suggestedDuration: "10",
    defaultAspectRatio: "9:16",
    shotStyle: "medium close-up, centered subject, clean background, good eye contact",
  },
};

const DEFAULT_VIDEO_MODEL =
  process.env.FAL_DEFAULT_VIDEO_MODEL || "fal-ai/kling-video/v1.5/pro/text-to-video";

/**
 * Build an enriched video generation prompt — parallel to image's
 * `buildImagePrompt()`. Layers: user guidance → preset hints → shot
 * style → workspace visual style → channel hints → industry → quality.
 */
export function buildVideoPrompt(ctx, guidance, presetKey, channel) {
  const parts = [];

  // 1. User guidance (highest weight)
  if (guidance) parts.push(guidance);

  // 2. Preset hints + shot style
  const preset = presetKey ? VIDEO_PRESETS[presetKey] : null;
  if (preset) {
    parts.push(preset.promptHints);
    parts.push(preset.shotStyle);
  }

  // 3. Workspace visual style from media profile
  if (ctx?.media?.visualStyle) {
    parts.push(ctx.media.visualStyle);
  }

  // 4. Channel-specific hints
  if (channel && VIDEO_CHANNEL_HINTS[channel]) {
    parts.push(VIDEO_CHANNEL_HINTS[channel]);
  }

  // 5. Industry context
  if (ctx?.industryContext?.label) {
    parts.push(`${ctx.industryContext.label} industry content`);
  }

  // 6. Quality modifiers
  parts.push("high quality, professional production, smooth motion, well-composed");

  return parts.join(", ").trim();
}

export async function enqueueVideoGeneration({
  clientId,
  guidance,
  draftId,
  channel,
  preset,
  duration,
  aspectRatio,
  createdBy,
  userId,
}) {
  const modelId = DEFAULT_VIDEO_MODEL;

  // Load context for prompt enrichment
  let ctx = null;
  try {
    ctx = await loadClientGenerationContext(clientId);
  } catch {
    // Non-critical — generation works with raw guidance
  }

  const renderedPrompt = buildVideoPrompt(ctx, guidance, preset, channel);

  const asset = await prisma.mediaAsset.create({
    data: {
      clientId,
      source: "AI_GENERATED",
      status: "PENDING",
      assetType: "video",
      draftId: draftId ?? null,
      falModelId: modelId,
      renderedPrompt,
      createdBy,
    },
  });

  // Resolution chain: explicit > preset default > channel default > "16:9"
  const presetData = preset ? VIDEO_PRESETS[preset] : null;
  const resolvedAspectRatio =
    aspectRatio ??
    (channel ? VIDEO_CHANNEL_ASPECT_RATIOS[channel] : null) ??
    presetData?.defaultAspectRatio ??
    "16:9";

  // Duration chain: explicit > preset suggestion > "5"
  const resolvedDuration =
    duration ??
    presetData?.suggestedDuration ??
    "5";

  const queue = getVideoGenQueue();
  let queued = false;
  if (queue) {
    const priority = userId ? await getJobPriorityForUser(userId) : 5;
    await queue.add("generate-video", {
      assetId: asset.id,
      aspectRatio: resolvedAspectRatio,
      duration: resolvedDuration,
    }, { priority });
    queued = true;
  }

  return { ...asset, queued };
}
