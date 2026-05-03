/**
 * Persona Recommendation Engine
 *
 * Deterministically evaluates whether a trained AI Brand Persona should be
 * recommended for a generated draft or campaign post. No AI model calls —
 * pure rule-based evaluation computed at response time.
 */

import { PERSONA_BLOCKED_PATTERNS } from "./mediaGeneration.service.js";

// ── Template type → usage category mapping ────────────────────────────────

const PERSONAL_BRAND_TEMPLATES = new Set([
  "brand_authority",
  "personal_brand",
  "behind_the_scenes",
]);

const EDUCATIONAL_TEMPLATES = new Set([
  "educational_tip",
  "tips_advice",
  "market_update",
  "myth_buster",
]);

const LISTING_PROMOTION_TEMPLATES = new Set([
  "listing_post",
  "just_listed",
  "featured_property",
  "open_house",
  "price_drop_alert",
]);

// ── Helpers ───────────────────────────────────────────────────────────────

function isPersonaReady(persona) {
  if (!persona) return false;
  // AGENT: needs completed LoRA
  if (persona.personaType === 'AGENT') {
    return persona.status === "COMPLETED" && !!persona.providerModelId;
  }
  // BRAND_STYLE: needs either LoRA OR styleProfile
  if (persona.personaType === 'BRAND_STYLE') {
    return (persona.status === "COMPLETED" && !!persona.providerModelId) || !!persona.styleProfile;
  }
  return false;
}

function getUsageSettings(persona) {
  return persona?.usageSettings ?? {};
}

function isBlockedContent(guidance, templateType, dataItemType) {
  const textToCheck = [guidance, templateType].filter(Boolean).join(" ");
  if (PERSONA_BLOCKED_PATTERNS.some((re) => re.test(textToCheck))) return true;
  if (dataItemType === "TESTIMONIAL") return true;
  return false;
}

function resolveUsageType(kind) {
  if (kind === "VIDEO_SCRIPT") return "thumbnail";
  return "image_generation";
}

// ── Main evaluation ───────────────────────────────────────────────────────

/**
 * Evaluate whether persona should be recommended for a quick-post draft.
 *
 * @param {{ brandPersona, templateType, guidance, kind, channel, angle, dataItemType }} ctx
 * @returns {PersonaRecommendation | null}
 */
export function evaluatePersonaRecommendation(ctx) {
  const { brandPersona, templateType, guidance, kind, dataItemType } = ctx;

  // No recommendation if persona is missing or not ready
  if (!isPersonaReady(brandPersona)) return null;

  const settings = getUsageSettings(brandPersona);
  const usageType = resolveUsageType(kind);

  // Check blocked content patterns
  if (isBlockedContent(guidance, templateType, dataItemType)) {
    return {
      shouldUsePersona: false,
      suggestedPersonaId: brandPersona.clientId ?? brandPersona.id,
      usageType: "none",
      reason: "Persona not appropriate for this content type (testimonial, review, or factual listing imagery).",
      safetyLevel: "not_allowed",
      autoApply: false,
    };
  }

  // Check category-specific rules
  const template = (templateType || "").toLowerCase();

  // Personal brand — safe
  if (PERSONAL_BRAND_TEMPLATES.has(template)) {
    if (settings.personalBrandPosts === false) return null;
    return buildSafeRecommendation(brandPersona, usageType, settings, "Personal brand content — persona strengthens authority and recognition.");
  }

  // Educational — safe
  if (EDUCATIONAL_TEMPLATES.has(template)) {
    if (settings.educationalGraphics === false) return null;
    return buildSafeRecommendation(brandPersona, usageType, settings, "Educational content — persona adds credibility and personal touch.");
  }

  // Listing promotions — needs_review
  if (LISTING_PROMOTION_TEMPLATES.has(template)) {
    if (settings.listingPromotions === false) return null;
    return {
      shouldUsePersona: true,
      suggestedPersonaId: brandPersona.clientId ?? brandPersona.id,
      usageType,
      reason: "Listing promotion — persona alongside property may need review for appropriateness.",
      safetyLevel: "needs_review",
      autoApply: false,
    };
  }

  // Video script → smart video thumbnails
  if (kind === "VIDEO_SCRIPT") {
    if (settings.smartVideoThumbnails === false) return null;
    return buildSafeRecommendation(brandPersona, "thumbnail", settings, "Video content — persona recommended for thumbnail to boost click-through.");
  }

  // No-data idea posts (general content, no listing reference) — safe
  const isNoDataIdeaPost = guidance?.includes("[NO_DATA_IDEA_POST]") || (!dataItemType && !template);
  if (isNoDataIdeaPost) {
    if (settings.personalBrandPosts === false) return null;
    return buildSafeRecommendation(brandPersona, usageType, settings, "General content — persona adds personal brand presence.");
  }

  // Default: no recommendation for unmatched templates
  return null;
}

/**
 * Evaluate persona recommendation for a campaign post.
 * Maps campaign post angle/label to template patterns and delegates.
 *
 * @param {object} persona - brandPersona object
 * @param {object} post - campaign post { angle, label, channel }
 * @returns {PersonaRecommendation | null}
 */
export function evaluateCampaignPostRecommendation(persona, post) {
  if (!isPersonaReady(persona)) return null;

  const settings = getUsageSettings(persona);

  // Campaign cover images category
  if (settings.campaignCoverImages === false) return null;

  // Map campaign angle to template type for evaluation
  const templateType = mapCampaignAngleToTemplate(post.angle, post.label);

  return evaluatePersonaRecommendation({
    brandPersona: persona,
    templateType,
    guidance: post.label || "",
    kind: "POST",
    channel: post.channel,
    dataItemType: null,
  });
}

// ── Internal helpers ──────────────────────────────────────────────────────

function buildSafeRecommendation(persona, usageType, settings, reason) {
  const autoApply = settings.askBeforeUsing === false;
  return {
    shouldUsePersona: true,
    suggestedPersonaId: persona.clientId ?? persona.id,
    usageType,
    reason,
    safetyLevel: "safe",
    autoApply,
  };
}

/**
 * Map campaign angle/label to the closest template type for rule evaluation.
 */
function mapCampaignAngleToTemplate(angle, label) {
  const a = (angle || "").toLowerCase();
  const l = (label || "").toLowerCase();

  // Authority/brand angles
  if (a.includes("authority") || a.includes("brand") || a.includes("behind")) return "brand_authority";
  if (a.includes("personal") || l.includes("personal brand")) return "personal_brand";

  // Educational angles
  if (a.includes("educational") || a.includes("tip") || a.includes("market")) return "educational_tip";
  if (a.includes("myth")) return "myth_buster";

  // Listing/property angles
  if (a.includes("feature") || a.includes("showcase") || a.includes("listing")) return "featured_property";
  if (a.includes("open_house") || l.includes("open house")) return "open_house";
  if (a.includes("price") || l.includes("price")) return "price_drop_alert";
  if (a.includes("just_listed") || l.includes("just listed")) return "just_listed";

  // Social proof — may contain testimonials
  if (a.includes("social_proof") || a.includes("testimonial") || l.includes("review")) return "listing_post";

  // Default — treat as personal brand (safe)
  return "brand_authority";
}
