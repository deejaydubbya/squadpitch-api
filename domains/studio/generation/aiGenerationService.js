// Content Studio AI generation service.
//
// Model-agnostic, testable facade around the OpenAI provider. Routes call
// `generateDraft` — never the provider directly. Provider errors are
// captured as FAILED draft rows so operators see them in the queue.

import { prisma } from "../../../prisma.js";
import { loadClientGenerationContext } from "./clientOrchestrator.js";
import {
  buildSystemPrompt,
  buildUserPrompt,
  buildResponseFormat,
  buildRemixUserPrompt,
  buildRemixResponseFormat,
} from "./promptBuilder.js";
import { evaluatePersonaRecommendation } from "../personaRecommendation.service.js";
import {
  generateStructuredContent,
  OpenAIProviderError,
} from "./openai.provider.js";
import { formatDraft } from "../draft.service.js";
import { incrementDataItemUsage } from "../data.service.js";
import { trackAiUsage } from "../../billing/aiUsageTracking.service.js";
import { loadRealEstateGenerationAssets } from "../../industry/realEstateGeneration.js";

/**
 * Persist a FAILED draft row when generation fails so operators see the
 * error in the review queue. Mirrors the aiPersona generation.service.js
 * persistFailedDraft pattern.
 */
async function persistFailedDraft({
  clientId,
  kind,
  channel,
  bucketKey,
  guidance,
  createdBy,
  error,
}) {
  const message = error instanceof Error ? error.message : String(error);
  const code =
    error instanceof OpenAIProviderError && error.code
      ? error.code
      : "GENERATION_FAILED";

  return prisma.draft.create({
    data: {
      clientId,
      kind,
      status: "FAILED",
      channel,
      bucketKey: bucketKey ?? null,
      generationGuidance: guidance ?? "",
      modelUsed: "openai-error",
      body: "",
      hooks: [],
      hashtags: [],
      cta: null,
      variations: null,
      altText: null,
      mediaPlan: null,
      warnings: [`[${code}] ${message}`],
      createdBy,
    },
  });
}

/**
 * Normalize the structured response from OpenAI into the shape we persist.
 */
