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
import { isSystemMediaTag, visibleMediaTags } from "./propertyMedia.service.js";

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
  // Check both old FK and new DraftAsset join table
  if (draftId) where.OR = [{ draftId }, { draftAssets: { some: { draftId } } }];
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

  // Exclude intermediate persona cutout assets — only blended composites should show.
  // Use OR so rows with NULL personaSnapshot (most assets) are still included.
  where.AND = [...(where.AND || []), {
    OR: [
      { personaSnapshot: null },
      { NOT: { personaSnapshot: { startsWith: "cutout:" } } },
    ],
  }];

  const assets = await prisma.mediaAsset.findMany({
    where,
    include: {
      _count: { select: { draftAssets: true } },
      ...(draftId && { draftAssets: { where: { draftId }, select: { orderIndex: true, role: true } } }),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    ...(cursor && { skip: 1, cursor: { id: cursor } }),
  });

  // When querying by draftId, sort by join table orderIndex (primary first)
  if (draftId) {
    assets.sort((a, b) => {
      const aIdx = a.draftAssets?.[0]?.orderIndex ?? 999;
      const bIdx = b.draftAssets?.[0]?.orderIndex ?? 999;
      return aIdx - bIdx;
    });
  }

  return assets;
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
  folderId,
  channel,
  overrides,
  createdBy,
  userId,
  usePersona,
  referenceImageUrl,
  composePlacement,
  composePersonaLayer,
}) {
  const ctx = await loadClientGenerationContext(clientId);
  const mediaProfile = ctx.media;

  if (!mediaProfile) {
    throw { status: 400, code: "NO_MEDIA_PROFILE", message: "Client has no media profile" };
  }

  const enrichment = {
    brandName: ctx.client?.name,
    industry: ctx.client?.industryKey ?? ctx.brand?.industry,
    channel,
  };

  // Resolve persona if requested
  let persona = null;
  if (usePersona && ctx.brandPersona) {
    const bp = ctx.brandPersona;
    const hasLoRA = bp.status === "COMPLETED" && bp.providerModelId && bp.triggerPhrase;
    const hasStyleProfile = bp.personaType === "BRAND_STYLE" && bp.styleProfile;
    if ((hasLoRA || hasStyleProfile) && isPersonaAllowedForContent(guidance, enrichment)) {
      persona = bp;
    }
  }

  const renderedPrompt = buildImagePrompt(mediaProfile, guidance, enrichment, persona);
  const { modelId, loraConfig } = resolveModelConfig(mediaProfile, persona);

  const asset = await prisma.mediaAsset.create({
    data: {
      clientId,
      source: "AI_GENERATED",
      status: "PENDING",
      draftId: draftId ?? null,
      folderId: folderId ?? null,
      falModelId: modelId,
      renderedPrompt,
      negativePrompt: DEFAULT_NEGATIVE_PROMPT,
      loraSnapshot: loraConfig?.path ?? null,
      loraScaleSnapshot: loraConfig?.scale ?? null,
      personaSnapshot: persona
        ? (referenceImageUrl
          ? `composite:${persona.name}`
          : persona.personaType === 'BRAND_STYLE'
            ? `style:${persona.name}`
            : persona.name)
        : null,
      createdBy,
    },
  });

  // Merge channel-based aspect ratio into overrides.
  const channelDims = channel ? CHANNEL_ASPECT_RATIOS[channel] : null;
  const mergedOverrides = {
    ...(channelDims ?? {}),
    ...(overrides ?? {}),
    ...(referenceImageUrl ? {
      referenceImageUrl,
      composePlacement: composePlacement ?? 'auto',
      compositeMode: true,
      ...(composePersonaLayer ? { composePersonaLayer } : {}),
    } : {}),
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

  return {
    ...asset,
    queued,
    personaUsed: !!persona,
    personaSkipped: usePersona && !persona,
    personaType: persona?.personaType ?? null,
  };
}

// ── Cutout generation ───────────────────────────────────────────────────

export async function enqueueCutout({
  clientId, pose, outfit, vibe, sceneType, lightingStyle, framingPreset,
  folderId, createdBy, userId,
}) {
  const ctx = await loadClientGenerationContext(clientId);
  const mediaProfile = ctx.media;
  if (!mediaProfile) {
    throw { status: 400, code: "NO_MEDIA_PROFILE", message: "Client has no media profile" };
  }

  let persona = null;
  if (ctx.brandPersona) {
    const bp = ctx.brandPersona;
    if (bp.status === "COMPLETED" && bp.providerModelId && bp.triggerPhrase) {
      persona = bp;
    }
  }
  if (!persona) {
    throw { status: 400, code: "PERSONA_NOT_READY", message: "Brand persona must be fully trained." };
  }

  const guidance = buildCutoutPrompt(persona, { pose, outfit, vibe, sceneType, lightingStyle, framing: framingPreset });
  const { modelId, loraConfig } = resolveModelConfig(mediaProfile, persona);

  const asset = await prisma.mediaAsset.create({
    data: {
      clientId,
      source: "AI_GENERATED",
      status: "PENDING",
      folderId: folderId ?? null,
      falModelId: modelId,
      renderedPrompt: guidance,
      negativePrompt: DEFAULT_NEGATIVE_PROMPT,
      loraSnapshot: loraConfig?.path ?? null,
      loraScaleSnapshot: loraConfig?.scale ?? null,
      personaSnapshot: `cutout:${persona.name}`,
      createdBy,
    },
  });

  const queue = getMediaGenQueue();
  let queued = false;
  if (queue) {
    const priority = userId ? await getJobPriorityForUser(userId) : 5;
    await queue.add("generate", {
      assetId: asset.id,
      overrides: { cutoutMode: true, framingPreset },
    }, { priority });
    queued = true;
  }

  return { ...asset, queued, personaUsed: true };
}

// ── Blend (composite cutout onto background) ────────────────────────────

export async function enqueueBlend({
  clientId, backgroundImageUrl, backgroundAssetId, cutoutImageUrl, cutoutAssetId,
  transform, sceneType, lightingStyle, advanced, folderId, draftId, createdBy, userId,
}) {
  const ctx = await loadClientGenerationContext(clientId);
  const persona = ctx.brandPersona;

  const asset = await prisma.mediaAsset.create({
    data: {
      clientId,
      source: "AI_GENERATED",
      status: "PENDING",
      draftId: draftId ?? null,
      folderId: folderId ?? null,
      falModelId: "blend",
      renderedPrompt: `Blend persona into scene (${sceneType}, ${lightingStyle || 'auto'})`,
      personaSnapshot: persona ? `composite:${persona.name}` : null,
      createdBy,
    },
  });

  const queue = getMediaGenQueue();
  let queued = false;
  if (queue) {
    const priority = userId ? await getJobPriorityForUser(userId) : 5;
    await queue.add("generate", {
      assetId: asset.id,
      overrides: {
        blendMode: true,
        backgroundImageUrl,
        cutoutImageUrl,
        transform,
        sceneType,
        lightingStyle,
        advanced,
      },
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
 *
 * @param {object} enrichment - Optional context for better prompts
 * @param {string} enrichment.brandName - Brand/workspace name
 * @param {string} enrichment.industry - Industry key (e.g. "real_estate")
 * @param {string} enrichment.channel - Target channel (e.g. "INSTAGRAM")
 * @param {string} enrichment.angle - Content angle (e.g. "lifestyle")
 */
export function buildImagePrompt(mediaProfile, guidance, enrichment = {}, persona = null) {
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

  // 2b. Brand style profile (when persona is BRAND_STYLE and has styleProfile)
  if (persona?.personaType === 'BRAND_STYLE' && persona.styleProfile) {
    const sp = persona.styleProfile;
    const styleParts = [];
    if (sp.colors?.length) styleParts.push(`color palette: ${sp.colors.join(', ')}`);
    if (sp.mood) styleParts.push(sp.mood);
    if (sp.styleDescriptors?.length) styleParts.push(sp.styleDescriptors.join(', '));
    if (sp.promptModifiers) styleParts.push(sp.promptModifiers);
    if (styleParts.length) parts.push(styleParts.join(', '));
  }

  // 3. Industry-specific style hints
  if (enrichment.industry) {
    const industryHints = INDUSTRY_STYLE_HINTS[enrichment.industry];
    if (industryHints) parts.push(industryHints);
  }

  // 4. Channel-specific style notes
  if (enrichment.channel) {
    const channelHint = CHANNEL_STYLE_HINTS[enrichment.channel];
    if (channelHint) parts.push(channelHint);
  }

  // 5. Angle-specific style influence
  if (enrichment.angle) {
    const angleHint = ANGLE_STYLE_HINTS[enrichment.angle];
    if (angleHint) parts.push(angleHint);
  }

  // 6. Character prompt (identity details)
  if (mediaProfile.characterPrompt) {
    parts.push(mediaProfile.characterPrompt);
  }

  // 7. Persona trigger phrase (replaces MediaProfile trigger word to avoid conflicts)
  if (persona?.triggerPhrase) {
    parts.push(persona.triggerPhrase);
  } else if (mediaProfile.loraTriggerWord) {
    parts.push(mediaProfile.loraTriggerWord);
  }

  // 8. Universal safety suffix
  parts.push("no text overlays, no watermarks, no logos");

  // 9. Persona safety suffix
  if (persona) {
    if (persona.personaType === 'BRAND_STYLE') {
      parts.push(
        `[Brand Style: ${persona.name}]`,
        "consistent brand aesthetic, no factual property photos, AI-generated content"
      );
    } else {
      parts.push(
        `[Persona: ${persona.name}]`,
        "no fake client testimonials, no fake sold signs, no fabricated claims, no factual property photos, no misleading listing images, no false endorsements, AI-generated content"
      );
    }
  }

  return parts.join(", ").trim();
}

const INDUSTRY_STYLE_HINTS = {
  real_estate: "lifestyle and architectural photography, natural lighting, no fake property photos",
  automotive: "sleek automotive photography, showroom lighting, dynamic angles",
  fitness: "energetic fitness photography, natural movement, motivational atmosphere",
  food: "appetizing food photography, warm tones, shallow depth of field",
  fashion: "editorial fashion photography, clean backgrounds, confident poses",
  beauty: "soft beauty photography, flawless lighting, aspirational aesthetic",
};

const CHANNEL_STYLE_HINTS = {
  INSTAGRAM: "visually striking, square-friendly composition",
  TIKTOK: "vertical composition, vibrant colors, eye-catching",
  YOUTUBE: "cinematic wide composition, thumbnail-worthy",
  LINKEDIN: "professional, clean, corporate-friendly",
  FACEBOOK: "warm and approachable, community-focused",
  X: "bold and attention-grabbing, works at small sizes",
};

const ANGLE_STYLE_HINTS = {
  lifestyle: "warm scene, people enjoying spaces, aspirational living",
  feature: "detailed close-up, highlighting quality and craftsmanship",
  exterior: "wide establishing shot, curb appeal, natural surroundings",
  aerial: "drone perspective, bird's eye view, expansive landscape",
  authority: "professional portrait setting, confident and approachable",
  social_proof: "community gathering, happy people, authentic moments",
};

const DEFAULT_NEGATIVE_PROMPT =
  "blurry, low quality, text, letters, words, signage, typography, slogans, readable text, watermark, logo, fake logo, distorted, deformed, disfigured, bad anatomy, extra limbs, cropped, out of frame";

// ── Compose prompt (Add Me to Photo) ─────────────────────────────────────

const COMPOSE_POSE_MAP = {
  standing: 'standing confidently',
  pointing: 'pointing forward engagingly',
  casual: 'in a relaxed casual pose',
  presenting: 'presenting with an open gesture',
  arms_crossed: 'standing with arms crossed confidently',
  walking: 'walking forward naturally',
};

const COMPOSE_PLACEMENT_MAP = {
  auto: '',
  left: 'on the left side of the scene',
  right: 'on the right side of the scene',
  center: 'in the center of the scene',
};

// ── Lighting prompt maps (Interior + Exterior) ─────────────────────────
const INTERIOR_LIGHTING_MAP = {
  warm_cozy: 'warm color temperature, soft indoor shadows, cozy ambient light, realistic skin tone warmth',
  bright_clean: 'bright neutral lighting, clean white balance, evenly lit subject, minimal harsh shadows',
  natural_window: 'natural daylight from window direction, soft highlights, subtle shadows, balanced exposure',
  moody_cinematic: 'cinematic indoor lighting, controlled contrast, visible shadow grounding, realistic low-key interior mood',
  luxury_high_end: 'luxury interior editorial lighting, balanced warm-neutral tones, soft realistic shadows, premium staging feel',
};

const EXTERIOR_LIGHTING_MAP = {
  golden_hour: 'golden hour sunlight, warm directional light, long realistic shadows, warm highlights on subject',
  midday_sun: 'bright midday exterior lighting, clear sun direction, stronger ground shadow, realistic exposure',
  overcast: 'overcast daylight, soft diffuse light, muted shadows, even subject lighting',
  sunset_dusk: 'dusk lighting, warm sky glow, soft fading daylight, realistic low-light subject exposure',
  twilight_lights_on: 'twilight real estate lighting, cool ambient sky, warm building lights, realistic low-light subject integration',
};

const ALL_LIGHTING_MAP = { ...INTERIOR_LIGHTING_MAP, ...EXTERIOR_LIGHTING_MAP };

const COMPOSE_OUTFIT_MAP = {
  business_suit: 'wearing a professional business suit',
  smart_casual: 'wearing smart casual attire',
  polo_casual: 'wearing a polo shirt and casual pants',
  branded_shirt: 'wearing a branded company shirt',
  luxury_agent: 'wearing luxury designer clothing',
  outdoor_casual: 'wearing outdoor casual clothing',
};

const COMPOSE_VIBE_MAP = {
  friendly_smile: 'with a friendly warm smile',
  professional: 'with a professional composed expression',
  confident: 'with a confident powerful expression',
  welcoming: 'with a welcoming inviting expression',
  energetic: 'with an energetic enthusiastic expression',
};

const COMPOSE_FRAMING_MAP = {
  full_body: {
    intro: 'Full body photo',
    constraints: 'full body standing, feet visible, head to toe visible, entire person in frame, no cropping, centered, realistic proportions, full figure',
  },
  three_quarter: {
    intro: 'Three-quarter body photo',
    constraints: 'three-quarter body shot, visible from knees up, upper body and legs to knees, no feet required, centered, realistic proportions',
  },
  waist_up: {
    intro: 'Waist-up portrait',
    constraints: 'waist-up portrait, upper body visible, cropped at waist, professional marketing image, centered',
  },
  bust: {
    intro: 'Head and shoulders portrait',
    constraints: 'head and shoulders portrait, bust shot, professional marketing image, centered, close-up',
  },
};

/**
 * Build lighting prompt segment based on scene type and lighting style.
 * Returns a detailed lighting instruction string for the generation prompt.
 */
export function buildLightingPrompt({ sceneType, lightingStyle, framing }) {
  // Resolve lighting text
  const lightingText = lightingStyle ? ALL_LIGHTING_MAP[lightingStyle] : null;

  // Scene-aware prefix
  const scenePrefix = sceneType === 'exterior'
    ? 'The inserted person must match the exterior lighting of the original image.'
    : 'The inserted person must match the interior lighting of the original image.';

  // Grounding rules based on framing
  const groundingRule = framing === 'full_body'
    ? 'Ensure the person is physically grounded on the visible floor/ground plane with realistic contact shadows. The subject must not float.'
    : 'Respect the placement preview exactly. Generate only the visible portion matching the preview crop and position.';

  return [scenePrefix, lightingText, groundingRule].filter(Boolean).join(' ');
}

export function buildComposePrompt(persona, { pose, sceneType, lightingStyle, outfit, vibe, framing }) {
  const frame = COMPOSE_FRAMING_MAP[framing] || COMPOSE_FRAMING_MAP.full_body;
  const lightingPrompt = buildLightingPrompt({ sceneType, lightingStyle, framing });
  const lightingText = lightingStyle ? (ALL_LIGHTING_MAP[lightingStyle] || 'natural lighting') : 'natural lighting';

  const parts = [
    `${frame.intro} of a person ${persona.triggerPhrase}`,
    COMPOSE_POSE_MAP[pose],
    outfit ? COMPOSE_OUTFIT_MAP[outfit] : null,
    vibe ? COMPOSE_VIBE_MAP[vibe] : null,
    frame.constraints,
    lightingText,
    'clean solid white background, studio lighting',
    'high quality, sharp focus, marketing photography',
    lightingPrompt,
  ].filter(Boolean);

  return parts.join(', ');
}

export function buildCutoutPrompt(persona, { pose, outfit, vibe, sceneType, lightingStyle, framing }) {
  const frame = COMPOSE_FRAMING_MAP[framing] || COMPOSE_FRAMING_MAP.full_body;
  const lightingText = lightingStyle ? (ALL_LIGHTING_MAP[lightingStyle] || 'natural lighting') : 'natural lighting';

  const parts = [
    `${frame.intro} of a person ${persona.triggerPhrase}`,
    COMPOSE_POSE_MAP[pose],
    outfit ? COMPOSE_OUTFIT_MAP[outfit] : null,
    vibe ? COMPOSE_VIBE_MAP[vibe] : null,
    frame.constraints,
    lightingText,
    'clean solid white background, no room, no floor, no furniture, no props',
    'isolated person only, clean realistic edges, no blur',
    'high quality, sharp focus, crisp detail, high resolution, marketing photography',
  ].filter(Boolean);

  return parts.join(', ');
}

export function resolveModelConfig(mediaProfile, persona = null) {
  // Persona LoRA takes priority over MediaProfile LoRA
  if (persona?.providerModelId) {
    return {
      modelId: "fal-ai/flux-lora",
      loraConfig: {
        path: persona.providerModelId,
        scale: 1.0,
      },
    };
  }

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

// ── Persona safety guardrails ────────────────────────────────────────────

export const PERSONA_BLOCKED_PATTERNS = [
  /\b(testimonial|client\s*story|review)\b/i,
  /\b(sold\s*sign|just\s*sold|fabricated|factual)\b/i,
  /\b(factual\s*(listing|property)\s*photo)\b/i,
];

/**
 * Check whether persona usage is appropriate for the given content.
 * Returns false for content types where a persona likeness would be misleading.
 */
function isPersonaAllowedForContent(guidance, enrichment = {}) {
  const textToCheck = [guidance, enrichment.contentType].filter(Boolean).join(" ");
  return !PERSONA_BLOCKED_PATTERNS.some((re) => re.test(textToCheck));
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
    tags: visibleMediaTags(asset.tags ?? []),
    systemTags: (asset.tags ?? []).filter(isSystemMediaTag),
    propertyDataItemId: asset.propertyDataItemId ?? null,
    draftId: asset.draftId,
    displayOrder: asset.displayOrder,
    falModelId: asset.falModelId,
    renderedPrompt: asset.renderedPrompt,
    personaSnapshot: asset.personaSnapshot ?? null,
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
  const current = await prisma.mediaAsset.findUnique({ where: { id: assetId }, select: { tags: true } });
  const systemTags = (current?.tags ?? []).filter(isSystemMediaTag);
  return prisma.mediaAsset.update({
    where: { id: assetId },
    data: { tags: [...new Set([...tags.filter((tag) => !isSystemMediaTag(tag)), ...systemTags])] },
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
