// Payload builders mapping assistant session state → existing API shapes.
// No new endpoints — these produce payloads for existing generation/save routes.

import { AssistantSessionSchema } from "./assistant.schemas.js";

/**
 * Map assistant campaign type to the existing CampaignType expected by promptBuilder.
 * @param {string} assistantType
 * @returns {string}
 */
function mapCampaignType(assistantType) {
  if (assistantType === "general_promotion") return "listing_spotlight";
  return assistantType;
}

/**
 * Build payload for POST /listing-campaign/generate.
 * Matches useGenerateListingCampaign mutation shape.
 *
 * @param {object} session - Assistant session state
 * @param {Record<string, unknown>} propertyData - Normalized property data
 * @param {Array<{ label: string, description?: string }>} [imageContext] - Image context hints
 * @returns {object} Generation payload
 */
export function buildCampaignGenerationPayload(session, propertyData, imageContext) {
  const slots = (session.slots || []).map((slot) => ({
    label: slot.label || `${slot.channel} post`,
    channel: slot.channel,
    campaignDay: slot.campaignDay,
    slotType: slot.slotType || "social_post",
    angle: slot.angle,
  }));

  return {
    propertyData,
    campaignType: mapCampaignType(session.campaignType),
    imageContext: imageContext || undefined,
    slots: slots.length > 0 ? slots : undefined,
  };
}

/**
 * Build payload for POST /listing-campaign/save-drafts.
 * Matches useSaveCampaignDrafts mutation shape.
 *
 * @param {object} session - Assistant session state
 * @param {object} generationResult - Result from campaign generation (ListingCampaignOutput)
 * @param {{ schedulePreset?: number, addToPlanner?: boolean }} [options]
 * @returns {object} Save payload
 */
export function buildSaveDraftsPayload(session, generationResult, options = {}) {
  return {
    campaign: generationResult,
    propertyData: session.propertyData || {},
    campaignType: mapCampaignType(session.campaignType),
    dataItemId: session.selectedPropertyId || null,
    schedulePreset: options.schedulePreset || 7,
    addToPlanner: options.addToPlanner ?? true,
    mediaAssetIds:
      session.selectedMediaIds.length > 0 ? session.selectedMediaIds : undefined,
  };
}

/**
 * Build payload for quick post creation via POST /drafts.
 * Matches useCreateDraft or generation hook shape.
 *
 * @param {object} session - Assistant session state
 * @param {string} clientId
 * @returns {object} Quick post payload
 */
export function buildQuickPostPayload(session, clientId) {
  return {
    clientId,
    kind: session.quickPostKind || "POST",
    channel: session.quickPostChannel,
    guidance: session.quickPostGuidance || undefined,
    templateType: mapCampaignType(session.campaignType || "general_promotion"),
    dataItemId: session.selectedPropertyId || undefined,
  };
}

/**
 * Validate whether session state is sufficient for generation.
 *
 * @param {object} session - Assistant session state
 * @returns {{ ready: boolean, errors: string[] }}
 */
export function validateSessionForGeneration(session) {
  const errors = [];

  if (!session.mode) {
    errors.push("Mode not selected");
  }

  if (session.mode === "campaign") {
    if (!session.campaignType) errors.push("Campaign type not selected");
    if (!session.channels || session.channels.length === 0) {
      errors.push("No channels selected");
    }
    if (!session.selectedPropertyId && !session.propertyData) {
      errors.push("No property selected");
    }
  }

  if (session.mode === "quick_post") {
    if (!session.quickPostChannel) errors.push("No channel selected for quick post");
  }

  return { ready: errors.length === 0, errors };
}