function normalizeVariation(v) {
  if (!v || typeof v !== "object") return null;
  return {
    body: typeof v.body === "string" ? v.body : "",
    hooks: Array.isArray(v.hooks) ? v.hooks.filter((h) => typeof h === "string") : [],
    hashtags: Array.isArray(v.hashtags)
      ? v.hashtags.filter((h) => typeof h === "string").map((h) => h.replace(/^#+/, ""))
      : [],
    cta: typeof v.cta === "string" && v.cta.length > 0 ? v.cta : null,
  };
}

function normalizeScoredHooks(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((h) => h && typeof h === "object" && typeof h.text === "string")
    .map((h) => ({
      text: h.text,
      hookScore: typeof h.hookScore === "number" ? Math.min(10, Math.max(0, h.hookScore)) : 5,
      reason: typeof h.reason === "string" ? h.reason : "",
    }))
    .sort((a, b) => b.hookScore - a.hookScore);
}

function normalizeGeneratedContent(parsed) {
  const rawVariations = Array.isArray(parsed?.variations) ? parsed.variations : [];
  const variations = rawVariations.map(normalizeVariation).filter(Boolean);

  return {
    body: typeof parsed?.body === "string" ? parsed.body : "",
    hooks: Array.isArray(parsed?.hooks)
      ? parsed.hooks.filter((h) => typeof h === "string")
      : [],
    hashtags: Array.isArray(parsed?.hashtags)
      ? parsed.hashtags
          .filter((h) => typeof h === "string")
          .map((h) => h.replace(/^#+/, ""))
      : [],
    cta:
      typeof parsed?.cta === "string" && parsed.cta.length > 0
        ? parsed.cta
        : null,
    variations,
    scoredHooks: normalizeScoredHooks(parsed?.scoredHooks),
    altText:
      typeof parsed?.altText === "string" && parsed.altText.length > 0
        ? parsed.altText
        : null,
    imageGuidance:
      typeof parsed?.imageGuidance === "string" && parsed.imageGuidance.length > 0
        ? parsed.imageGuidance
        : null,
    videoGuidance:
      typeof parsed?.videoGuidance === "string" && parsed.videoGuidance.length > 0
        ? parsed.videoGuidance
        : null,
    mediaPlan: parsed?.mediaPlan && typeof parsed.mediaPlan === "object"
      ? {
          recommendedMediaType: parsed.mediaPlan.recommendedMediaType ?? "image",
          visualConcept: typeof parsed.mediaPlan.visualConcept === "string" ? parsed.mediaPlan.visualConcept : "",
          prompt: typeof parsed.mediaPlan.prompt === "string" ? parsed.mediaPlan.prompt : "",
          negativePrompt: typeof parsed.mediaPlan.negativePrompt === "string" ? parsed.mediaPlan.negativePrompt : "",
          style: typeof parsed.mediaPlan.style === "string" ? parsed.mediaPlan.style : "",
          reason: typeof parsed.mediaPlan.reason === "string" ? parsed.mediaPlan.reason : "",
          fallbackStrategy: typeof parsed.mediaPlan.fallbackStrategy === "string" ? parsed.mediaPlan.fallbackStrategy : "",
          preferredSources: Array.isArray(parsed.mediaPlan.preferredSources)
            ? parsed.mediaPlan.preferredSources.filter(s => typeof s === "string")
            : [],
        }
      : null,
  };
}

/**
 * Generate a Content Studio draft.
 *
 * On generation errors this returns a FAILED draft (never throws to the
 * caller for provider-side issues). Caller errors (e.g. missing client)
 * are still surfaced as structured errors from the orchestrator.
 */
export async function generateDraft({
  clientId,
  kind,
  channel,
  bucketKey,
  guidance,
  templateType,
  createdBy,
  dataItemId,
  blueprintId,
  userId,
  recommendationId,
  contentAngle,
}) {
  const ctx = await loadClientGenerationContext(clientId);

  // Detect no-data idea post from frontend guidance marker
  const isNoDataIdeaPost = guidance?.includes("[NO_DATA_IDEA_POST]") || guidance?.includes("no-data educational/idea post");
  const isMythBuster = guidance?.includes("[MYTH_BUSTER]") || (isNoDataIdeaPost && guidance?.toLowerCase().includes("myth"));

  if (isNoDataIdeaPost) {
    console.log('[GENERATION] No-data idea post detected — skipping real estate assets and listing context');
  }

  // Load real estate generation assets when applicable — skip for no-data idea posts
  let realEstateAssets = null;
  if (!isNoDataIdeaPost && ctx.industryKey === "real_estate" && ctx.realEstateContext) {
    try {
      realEstateAssets = await loadRealEstateGenerationAssets(clientId, ctx.realEstateContext);
    } catch {
      // Non-critical — generation works without RE assets
    }
  }

  // Load optional business data + blueprint — force null for no-data idea posts
  let dataItem = (!isNoDataIdeaPost && dataItemId)
    ? await prisma.workspaceDataItem.findUnique({ where: { id: dataItemId } })
    : null;

  // Auto-select best listing for listing-type templates when no dataItem specified
  // Never auto-select for no-data idea posts
  const LISTING_TEMPLATE_TYPES = ["listing_post", "just_listed", "featured_property", "open_house", "price_drop_alert"];
  let autoSelectedListing = false;
  if (!isNoDataIdeaPost && !dataItem && realEstateAssets?.bestListingSource && templateType && LISTING_TEMPLATE_TYPES.includes(templateType)) {
    dataItem = realEstateAssets.bestListingSource;
    autoSelectedListing = true;
  }

  // Prevent listing templates from generating fake data.
  // If no real listing data is available, swap to a safe template type.
  if (!dataItem && templateType && LISTING_TEMPLATE_TYPES.includes(templateType)) {
    templateType = "brand_authority";
    guidance = "Create a post that establishes your authority in real estate. " +
      "Share a unique perspective, market insight, or professional tip. " +
      "Do NOT reference any specific property listing or invent property details.";
  }

  // For no-data idea posts, strengthen guidance to prevent listing references
  if (isNoDataIdeaPost) {
    const noDataGuidance = "Write a general educational real estate post. Do not mention a property, listing, address, price, square footage, bedrooms, bathrooms, neighborhood, seller, buyer, or showing.";
    const mythGuidance = isMythBuster
      ? " Debunk one common real estate myth in general terms."
      : "";
    // Append stronger guidance to whatever the frontend already sent
    guidance = (guidance ?? "") + " " + noDataGuidance + mythGuidance;
  }

  // Auto-select best blueprint if data item provided but no blueprint specified
  let resolvedBlueprintId = blueprintId;
  let autoSelectedSlug = null;
  if (dataItemId && !blueprintId) {
    try {
      const { getSmartBlueprintForItem } = await import("../dataAnalytics.service.js");
      const best = await getSmartBlueprintForItem(dataItemId, clientId, { channel });
      if (best) {
        resolvedBlueprintId = best.id;
        autoSelectedSlug = best.slug;
      }
    } catch {
      // Smart selection unavailable — proceed without blueprint
    }
  }

  const blueprint = resolvedBlueprintId
    ? await prisma.contentBlueprint.findUnique({ where: { id: resolvedBlueprintId } })
    : null;

  const systemPrompt = buildSystemPrompt(ctx);
  const userPrompt = buildUserPrompt(ctx, {
    kind,
    channel,
    bucketKey,
    guidance,
    templateType,
    dataItem: isNoDataIdeaPost ? null : dataItem,
    blueprint: isNoDataIdeaPost ? null : blueprint,
    realEstateAssets: isNoDataIdeaPost ? null : realEstateAssets,
    contentAngle,
  });
  const responseFormat = buildResponseFormat();

  let result;
  try {
    result = await generateStructuredContent({
      systemPrompt,
      userPrompt,
      responseFormat,
      taskType: "generation",
      temperature: 0.7,
    });
  } catch (err) {
    const failed = await persistFailedDraft({
      clientId,
      kind,
      channel,
      bucketKey,
      guidance,
      createdBy,
      error: err,
    });
    return formatDraft(failed);
  }

  // Fire-and-forget: track AI usage
  if (userId) {
    trackAiUsage({
      userId,
      clientId,
      actionType: "GENERATE_POST",
      model: result.model,
      promptTokens: result.usage?.prompt_tokens ?? 0,
      completionTokens: result.usage?.completion_tokens ?? 0,
    });
  }

  let content = normalizeGeneratedContent(result.parsed);

  // Guardrail: for no-data idea posts, reject content that references listings
  if (isNoDataIdeaPost && content.body) {
    const listingTerms = /\$\d|bedroom|bathroom|sq\s*ft|square\s*feet|listing|showing|open\s*house/i;
    if (listingTerms.test(content.body)) {
      console.log('[GENERATION] No-data guardrail triggered — body contains listing terms, regenerating with stricter guidance');
      try {
        const stricterGuidance = (guidance ?? "") +
          " CRITICAL: Your previous response contained property-specific language. " +
          "Do NOT use dollar amounts, bedroom/bathroom counts, square footage, " +
          "or words like 'listing', 'showing', or 'open house'. " +
          "Write ONLY general educational content.";
        const retryPrompt = buildUserPrompt(ctx, {
          kind, channel, bucketKey,
          guidance: stricterGuidance,
          templateType, dataItem: null, blueprint: null,
          realEstateAssets: null, contentAngle,
        });
        const retry = await generateStructuredContent({
          systemPrompt, userPrompt: retryPrompt,
          responseFormat, taskType: "generation", temperature: 0.5,
        });
        const retryContent = normalizeGeneratedContent(retry.parsed);
        if (!listingTerms.test(retryContent.body)) {
          content = retryContent;
          console.log('[GENERATION] No-data guardrail retry succeeded');
        } else {
          console.log('[GENERATION] No-data guardrail retry still has listing terms — using anyway');
        }
      } catch (retryErr) {
        console.log('[GENERATION] No-data guardrail retry failed', retryErr);
        // Use original content
      }
    }
  }

  const promptVersion = ctx.voice?.version ?? 1;

  const draft = await prisma.draft.create({
    data: {
      clientId,
      kind,
      status: "DRAFT",
      channel,
      bucketKey: bucketKey ?? null,
      generationGuidance: guidance ?? "",
      modelUsed: result.model,
      promptVersion,
      body: content.body,
      hooks: content.hooks,
      hashtags: content.hashtags,
      cta: content.cta,
      variations: content.variations.length > 0 ? content.variations : null,
      scoredHooks: content.scoredHooks.length > 0 ? content.scoredHooks : null,
      altText: content.altText,
      imageGuidance: content.imageGuidance,
      videoGuidance: content.videoGuidance,
      mediaPlan: content.mediaPlan,
      warnings: [
        ...(isNoDataIdeaPost ? ["source:idea_post"] : []),
        ...(autoSelectedSlug ? [`auto_blueprint: ${autoSelectedSlug}`] : []),
        ...(autoSelectedListing ? [`re_auto_listing: ${dataItem?.title ?? "unknown"}`] : []),
        ...(!isNoDataIdeaPost && realEstateAssets ? [`re_assets: listings=${realEstateAssets.listingCount} reviews=${realEstateAssets.reviewCount}`] : []),
        ...(!isNoDataIdeaPost && realEstateAssets?.rotationApplied ? ["re_rotation: applied"] : []),
        ...(!isNoDataIdeaPost && realEstateAssets && !realEstateAssets.bestListing && !dataItem ? ["re_fallback: no_listing"] : []),
        ...(recommendationId ? [`recommendation: ${recommendationId}`] : []),
      ].filter(Boolean),
      createdBy,
    },
  });

  // Record provenance + update usage if data-aware generation
  if (dataItem && blueprint) {
    await prisma.generatedContentSource.create({
      data: {
        draftId: draft.id,
        dataItemId: dataItem.id,
        blueprintId: blueprint.id,
      },
    });
    incrementDataItemUsage(dataItem.id).catch(() => {});
  }

  // Auto-attach image from data item if available (skip for no-data idea posts)
  if (!isNoDataIdeaPost && dataItem?.dataJson?.imageUrl && !draft.mediaUrl) {
    draft.mediaUrl = dataItem.dataJson.imageUrl;
    draft.mediaType = "image";
    await prisma.draft.update({
      where: { id: draft.id },
      data: { mediaUrl: draft.mediaUrl, mediaType: "image" },
    }).catch(() => {});
  }

  const formatted = formatDraft(draft);
  const personaRecommendation = evaluatePersonaRecommendation({
    brandPersona: ctx.brandPersona,
    templateType,
    guidance,
    kind,
    channel,
    dataItemType: dataItem?.type ?? null,
  });
  return personaRecommendation
    ? { ...formatted, personaRecommendation }
    : formatted;
}

// ── Remix ────────────────────────────────────────────────────────────

const KIND_MAP = {
  post: "POST",
  carousel: "CAROUSEL",
  videoScript: "VIDEO_SCRIPT",
  storyCaption: "CAPTION",
};

function normalizeRemixFormat(raw) {
  if (!raw || typeof raw !== "object") return null;
  return {
    body: typeof raw.body === "string" ? raw.body : "",
    hooks: Array.isArray(raw.hooks) ? raw.hooks.filter((h) => typeof h === "string") : [],
    hashtags: Array.isArray(raw.hashtags)
      ? raw.hashtags.filter((h) => typeof h === "string").map((h) => h.replace(/^#+/, ""))
      : [],
    cta: typeof raw.cta === "string" && raw.cta.length > 0 ? raw.cta : null,
  };
}

/**
 * Remix an existing draft into 4 content formats.
 * Returns an array of 4 draft objects (post, carousel, videoScript, storyCaption).
 */
export async function remixDraft({ clientId, draftId, createdBy, userId }) {
  const sourceDraft = await prisma.draft.findUnique({ where: { id: draftId } });
  if (!sourceDraft || sourceDraft.clientId !== clientId) {
    throw new Error("Draft not found");
  }

  const ctx = await loadClientGenerationContext(clientId);
  const systemPrompt = buildSystemPrompt(ctx);
  const userPrompt = buildRemixUserPrompt(sourceDraft.body, sourceDraft.channel);
  const responseFormat = buildRemixResponseFormat();

  const result = await generateStructuredContent({
    systemPrompt,
    userPrompt,
    responseFormat,
    taskType: "remix",
    temperature: 0.7,
  });

  // Fire-and-forget: track AI usage
  if (userId) {
    trackAiUsage({
      userId,
      clientId,
      actionType: "REMIX_CONTENT",
      model: result.model,
      promptTokens: result.usage?.prompt_tokens ?? 0,
      completionTokens: result.usage?.completion_tokens ?? 0,
    });
  }

  const parsed = result.parsed;
  const drafts = [];

  for (const [key, format] of Object.entries(parsed)) {
    const normalized = normalizeRemixFormat(format);
    if (!normalized) continue;

    const kind = KIND_MAP[key] ?? "POST";
    const draft = await prisma.draft.create({
      data: {
        clientId,
        kind,
        status: "DRAFT",
        channel: sourceDraft.channel,
        generationGuidance: `Remixed from draft ${draftId}`,
        modelUsed: result.model,
        body: normalized.body,
        hooks: normalized.hooks,
        hashtags: normalized.hashtags,
        cta: normalized.cta,
        variations: null,
        scoredHooks: null,
        altText: null,
        warnings: [`remix_source: ${draftId}`, `remix_format: ${key}`],
        createdBy,
      },
    });

    drafts.push({ ...formatDraft(draft), remixFormat: key });
  }

  return drafts;
}
