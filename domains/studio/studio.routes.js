// Squadpitch studio routes.
//
// Mounted under /api/v1/*. The app-level requireAuth + requireUser
// guard in server.js covers /api/*, so this router doesn't add its own.

import express from "express";
import { prisma } from "../../prisma.js";
import { getAuth0Sub } from "../../middleware/auth.js";
import { sendError, validationError } from "../../lib/apiErrors.js";
import { sniffImageMime, sniffVideoMime } from "../../lib/mimeDetect.js";
import { computeAutoScheduleSlots, resolveClientTimezone } from "../../lib/scheduleHelpers.js";
import {
  requireClientOwner,
  requireDraftOwner,
  requireAssetOwner,
  requireAssetAndDraftSameWorkspace,
  requireBodyClientOwner,
  assertClientOwnedByCurrentUser,
  assertDraftInClient,
  assertFolderInClient,
  assertAssetInClient,
  assertDataItemInClient,
} from "./ownership.js";
import { requireInternalAccess } from "../../middleware/requireRole.js";
import { classifyAutoScheduleResult } from "./autoScheduleClassifier.js";
import * as service from "./studio.service.js";
import {
  CreateClientSchema,
  UpdateClientSchema,
  UpsertBrandProfileSchema,
  UpsertVoiceProfileSchema,
  UpsertMediaProfileSchema,
  UpsertChannelSettingsSchema,
  GenerateContentSchema,
  UpdateDraftSchema,
  RejectDraftSchema,
  ScheduleDraftSchema,
  InlineActionSchema,
  ListDraftsQuerySchema,
  ListAssetsQuerySchema,
  GenerateMediaSchema,
  GenerateVideoSchema,
  AttachAssetSchema,
  LinkAssetSchema,
  GeneratePostFromAssetSchema,
  MetricsSummaryQuerySchema,
  AnalyticsOverviewQuerySchema,
  ChannelParamSchema,
  OAuthCompleteSchema,
  CreateDataSourceSchema,
  CreateDataItemSchema,
  UpdateDataItemSchema,
  ListDataItemsQuerySchema,
  ListBlueprintsQuerySchema,
  ContentOpportunitiesQuerySchema,
  BulkGenerateSchema,
  DataPerformanceQuerySchema,
  AutopilotPreviewSchema,
  AutopilotExecuteSchema,
  ImportFromUrlSchema,
  ImportFromTextSchema,
  ImportCSVPreviewSchema,
  ImportCSVExtractSchema,
  ImportFromSheetsSchema,
  ImportFromNotionSchema,
  ConfirmImportSchema,
  OnboardingAnalyzeSchema,
  ManualSetupSchema,
  ListingFeedRefreshSchema,
  ListingFeedSettingsSchema,
  AutopilotSettingsSchema,
  ContentPreferencesUpdateSchema,
  PlannerSuggestionsSchema,
  PlanMyWeekSchema,
  SwapSuggestionSchema,
  ManualListingSchema,
  ListingCSVPreviewSchema,
  ListingCSVImportSchema,
  ListingUrlImportSchema,
  ListingConfirmUrlSchema,
  GBPCallbackSchema,
  GBPSetLocationSchema,
  GBPReplySchema,
  GBPPostSchema,
  CRMConnectSchema,
  CreateListingSourceSchema,
  UpdateListingSourceSchema,
  RatePerformanceSchema,
  GenerateSeriesSchema,
  ZillowExtractSchema,
  LicenseLookupSchema,
  CrmAnalyzeSchema,
  UploadFromUrlSchema,
  CreateTrackableLinkSchema,
  LogConversionEventSchema,
  UpsertBrandPersonaSchema,
  AddTrainingImageSchema,
  GeneratePersonaFramesSchema,
  PersonaFeedbackSchema,
  PersonaComposeSchema,
  PersonaCutoutSchema,
  PersonaBlendSchema,
} from "./studio.schemas.js";
import { getAnalyticsOverview, getPostDetail } from "./analyticsOverview.service.js";
import { getPostMetricHistory, getPostMetricGrowth } from "./postMetricHistory.service.js";
import * as dataService from "./data.service.js";
import * as blueprintService from "./blueprint.service.js";
import * as opportunityService from "./contentOpportunity.service.js";
import * as dataAnalyticsService from "./dataAnalytics.service.js";
import { generateInsights } from "./insights.service.js";
import { generateRecommendations } from "./recommendations.service.js";
import { previewAutopilot, executeAutopilot } from "./dataAwareAutopilot.service.js";
import { getDashboardRecommendations, getDashboardActions } from "./dashboard.service.js";
import { getRecommendations } from "./recommendationEngine.service.js";
import { getUnusedData, getDataSuggestions } from "./dataUsage.service.js";
import { signState, verifyState } from "./oauth/oauthStateCodec.js";
import { getOAuthForChannel } from "./oauth/index.js";
import { checkUsageLimit, incrementUsage, checkUsageNearing, checkClientLimit, getSubscription, getEffectiveTier, checkStorageLimit, buildQuotaError, enforceUsageLimit } from "../billing/billing.service.js";
import { getLimitsForTier } from "../billing/billing.constants.js";
import { trackAiUsage } from "../billing/aiUsageTracking.service.js";
import { isProviderBudgetExceeded, getServiceStatus, getThrottlePolicy } from "../billing/serviceHealth.service.js";
import { redisGet, redisSet, redisSetNX, redisDel } from "../../redis.js";
import crypto from "crypto";
import { encryptToken } from "../../lib/tokenCrypto.js";
import { enqueueNotification, recordActivity } from "../notifications/notification.service.js";
import * as importService from "./dataImport.service.js";
import * as onboardingService from "./onboardingSetup.service.js";
import * as agentOnboarding from "./agentOnboarding.service.js";
import { crawlWebsite } from "./crawlWebsite.js";
import { filterPropertyImages } from "./scrapeUrl.js";
import { getStarterAngles, getIndustryTechStack, getRecommendationTemplates, getAssetTagDefaults } from "../industry/industry.service.js";
import { RE_CAPABILITY_MAP } from "../industry/realEstateContext.js";
import {
  getWorkspaceTechStackView,
  upsertWorkspaceTechStackConnection,
} from "../industry/techStack.service.js";
import { invalidateClientContext } from "./generation/clientOrchestrator.js";
import { getAutopilotSettings, updateAutopilotSettings, runAutopilot, runScheduledAutopilot, evaluateAllAutopilotWorkspaces, getAutopilotStatus, getAutopilotReadiness, getAutopilotActivity } from "./autopilot.service.js";
import { getContentPreferences, updateContentPreferences } from "./contentPreferences.service.js";
import { zonedLocalToUtc, bumpToNextAllowedDay, getClientTimezone } from "../../lib/timezone.js";
import { initialCampaignStatus, formatCampaign } from "./campaign.service.js";
import { evaluateFlag } from "../internal/config.service.js";
import { getPlannerSuggestions, planMyWeek, swapSuggestion } from "./plannerSuggestion.service.js";
import { getAllTimingSuggestions } from "./postTiming.js";
import * as listingIngestion from "./listingIngestion.service.js";
import * as gbpProvider from "../integrations/providers/gbpProvider.js";
import { syncGBP, getGBPReviews, getGBPBusinessProfile, getGBPInsights } from "./gbpSync.service.js";
import { reanalyzeAllReviews } from "./gbpReviewAnalysis.service.js";
import * as fubProvider from "../integrations/providers/fubProvider.js";
import { syncCRM } from "./crmSync.service.js";
import * as listingFeedService from "./listingFeed.service.js";
import * as trackableLinkService from "./trackableLink.service.js";
import { logConversionEvent } from "./conversionEvent.service.js";
import { stampSourceAttribution, RE_SOURCE_TYPES } from "../industry/realEstateAssets.js";
import * as personaService from "./brandPersona.service.js";
import { requireTier } from "../../middleware/requireTier.js";
import { validateDraftMedia } from "./publishing/publishingService.js";
import { enrichListingById, enrichAllListings } from "../industry/propertyEnrichment.service.js";
import { evaluateStaleListings, getEvents } from "./listingEvents.service.js";
import { generateSampleListings, simulateListingEvent } from "./listingSimulator.service.js";
import * as propertyDataService from "../industry/propertyData.service.js";
import multer from "multer";
import { parseDocument, isAcceptedFile } from "./documentParser.js";

export const studioRouter = express.Router();

const BASE = "/api/v1";
const DEDUP_TTL = 30; // seconds — prevents double-click duplicate AI calls (auto-expires as safety net)

/**
 * Acquire a short-lived Redis lock to prevent duplicate AI calls.
 * Returns the lock key if acquired (so caller can release it), or null if already in-flight.
 */
async function acquireDedup(userId, action, body) {
  const hash = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  const key = `sp:dedup:${userId}:${action}:${hash}`;
  // Atomic set-if-not-exists via NX — avoids GET/SET race condition
  const acquired = await redisSetNX(key, "1", DEDUP_TTL);
  return acquired ? key : null;
}

/** Release a dedup lock early (on success or failure). */
async function releaseDedup(key) {
  if (key) await redisDel(key);
}

// Ownership middleware lives in ./ownership.js so the isolation tests
// can import the four guards (`requireClientOwner`, `requireDraftOwner`,
// `requireAssetOwner`, `requireAssetAndDraftSameWorkspace`) without
// booting this entire router. The middlewares are imported at the top
// of this file.

// ── Clients ─────────────────────────────────────────────────────────────

studioRouter.get(`${BASE}/workspaces`, async (req, res, next) => {
  try {
    const actorSub = getAuth0Sub(req);
    const clients = await service.listClients(actorSub);
    res.json({ clients: clients.map(service.formatClient) });
  } catch (err) {
    next(err);
  }
});

studioRouter.post(`${BASE}/workspaces`, async (req, res, next) => {
  try {
    const parsed = CreateClientSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);

    const allowed = await checkClientLimit(req.user.id);
    if (!allowed) {
      return sendError(res, 403, "CLIENT_LIMIT_REACHED", "Upgrade your plan to create more clients");
    }

    const actorSub = getAuth0Sub(req);
    const client = await service.createClient(parsed.data, actorSub);
    res.status(201).json(service.formatClient(client));
  } catch (err) {
    next(err);
  }
});

studioRouter.get(`${BASE}/workspaces/:id`, requireClientOwner, async (req, res, next) => {
  try {
    const actorSub = getAuth0Sub(req);
    const client = await service.getClient(req.params.id, actorSub);
    if (!client) return sendError(res, 404, "NOT_FOUND", "Client not found");
    res.json(service.formatClient(client));
  } catch (err) {
    next(err);
  }
});

studioRouter.patch(`${BASE}/workspaces/:id`, requireClientOwner, async (req, res, next) => {
  try {
    const parsed = UpdateClientSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    const actorSub = getAuth0Sub(req);
    const client = await service.updateClient(req.params.id, parsed.data, actorSub);
    res.json(service.formatClient(client));
  } catch (err) {
    next(err);
  }
});

studioRouter.delete(`${BASE}/workspaces/:id`, requireClientOwner, async (req, res, next) => {
  try {
    const actorSub = getAuth0Sub(req);
    const client = await service.archiveClient(req.params.id, actorSub);
    res.json(service.formatClient(client));
  } catch (err) {
    next(err);
  }
});

// ── Brand profile ───────────────────────────────────────────────────────

studioRouter.get(`${BASE}/workspaces/:id/brand`, requireClientOwner, async (req, res, next) => {
  try {
    const brand = await service.getBrandProfile(req.params.id);
    res.json({ brand: service.formatBrandProfile(brand) });
  } catch (err) {
    next(err);
  }
});

studioRouter.put(`${BASE}/workspaces/:id/brand`, requireClientOwner, async (req, res, next) => {
  try {
    const parsed = UpsertBrandProfileSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    const actorSub = getAuth0Sub(req);
    const brand = await service.upsertBrandProfile(
      req.params.id,
      parsed.data,
      actorSub
    );
    res.json({ brand: service.formatBrandProfile(brand) });
  } catch (err) {
    next(err);
  }
});

// ── Voice profile ───────────────────────────────────────────────────────

studioRouter.get(`${BASE}/workspaces/:id/voice`, requireClientOwner, async (req, res, next) => {
  try {
    const voice = await service.getVoiceProfile(req.params.id);
    res.json({ voice: service.formatVoiceProfile(voice) });
  } catch (err) {
    next(err);
  }
});

studioRouter.put(`${BASE}/workspaces/:id/voice`, requireClientOwner, async (req, res, next) => {
  try {
    const parsed = UpsertVoiceProfileSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    const actorSub = getAuth0Sub(req);
    const voice = await service.upsertVoiceProfile(
      req.params.id,
      parsed.data,
      actorSub
    );
    res.json({ voice: service.formatVoiceProfile(voice) });
  } catch (err) {
    next(err);
  }
});

// ── Media profile ───────────────────────────────────────────────────────

studioRouter.get(`${BASE}/workspaces/:id/media`, requireClientOwner, async (req, res, next) => {
  try {
    const media = await service.getMediaProfile(req.params.id);
    res.json({ media: service.formatMediaProfile(media) });
  } catch (err) {
    next(err);
  }
});

studioRouter.put(`${BASE}/workspaces/:id/media`, requireClientOwner, async (req, res, next) => {
  try {
    const parsed = UpsertMediaProfileSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    const actorSub = getAuth0Sub(req);
    const media = await service.upsertMediaProfile(
      req.params.id,
      parsed.data,
      actorSub
    );
    res.json({ media: service.formatMediaProfile(media) });
  } catch (err) {
    next(err);
  }
});

// ── Brand Persona ──────────────────────────────────────────────────────

studioRouter.get(`${BASE}/workspaces/:id/brand-persona`, requireClientOwner, async (req, res, next) => {
  try {
    const persona = await personaService.getBrandPersona(req.params.id);
    res.json({ persona: personaService.formatBrandPersona(persona) });
  } catch (err) {
    next(err);
  }
});

studioRouter.put(`${BASE}/workspaces/:id/brand-persona`, requireClientOwner, async (req, res, next) => {
  try {
    const parsed = UpsertBrandPersonaSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    const actorSub = getAuth0Sub(req);
    const persona = await personaService.upsertBrandPersona(
      req.params.id,
      parsed.data,
      actorSub
    );

    // Fire PERSONA_CREATED for new personas (createdAt matches updatedAt)
    if (persona.createdAt?.getTime() === persona.updatedAt?.getTime()) {
      recordActivity({
        userId: req.user.id,
        clientId: req.params.id,
        eventType: "PERSONA_CREATED",
        payload: { personaName: persona.name, personaType: persona.personaType, clientId: req.params.id },
        resourceType: "persona",
        resourceId: req.params.id,
      }).catch(() => {});
    }

    res.json({ persona: personaService.formatBrandPersona(persona) });
  } catch (err) {
    next(err);
  }
});

studioRouter.delete(`${BASE}/workspaces/:id/brand-persona`, requireClientOwner, async (req, res, next) => {
  try {
    await personaService.deleteBrandPersona(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

studioRouter.post(`${BASE}/workspaces/:id/brand-persona/training-images`, requireClientOwner, async (req, res, next) => {
  try {
    const parsed = AddTrainingImageSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    const actorSub = getAuth0Sub(req);
    const image = await personaService.addTrainingImage(
      req.params.id,
      parsed.data,
      actorSub
    );
    res.status(201).json({ image });
  } catch (err) {
    next(err);
  }
});

studioRouter.delete(`${BASE}/workspaces/:id/brand-persona/training-images/:imageId`, requireClientOwner, async (req, res, next) => {
  try {
    const actorSub = getAuth0Sub(req);
    await personaService.removeTrainingImage(
      req.params.id,
      req.params.imageId,
      actorSub
    );
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

studioRouter.post(`${BASE}/workspaces/:id/brand-persona/consent`, requireClientOwner, async (req, res, next) => {
  try {
    const actorSub = getAuth0Sub(req);
    const persona = await personaService.recordConsent(req.params.id, actorSub);
    res.json({ persona: personaService.formatBrandPersona(persona) });
  } catch (err) {
    next(err);
  }
});

studioRouter.post(`${BASE}/workspaces/:id/brand-persona/train`, requireClientOwner, async (req, res, next) => {
  try {
    const actorSub = getAuth0Sub(req);

    // Check fal service health before starting expensive training
    if (await getServiceStatus("fal") === "down") {
      return sendError(res, 503, "SERVICE_UNAVAILABLE", "AI training temporarily unavailable");
    }
    if (await isProviderBudgetExceeded("fal")) {
      return sendError(res, 503, "BUDGET_EXCEEDED", "AI budget limits exceeded. Try again later");
    }

    const result = await personaService.startTraining(req.params.id, actorSub);

    recordActivity({
      userId: req.user.id,
      clientId: req.params.id,
      eventType: "PERSONA_TRAINING_STARTED",
      payload: { personaName: result.personaName ?? null, clientId: req.params.id },
      resourceType: "persona",
      resourceId: req.params.id,
    }).catch(() => {});

    res.status(202).json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});

studioRouter.post(`${BASE}/workspaces/:id/brand-persona/previews`, requireClientOwner, async (req, res, next) => {
  try {
    const actorSub = getAuth0Sub(req);
    const previews = await personaService.requestPreviews(req.params.id, actorSub);
    res.json({ previews });
  } catch (err) {
    next(err);
  }
});

studioRouter.post(`${BASE}/workspaces/:id/brand-persona/generate-frames`, (req, _res, next) => {
  req.log?.info({ route: "generate-frames", clientId: req.params.id, hasSub: !!getAuth0Sub(req) }, "generate_frames_hit");
  next();
}, requireClientOwner, async (req, res, next) => {
  try {
    const parsed = GeneratePersonaFramesSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);

    if (await getServiceStatus("fal") === "down") {
      return sendError(res, 503, "SERVICE_UNAVAILABLE", "AI image generation temporarily unavailable");
    }
    if (await isProviderBudgetExceeded("fal")) {
      return sendError(res, 503, "BUDGET_EXCEEDED", "AI budget limits exceeded. Try again later");
    }

    const frames = await personaService.generatePersonaFrames(req.params.id, parsed.data.frames);

    recordActivity({
      userId: req.user.id,
      clientId: req.params.id,
      eventType: "PERSONA_USED_IN_SMART_VIDEO",
      payload: { personaName: null, frameCount: frames.length, clientId: req.params.id },
      resourceType: "persona",
      resourceId: req.params.id,
    }).catch(() => {});

    res.json({ frames });
  } catch (err) {
    next(err);
  }
});

// ── Persona Compose (Add Me to Photo) ──────────────────────────────────

studioRouter.post(`${BASE}/persona/compose`, async (req, res, next) => {
  try {
    const parsed = PersonaComposeSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);

    const { clientId, sourceImageUrl, sourceAssetId, pose, sceneType, lightingStyle, outfit, vibe, personaLayer, folderId, draftId } = parsed.data;

    // Ownership check
    const client = await prisma.client.findUnique({ where: { id: clientId }, select: { createdBy: true } });
    if (!client) return sendError(res, 404, "NOT_FOUND", "Client not found");
    if (client.createdBy !== getAuth0Sub(req)) return sendError(res, 403, "FORBIDDEN", "Forbidden");

    // Cross-workspace checks for any optional id references in the body.
    try {
      await assertAssetInClient(sourceAssetId, clientId);
      await assertDraftInClient(draftId, clientId);
      await assertFolderInClient(folderId, clientId);
    } catch (e) {
      return sendError(res, e.status ?? 404, e.code ?? "NOT_FOUND", e.message);
    }

    // Service health pre-flight
    if (await getServiceStatus("fal") === "down") return sendError(res, 503, "SERVICE_UNAVAILABLE", "Image generation temporarily unavailable.");
    if (await isProviderBudgetExceeded("fal")) return sendError(res, 503, "BUDGET_EXCEEDED", "AI budget limits exceeded. Try again later.");

    // Usage limit checks
    const genQuotaErr = await enforceUsageLimit(req.user.id, "imageGenerations");
    if (genQuotaErr) return sendError(res, 402, genQuotaErr.code, "Image generation limit reached. Upgrade for more.", genQuotaErr);
    const imgQuotaErr = await enforceUsageLimit(req.user.id, "images");
    if (imgQuotaErr) return sendError(res, 402, imgQuotaErr.code, "Image limit reached. Upgrade for more.", imgQuotaErr);

    // Check persona is COMPLETED with LoRA
    const persona = await personaService.getBrandPersona(clientId);
    if (!persona || persona.status !== "COMPLETED" || !persona.providerModelId || !persona.triggerPhrase) {
      return sendError(res, 400, "PERSONA_NOT_READY", "Brand persona must be fully trained before compositing.");
    }

    // Build compose prompt — use framingPreset for prompt generation
    const framingPreset = personaLayer?.framingPreset ?? 'full_body';
    const guidance = service.buildComposePrompt(persona, { pose, sceneType, lightingStyle, outfit, vibe, framing: framingPreset });

    // Enqueue generation with reference image
    const actorSub = getAuth0Sub(req);
    const asset = await service.enqueueGeneration({
      clientId,
      guidance,
      draftId,
      folderId: folderId ?? (sourceAssetId ? (await service.getAsset(sourceAssetId))?.folderId : null) ?? undefined,
      usePersona: true,
      referenceImageUrl: sourceImageUrl,
      composePlacement: 'auto',
      composePersonaLayer: personaLayer,
      createdBy: actorSub,
      userId: req.user.id,
    });

    await Promise.all([
      incrementUsage(req.user.id, "imageGenerations"),
      incrementUsage(req.user.id, "images"),
    ]);

    trackAiUsage({
      userId: req.user.id,
      clientId,
      actionType: "IMAGE",
      model: "fal-ai/flux-lora/image-to-image",
      promptTokens: 0,
      completionTokens: 0,
    });

    recordActivity({
      userId: req.user.id,
      clientId,
      eventType: "PERSONA_USED_IN_IMAGE",
      payload: { personaName: persona.name, compose: true, pose, sceneType, lightingStyle, outfit, vibe, framingPreset, clientId },
      resourceType: "asset",
      resourceId: asset.id,
    }).catch(() => {});

    res.status(201).json({ asset: service.formatAsset(asset), metadata: { pose, sceneType, lightingStyle, outfit, vibe, framingPreset, personaLayer } });
  } catch (err) {
    next(err);
  }
});

// ── Persona cutout generation ────────────────────────────────────────────

studioRouter.post(`${BASE}/persona/cutout`, async (req, res, next) => {
  try {
    const parsed = PersonaCutoutSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);

    const { clientId, pose, outfit, vibe, sceneType, lightingStyle, framingPreset, folderId } = parsed.data;

    const client = await prisma.client.findUnique({ where: { id: clientId }, select: { createdBy: true } });
    if (!client) return sendError(res, 404, "NOT_FOUND", "Client not found");
    if (client.createdBy !== getAuth0Sub(req)) return sendError(res, 403, "FORBIDDEN", "Forbidden");

    try {
      await assertFolderInClient(folderId, clientId);
    } catch (e) {
      return sendError(res, e.status ?? 404, e.code ?? "NOT_FOUND", e.message);
    }

    if (await getServiceStatus("fal") === "down") return sendError(res, 503, "SERVICE_UNAVAILABLE", "Image generation temporarily unavailable.");
    if (await isProviderBudgetExceeded("fal")) return sendError(res, 503, "BUDGET_EXCEEDED", "AI budget limits exceeded.");

    const genQuotaErr = await enforceUsageLimit(req.user.id, "imageGenerations");
    if (genQuotaErr) return sendError(res, 402, genQuotaErr.code, "Image generation limit reached.", genQuotaErr);

    const persona = await personaService.getBrandPersona(clientId);
    if (!persona || persona.status !== "COMPLETED" || !persona.providerModelId || !persona.triggerPhrase) {
      return sendError(res, 400, "PERSONA_NOT_READY", "Brand persona must be fully trained.");
    }

    const actorSub = getAuth0Sub(req);
    const asset = await service.enqueueCutout({
      clientId, pose, outfit, vibe, sceneType, lightingStyle, framingPreset,
      folderId, createdBy: actorSub, userId: req.user.id,
    });

    await incrementUsage(req.user.id, "imageGenerations");

    trackAiUsage({
      userId: req.user.id, clientId, actionType: "IMAGE",
      model: "fal-ai/flux-lora", promptTokens: 0, completionTokens: 0,
    });

    res.status(201).json({ asset: service.formatAsset(asset), metadata: { pose, outfit, vibe, sceneType, lightingStyle, framingPreset } });
  } catch (err) {
    next(err);
  }
});

// ── Persona blend (composite cutout onto background) ─────────────────���──

studioRouter.post(`${BASE}/persona/blend`, async (req, res, next) => {
  try {
    const parsed = PersonaBlendSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);

    const { clientId, backgroundImageUrl, backgroundAssetId, cutoutImageUrl, cutoutAssetId, transform, sceneType, lightingStyle, advanced, folderId, draftId } = parsed.data;

    const client = await prisma.client.findUnique({ where: { id: clientId }, select: { createdBy: true } });
    if (!client) return sendError(res, 404, "NOT_FOUND", "Client not found");
    if (client.createdBy !== getAuth0Sub(req)) return sendError(res, 403, "FORBIDDEN", "Forbidden");

    try {
      await assertAssetInClient(backgroundAssetId, clientId);
      await assertAssetInClient(cutoutAssetId, clientId);
      await assertDraftInClient(draftId, clientId);
      await assertFolderInClient(folderId, clientId);
    } catch (e) {
      return sendError(res, e.status ?? 404, e.code ?? "NOT_FOUND", e.message);
    }

    const imgQuotaErr = await enforceUsageLimit(req.user.id, "images");
    if (imgQuotaErr) return sendError(res, 402, imgQuotaErr.code, "Image limit reached.", imgQuotaErr);

    const actorSub = getAuth0Sub(req);
    const asset = await service.enqueueBlend({
      clientId, backgroundImageUrl, backgroundAssetId, cutoutImageUrl, cutoutAssetId,
      transform, sceneType, lightingStyle, advanced, folderId, draftId,
      createdBy: actorSub, userId: req.user.id,
    });

    await incrementUsage(req.user.id, "images");

    res.status(201).json({ asset: service.formatAsset(asset), metadata: { transform, sceneType, lightingStyle } });
  } catch (err) {
    next(err);
  }
});

// ── Channel settings ────────────────────────────────────────────────────

studioRouter.get(`${BASE}/workspaces/:id/channels`, requireClientOwner, async (req, res, next) => {
  try {
    const channels = await service.listChannelSettings(req.params.id);
    res.json({ channels: channels.map(service.formatChannelSettings) });
  } catch (err) {
    next(err);
  }
});

studioRouter.put(`${BASE}/workspaces/:id/channels`, requireClientOwner, async (req, res, next) => {
  try {
    const parsed = UpsertChannelSettingsSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    const channels = await service.upsertChannelSettings(
      req.params.id,
      parsed.data.items
    );
    res.json({ channels: channels.map(service.formatChannelSettings) });
  } catch (err) {
    next(err);
  }
});

// ── Business Data ──────────────────────────────────────────────────────

studioRouter.get(
  `${BASE}/workspaces/:id/data-sources`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const sources = await dataService.listDataSources(req.params.id);
      res.json({ dataSources: sources.map(dataService.formatDataSource) });
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/workspaces/:id/data-sources`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = CreateDataSourceSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const source = await dataService.createDataSource(req.params.id, parsed.data);
      res.status(201).json(dataService.formatDataSource(source));
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.get(
  `${BASE}/workspaces/:id/business-data`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = ListDataItemsQuerySchema.safeParse(req.query);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const items = await dataService.listDataItems(req.params.id, parsed.data);
      res.json({ dataItems: items.map(dataService.formatDataItem) });
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/workspaces/:id/business-data`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = CreateDataItemSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const item = await dataService.createDataItem(req.params.id, parsed.data);
      res.status(201).json(dataService.formatDataItem(item));
    } catch (err) {
      next(err);
    }
  }
);

// Workspace-scoped business-data item routes. Replaces the legacy
// /business-data/:itemId routes which had no ownership check —
// any authenticated user could read/modify/delete any workspace's
// items by guessing cuid ids. Every handler now runs
// requireClientOwner (auth → owner of :id matches) AND the service
// layer scopes every query by clientId (defense in depth).
//
// The "Item not found" response intentionally covers both "doesn't
// exist" and "exists in a different workspace" so we don't leak
// existence across tenants.
studioRouter.get(
  `${BASE}/workspaces/:id/business-data/:itemId`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const item = await dataService.getDataItem(req.params.id, req.params.itemId);
      if (!item) return sendError(res, 404, "NOT_FOUND", "Data item not found");
      res.json(dataService.formatDataItem(item));
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.patch(
  `${BASE}/workspaces/:id/business-data/:itemId`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = UpdateDataItemSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const item = await dataService.updateDataItem(
        req.params.id,
        req.params.itemId,
        parsed.data,
      );
      if (!item) return sendError(res, 404, "NOT_FOUND", "Data item not found");
      res.json(dataService.formatDataItem(item));
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/workspaces/:id/business-data/:itemId/archive`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const item = await dataService.archiveDataItem(
        req.params.id,
        req.params.itemId,
      );
      if (!item) return sendError(res, 404, "NOT_FOUND", "Data item not found");
      res.json(dataService.formatDataItem(item));
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.delete(
  `${BASE}/workspaces/:id/business-data/:itemId`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const ok = await dataService.deleteDataItem(
        req.params.id,
        req.params.itemId,
      );
      if (!ok) return sendError(res, 404, "NOT_FOUND", "Data item not found");
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// ── Content Blueprints ─────────────────────────────────────────────────

studioRouter.get(`${BASE}/content-blueprints`, async (req, res, next) => {
  try {
    const parsed = ListBlueprintsQuerySchema.safeParse(req.query);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    const blueprints = await blueprintService.listBlueprints(parsed.data);
    res.json({ blueprints: blueprints.map(blueprintService.formatBlueprint) });
  } catch (err) {
    next(err);
  }
});

studioRouter.get(`${BASE}/content-blueprints/:id`, async (req, res, next) => {
  try {
    const bp = await blueprintService.getBlueprint(req.params.id);
    if (!bp) return sendError(res, 404, "NOT_FOUND", "Blueprint not found");
    res.json(blueprintService.formatBlueprint(bp));
  } catch (err) {
    next(err);
  }
});

// ── Content Opportunities ──────────────────────────────────────────────

studioRouter.get(
  `${BASE}/workspaces/:id/content-opportunities`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = ContentOpportunitiesQuerySchema.safeParse(req.query);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const opportunities = await opportunityService.getContentOpportunities(
        req.params.id,
        parsed.data
      );
      res.json({ opportunities });
    } catch (err) {
      next(err);
    }
  }
);

// Workspace-scoped — replaces the legacy unscoped variant.
// Service-layer findFirst is keyed on (id, clientId), so an
// id-guess from another workspace returns no opportunities.
studioRouter.get(
  `${BASE}/workspaces/:id/business-data/:itemId/opportunities`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const channel = req.query.channel || undefined;
      const opportunities = await opportunityService.getOpportunitiesForItem(
        req.params.id,
        req.params.itemId,
        { channel }
      );
      res.json({ opportunities });
    } catch (err) {
      next(err);
    }
  }
);

// ── Bulk Generate ──────────────────────────────────────────────────────

studioRouter.post(
  `${BASE}/workspaces/:id/business-data/bulk-generate`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = BulkGenerateSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      // Service health pre-flight
      if (await getServiceStatus("openai") === "down") return sendError(res, 503, "SERVICE_UNAVAILABLE", "Content generation temporarily unavailable. Please try again in a few minutes.");
      const throttle = await getThrottlePolicy();
      if (throttle.adminPaused) return sendError(res, 503, "SERVICE_UNAVAILABLE", "AI generation is temporarily paused by the administrator.");

      // Batch size cap based on throttle policy
      const originalCount = parsed.data.items.length;
      const items = parsed.data.items.slice(0, throttle.maxBatchSize);
      const maxBatchApplied = items.length < originalCount;

      // Global budget check
      if (await isProviderBudgetExceeded("openai")) return sendError(res, 503, "BUDGET_EXCEEDED", "AI text generation is temporarily unavailable due to budget limits. Please try again later.");

      const actorSub = getAuth0Sub(req);
      const results = [];

      for (const item of items) {
        try {
          const allowed = await checkUsageLimit(req.user.id, "posts");
          if (!allowed) {
            results.push({ dataItemId: item.dataItemId, status: "limit_reached" });
            continue;
          }

          const draft = await service.generateDraft({
            clientId: req.params.id,
            kind: "POST",
            channel: item.channel,
            guidance: item.guidance ?? "",
            createdBy: actorSub,
            dataItemId: item.dataItemId,
            blueprintId: item.blueprintId,
            userId: req.user.id,
          });

          await incrementUsage(req.user.id, "posts");
          results.push({ dataItemId: item.dataItemId, status: "success", draftId: draft.id });
        } catch {
          results.push({ dataItemId: item.dataItemId, status: "error" });
        }
      }

      res.status(201).json({
        results,
        generated: results.filter((r) => r.status === "success").length,
        total: results.length,
        ...(maxBatchApplied && { maxBatchApplied: true, originalCount }),
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── Data Performance ─────────────────────────────────────────────────────

studioRouter.get(
  `${BASE}/workspaces/:id/business-data/top-performing`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = DataPerformanceQuerySchema.safeParse(req.query);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const items = await dataAnalyticsService.getTopPerformingDataItems(
        req.params.id,
        parsed.data
      );
      res.json({ items });
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.get(
  `${BASE}/workspaces/:id/business-data/best-blueprints`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = DataPerformanceQuerySchema.safeParse(req.query);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const blueprints = await dataAnalyticsService.getBestBlueprints(
        req.params.id,
        parsed.data
      );
      res.json({ blueprints });
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.get(
  `${BASE}/workspaces/:id/business-data/best-platform/:dataType`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const result = await dataAnalyticsService.getBestPlatformForDataType(
        req.params.id,
        req.params.dataType
      );
      res.json({ bestPlatform: result });
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/workspaces/:id/business-data/recalculate`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const result = await dataAnalyticsService.recalculateAllPerformance(req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── Data Usage & Suggestions ─────────────────────────────────────────

studioRouter.get(
  `${BASE}/workspaces/:id/business-data/unused`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const result = await getUnusedData(req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.get(
  `${BASE}/workspaces/:id/business-data/suggestions`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const client = await prisma.client.findUnique({
        where: { id: req.params.id },
        select: { industryKey: true },
      });
      const result = await getDataSuggestions(req.params.id, {
        industryKey: client?.industryKey ?? undefined,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── Onboarding ──────────────────────────────────────────────────────

// Document upload middleware
const uploadDocs = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 20 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => {
    cb(null, isAcceptedFile(file.mimetype, file.originalname));
  },
}).array("files", 5);

studioRouter.post(`${BASE}/onboarding/upload-documents`, (req, res, next) => {
  uploadDocs(req, res, async (err) => {
    if (err) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return sendError(res, 400, "FILE_TOO_LARGE", "File exceeds 20MB limit");
      }
      if (err.code === "LIMIT_FILE_COUNT") {
        return sendError(res, 400, "TOO_MANY_FILES", "Maximum 5 files allowed");
      }
      return next(err);
    }
    try {
      const files = req.files || [];
      if (files.length === 0) {
        return sendError(res, 400, "NO_FILES", "No files provided");
      }
      const documents = await Promise.all(
        files.map((f) =>
          parseDocument(f.buffer, { filename: f.originalname, mimetype: f.mimetype })
        )
      );
      res.json({ documents });
    } catch (err) {
      if (err.status === 400) {
        return sendError(res, 400, "PARSE_ERROR", err.message);
      }
      next(err);
    }
  });
});

studioRouter.post(`${BASE}/onboarding/analyze`, async (req, res, next) => {
  try {
    const parsed = OnboardingAnalyzeSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);

    const { input, inputType, documentTexts, industryKey } = parsed.data;
    let brandData;
    let dataItems = [];
    let images = [];

    const hasUrl = inputType === "url" && input.length >= 3;
    const hasText = inputType === "text" && input.length >= 3;
    const hasDocs = documentTexts.length > 0;

    // Multi-source: combine crawled pages + documents + text
    if (hasUrl || hasDocs || hasText) {
      const { combinedText, images: crawledImages } = await onboardingService.crawlAndCombine({
        url: hasUrl ? input : null,
        text: hasText ? input : null,
        documentTexts,
      });
      images = crawledImages;

      // Extract sequentially: brand first, then data.
      // Running both in parallel can trigger OpenAI rate limits.
      brandData = await onboardingService.extractBrandData(combinedText, {
        url: hasUrl ? input : undefined,
        industryKey,
      });

      try {
        dataItems = await onboardingService.extractDataItems(combinedText, {
          url: hasUrl ? input : undefined,
          images: crawledImages,
          industryKey,
        });
      } catch (err) {
        console.error("[onboarding] Data extraction failed:", err.message || err);
        dataItems = [];
      }
    } else {
      brandData = await onboardingService.extractBrandFromText(input, { industryKey });
    }

    // Fire-and-forget: track onboarding AI usage
    trackAiUsage({
      userId: req.user.id,
      actionType: "ONBOARDING",
      model: "gpt-4o-mini",
      promptTokens: 0,
      completionTokens: 0,
      metadata: { inputType },
    });

    const starterAngles = getStarterAngles(industryKey) || [];
    const hasImportedData = dataItems && dataItems.length > 0;
    const coreTemplates = getRecommendationTemplates(industryKey)
      .filter((t) => t.tier === "core")
      .sort((a, b) => {
        const aNeeds = a.conditions?.hasData ?? false;
        const bNeeds = b.conditions?.hasData ?? false;
        if (hasImportedData) {
          // Data available — prefer data-dependent templates (richer output)
          return (bNeeds ? 1 : 0) - (aNeeds ? 1 : 0);
        }
        // No data — prefer non-conditional templates first
        return (aNeeds ? 1 : 0) - (bNeeds ? 1 : 0);
      })
      .slice(0, 3)
      .map(({ type, title, guidance, conditions }) => ({ type, title, guidance, conditions }));

    // Compute real estate capabilities summary for Phase B readiness
    let realEstateCapabilities;
    if (industryKey === "real_estate") {
      const liveItems = getIndustryTechStack("real_estate").filter((i) => i.status === "live");
      const capSet = new Set();
      for (const item of liveItems) {
        const mapped = RE_CAPABILITY_MAP[item.providerKey];
        if (mapped) for (const cap of mapped.capabilities) capSet.add(cap);
      }
      realEstateCapabilities = [...capSet];
    }

    res.json({
      brandData: {
        name: brandData.name,
        description: brandData.description,
        industry: brandData.industry,
        audience: brandData.audience,
        offers: brandData.offers,
        competitors: brandData.competitors,
        website: hasUrl ? input : undefined,
      },
      voiceData: {
        tone: brandData.suggestedTone,
        doRules: brandData.voiceRules.do,
        dontRules: brandData.voiceRules.dont,
        contentBuckets: brandData.contentBuckets,
      },
      suggestedGoal: brandData.suggestedGoal,
      suggestedChannels: brandData.suggestedChannels,
      images,
      dataItems,
      starterAngles,
      coreTemplates,
      ...(realEstateCapabilities && { realEstateCapabilities }),
    });
  } catch (err) {
    if (err.status === 400 || err.status === 408 || err.status === 422) {
      return sendError(res, err.status, "ONBOARDING_ERROR", err.message);
    }
    if (err.status === 502) {
      return sendError(res, 502, "SCRAPE_FAILED", err.message);
    }
    if (err.code?.startsWith("OPENAI_")) {
      return sendError(res, 503, "AI_EXTRACTION_FAILED", "AI analysis failed. Please try again.");
    }
    next(err);
  }
});

// ── Agent Onboarding Sources ─────────────────────────────────────────

studioRouter.post(`${BASE}/onboarding/zillow-extract`, async (req, res, next) => {
  try {
    const parsed = ZillowExtractSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);

    const draft = await agentOnboarding.extractFromZillow(parsed.data.url);
    res.json(draft);
  } catch (err) {
    if (err.status === 400) return sendError(res, 400, "EXTRACTION_ERROR", err.message);
    next(err);
  }
});

studioRouter.post(`${BASE}/onboarding/license-lookup`, async (req, res, next) => {
  try {
    const parsed = LicenseLookupSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);

    const draft = await agentOnboarding.extractFromLicense(parsed.data.state, parsed.data.licenseNumber);
    res.json(draft);
  } catch (err) {
    if (err.status === 400) return sendError(res, 400, "LOOKUP_ERROR", err.message);
    next(err);
  }
});

studioRouter.post(`${BASE}/onboarding/crm-analyze`, async (req, res, next) => {
  try {
    const parsed = CrmAnalyzeSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);

    const draft = await agentOnboarding.extractFromCrm(parsed.data.csvText);
    res.json(draft);
  } catch (err) {
    if (err.status === 400) return sendError(res, 400, "CRM_ANALYZE_ERROR", err.message);
    next(err);
  }
});

// ── Onboarding Analyze (SSE streaming) ───────────────────────────────

studioRouter.post(`${BASE}/onboarding/analyze-stream`, async (req, res) => {
  // SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // disable Fly proxy buffering
  res.flushHeaders();

  const sendEvent = (data) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
    if (typeof res.flush === "function") res.flush();
  };

  try {
    const parsed = OnboardingAnalyzeSchema.safeParse(req.body);
    if (!parsed.success) {
      sendEvent({ event: "error", message: "Invalid input" });
      return res.end();
    }

    const { input, inputType, documentTexts = [], industryKey, agentProfileDraft } = parsed.data;
    const hasUrl = inputType === "url" && input.length >= 3;
    const hasText = inputType === "text" && input.length >= 3;
    const hasDocs = documentTexts.length > 0;

    // Convert agent profile draft to context text for AI injection
    const agentContext = agentProfileDraft
      ? agentOnboarding.draftToContextText(agentProfileDraft)
      : undefined;

    let brandData;
    let dataItems = [];
    let images = [];
    let logoUrl = "";

    if (hasUrl || hasDocs || hasText) {
      // Crawl with live progress
      sendEvent({ event: "crawl:start", url: hasUrl ? input : null });

      let combinedText, primaryPageText, crawledImages, crawledLogo;
      try {
        const result = await onboardingService.crawlAndCombine({
          url: hasUrl ? input : null,
          text: hasText ? input : null,
          documentTexts,
          onProgress: (p) => sendEvent(p),
        });
        combinedText = result.combinedText;
        primaryPageText = result.primaryPageText;
        crawledImages = result.images;
        crawledLogo = result.logoUrl;
      } catch (crawlErr) {
        const isBlocked = crawlErr.status === 422 || /block/i.test(crawlErr.message);
        sendEvent({
          event: "error",
          code: isBlocked ? "BLOCKED" : "CRAWL_FAILED",
          message: isBlocked
            ? "This website has anti-bot protection and can't be scraped. Please try a different method below."
            : `Could not access this website: ${crawlErr.message || "connection failed"}. Try a different link or another method.`,
        });
        return res.end();
      }
      const allImages = crawledImages || [];
      logoUrl = crawledLogo || "";
      sendEvent({ event: "crawl:done" });

      // Filter junk images (logos, icons, tiny thumbnails) for the client,
      // but keep the full list for AI data extraction below.
      images = filterPropertyImages([...new Set(allImages)]);
      if (images.length > 0) {
        sendEvent({ event: "images:found", count: images.length });
      }

      // Run brand + data extraction in parallel — they use different
      // content (full combined text vs primary page only) and 2 concurrent
      // OpenAI requests is well within rate limits.
      sendEvent({ event: "extract:start" });

      const extractionText = primaryPageText || combinedText;
      console.log("[onboarding-stream] Data extraction input:", extractionText.length, "chars (primary page:", !!primaryPageText, ")");

      const [brandResult, dataResult] = await Promise.allSettled([
        onboardingService.extractBrandData(combinedText, {
          url: hasUrl ? input : undefined,
          industryKey,
          agentContext,
        }),
        onboardingService.extractDataItems(extractionText, {
          url: hasUrl ? input : undefined,
          images: allImages,
          industryKey,
          onProgress: (items) => {
            sendEvent({ event: "data:progress", items, count: items.length });
          },
        }),
      ]);

      if (brandResult.status === "fulfilled") {
        brandData = brandResult.value;
      } else {
        throw brandResult.reason; // brand is required — let outer catch handle
      }
      sendEvent({ event: "brand:done", brandData, logoUrl });

      if (dataResult.status === "fulfilled") {
        dataItems = dataResult.value;
        console.log("[onboarding-stream] Data extraction result:", dataItems.length, "items", dataItems.map(d => `${d.type}:${d.title}`));
      } else {
        console.error("[onboarding-stream] Data extraction failed:", dataResult.reason?.message || dataResult.reason);
      }
      sendEvent({ event: "data:done", items: dataItems, count: dataItems.length });
    } else {
      sendEvent({ event: "crawl:start", url: null });
      brandData = await onboardingService.extractBrandFromText(input, { industryKey, agentContext });
      sendEvent({ event: "brand:done", brandData });
      sendEvent({ event: "data:done", items: [], count: 0 });
    }

    // Fire-and-forget: track onboarding AI usage
    trackAiUsage({
      userId: req.user.id,
      actionType: "ONBOARDING",
      model: "gpt-4o",
      promptTokens: 0,
      completionTokens: 0,
      metadata: { inputType },
    });

    const starterAngles = getStarterAngles(industryKey) || [];
    const hasImportedData = dataItems && dataItems.length > 0;
    const coreTemplates = getRecommendationTemplates(industryKey)
      .filter((t) => t.tier === "core")
      .sort((a, b) => {
        const aNeeds = a.conditions?.hasData ?? false;
        const bNeeds = b.conditions?.hasData ?? false;
        if (hasImportedData) {
          return (bNeeds ? 1 : 0) - (aNeeds ? 1 : 0);
        }
        return (aNeeds ? 1 : 0) - (bNeeds ? 1 : 0);
      })
      .slice(0, 3)
      .map(({ type, title, guidance, conditions }) => ({ type, title, guidance, conditions }));

    // Compute real estate capabilities summary for Phase B readiness
    let realEstateCapabilities;
    if (industryKey === "real_estate") {
      const liveItems = getIndustryTechStack("real_estate").filter((i) => i.status === "live");
      const capSet = new Set();
      for (const item of liveItems) {
        const mapped = RE_CAPABILITY_MAP[item.providerKey];
        if (mapped) for (const cap of mapped.capabilities) capSet.add(cap);
      }
      realEstateCapabilities = [...capSet];
    }

    // Final complete event with full payload (same shape as the non-stream endpoint)
    sendEvent({
      event: "done",
      brandData: {
        name: brandData.name,
        description: brandData.description,
        industry: brandData.industry,
        audience: brandData.audience,
        offers: brandData.offers,
        competitors: brandData.competitors,
        website: hasUrl ? input : undefined,
        logoUrl: logoUrl || undefined,
      },
      voiceData: {
        tone: brandData.suggestedTone,
        doRules: brandData.voiceRules.do,
        dontRules: brandData.voiceRules.dont,
        contentBuckets: brandData.contentBuckets,
      },
      suggestedGoal: brandData.suggestedGoal,
      suggestedChannels: brandData.suggestedChannels,
      images,
      dataItems,
      starterAngles,
      coreTemplates,
      ...(realEstateCapabilities && { realEstateCapabilities }),
    });
  } catch (err) {
    console.error("[onboarding-stream] Error:", err.message || err);
    sendEvent({ event: "error", message: "Analysis failed. Please try again." });
  }

  res.end();
});

// ── Data Import ──────────────────────────────────────────────────────

studioRouter.post(
  `${BASE}/workspaces/:id/data-import/url`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = ImportFromUrlSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const result = await importService.extractFromUrl(parsed.data.url, { hint: parsed.data.hint });
      res.json(result);
    } catch (err) {
      if (err.status) return sendError(res, err.status, "IMPORT_ERROR", err.message);
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/workspaces/:id/data-import/text`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = ImportFromTextSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const result = await importService.extractFromText(parsed.data.text, { hint: parsed.data.hint });
      res.json(result);
    } catch (err) {
      if (err.status) return sendError(res, err.status, "IMPORT_ERROR", err.message);
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/workspaces/:id/data-import/csv/preview`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = ImportCSVPreviewSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const result = importService.previewCSV(parsed.data.csvContent);
      res.json(result);
    } catch (err) {
      if (err.status) return sendError(res, err.status, "IMPORT_ERROR", err.message);
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/workspaces/:id/data-import/csv/extract`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = ImportCSVExtractSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const result = importService.extractFromCSV(parsed.data.csvContent, {
        columnMapping: parsed.data.columnMapping,
        defaultType: parsed.data.defaultType,
      });
      res.json(result);
    } catch (err) {
      if (err.status) return sendError(res, err.status, "IMPORT_ERROR", err.message);
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/workspaces/:id/data-import/sheets`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = ImportFromSheetsSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const result = await importService.extractFromGoogleSheets(parsed.data.integrationId, {
        spreadsheetId: parsed.data.spreadsheetId,
        sheetName: parsed.data.sheetName,
        hint: parsed.data.hint,
      });
      res.json(result);
    } catch (err) {
      if (err.status) return sendError(res, err.status, "IMPORT_ERROR", err.message);
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/workspaces/:id/data-import/notion`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = ImportFromNotionSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const result = await importService.extractFromNotion(parsed.data.integrationId, {
        hint: parsed.data.hint,
      });
      res.json(result);
    } catch (err) {
      if (err.status) return sendError(res, err.status, "IMPORT_ERROR", err.message);
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/workspaces/:id/data-import/confirm`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = ConfirmImportSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const result = await importService.saveImportedItems(req.params.id, {
        items: parsed.data.items,
        sourceType: parsed.data.sourceType,
        sourceUrl: parsed.data.sourceUrl,
      });
      res.status(201).json(result);
    } catch (err) {
      if (err.status) return sendError(res, err.status, "IMPORT_ERROR", err.message);
      next(err);
    }
  }
);

// ── Dashboard ──────────────────────────────────────────────────────────

studioRouter.get(`${BASE}/workspaces/:id/dashboard/recommendations`, requireClientOwner, async (req, res, next) => {
  try {
    const result = await getDashboardRecommendations(req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

studioRouter.get(`${BASE}/workspaces/:id/dashboard/actions`, requireClientOwner, async (req, res, next) => {
  try {
    const result = await getDashboardActions(req.params.id);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/v1/workspaces/:id/recommendations?surface=dashboard|create_content|listing_campaign
 * Unified recommendation engine endpoint. Returns recommendations in the
 * shared format with actionPayload, reasons, and surface filtering.
 */
studioRouter.get(`${BASE}/workspaces/:id/recommendations`, requireClientOwner, async (req, res, next) => {
  try {
    const surface = req.query.surface || undefined;
    const limit = req.query.limit ? Number(req.query.limit) : 6;
    const validSurfaces = ["dashboard", "create_content", "listing_campaign", "planner"];
    if (surface && !validSurfaces.includes(surface)) {
      return validationError(res, [{ path: ["surface"], message: `Must be one of: ${validSurfaces.join(", ")}` }]);
    }
    const result = await getRecommendations(req.params.id, { surface, limit });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/workspaces/:id/recommendations/:recId/accept
 * Track that a recommendation was acted on. Lightweight Redis tracking.
 */
studioRouter.post(`${BASE}/workspaces/:id/recommendations/:recId/accept`, requireClientOwner, async (req, res, next) => {
  try {
    const { redisSet: rSet, redisGet: rGet } = await import("../../redis.js");
    const trackKey = `sp:rec:accepted:${req.params.id}`;
    let existing = [];
    try {
      const raw = await rGet(trackKey);
      if (raw) existing = JSON.parse(raw);
    } catch { /* ignore */ }
    existing.push({ id: req.params.recId, at: new Date().toISOString() });
    if (existing.length > 50) existing = existing.slice(-50);
    await rSet(trackKey, JSON.stringify(existing), 172800); // 48h
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/v1/workspaces/:id/recommendations/:recId/dismiss
 * Track that a recommendation was dismissed. Redis-backed, 7-day TTL.
 */
studioRouter.post(`${BASE}/workspaces/:id/recommendations/:recId/dismiss`, requireClientOwner, async (req, res, next) => {
  try {
    const { redisSet: rSet, redisGet: rGet } = await import("../../redis.js");
    const trackKey = `sp:rec:dismissed:${req.params.id}`;
    let existing = [];
    try {
      const raw = await rGet(trackKey);
      if (raw) existing = JSON.parse(raw);
    } catch { /* ignore */ }
    existing.push({ id: req.params.recId, at: new Date().toISOString(), reason: req.body?.reason ?? null });
    if (existing.length > 50) existing = existing.slice(-50);
    await rSet(trackKey, JSON.stringify(existing), 604800); // 7 days
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Analytics ───────────────────────────────────────────────────────────

studioRouter.get(`${BASE}/workspaces/:id/analytics`, requireClientOwner, async (req, res, next) => {
  try {
    const analytics = await service.getClientAnalytics(req.params.id);
    res.json(analytics);
  } catch (err) {
    next(err);
  }
});

studioRouter.get(`${BASE}/workspaces/:id/analytics/overview`, requireClientOwner, async (req, res, next) => {
  try {
    const parsed = AnalyticsOverviewQuerySchema.safeParse(req.query);
    if (!parsed.success) return validationError(res, parsed.error);
    const overview = await getAnalyticsOverview({ clientId: req.params.id, range: parsed.data.range });
    res.json(overview);
  } catch (err) {
    next(err);
  }
});

studioRouter.get(`${BASE}/workspaces/:id/analytics/posts/:postId`, requireClientOwner, async (req, res, next) => {
  try {
    const detail = await getPostDetail(req.params.id, req.params.postId);
    if (!detail) return sendError(res, 404, "NOT_FOUND", "Post not found");
    res.json(detail);
  } catch (err) {
    next(err);
  }
});

studioRouter.get(`${BASE}/workspaces/:id/analytics/posts/:postId/history`, requireClientOwner, async (req, res, next) => {
  try {
    const [history, growth] = await Promise.all([
      getPostMetricHistory(req.params.postId),
      getPostMetricGrowth(req.params.postId),
    ]);
    res.json({ history, growth });
  } catch (err) {
    next(err);
  }
});

studioRouter.get(`${BASE}/workspaces/:id/analytics/insights`, requireClientOwner, async (req, res, next) => {
  try {
    const range = req.query.range || '30d';
    const [insights, recResult] = await Promise.all([
      generateInsights({ clientId: req.params.id, range }),
      generateRecommendations({ clientId: req.params.id, range }),
    ]);
    res.json({ insights, recommendations: recResult.recommendations, meta: recResult.meta ?? null });
  } catch (err) {
    next(err);
  }
});

// ── Trackable Links & Conversions ────────────────────────────────────

studioRouter.post(`${BASE}/workspaces/:id/links`, requireClientOwner, async (req, res, next) => {
  try {
    const parsed = CreateTrackableLinkSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const link = await trackableLinkService.createTrackableLink({
      ...parsed.data,
      clientId: req.params.id,
      createdBy: getAuth0Sub(req),
    });
    res.status(201).json(link);
  } catch (err) {
    next(err);
  }
});

studioRouter.get(`${BASE}/workspaces/:id/links`, requireClientOwner, async (req, res, next) => {
  try {
    const links = await trackableLinkService.listTrackableLinks(req.params.id, {
      draftId: req.query.draftId || undefined,
    });
    res.json({ links });
  } catch (err) {
    next(err);
  }
});

studioRouter.delete(`${BASE}/workspaces/:id/links/:linkId`, requireClientOwner, async (req, res, next) => {
  try {
    // Cross-workspace guard: requireClientOwner verified :id is owned,
    // but the link may belong to some other workspace. Scope the delete.
    const result = await trackableLinkService.deleteLinkInClient(
      req.params.linkId,
      req.params.id
    );
    if (!result || result.count === 0) {
      return sendError(res, 404, "NOT_FOUND", "Link not found");
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

studioRouter.post(`${BASE}/workspaces/:id/conversions`, requireClientOwner, async (req, res, next) => {
  try {
    const parsed = LogConversionEventSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error);
    const event = await logConversionEvent({
      ...parsed.data,
      clientId: req.params.id,
    });
    res.status(201).json(event);
  } catch (err) {
    next(err);
  }
});

studioRouter.get(`${BASE}/workspaces/:id/conversions`, requireClientOwner, async (req, res, next) => {
  try {
    const where = { clientId: req.params.id };
    if (req.query.since) where.createdAt = { gte: new Date(req.query.since) };
    const events = await prisma.conversionEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
    });
    res.json({ events });
  } catch (err) {
    next(err);
  }
});

// ── Generation ──────────────────────────────────────────────────────────

studioRouter.post(`${BASE}/generate`, async (req, res, next) => {
  try {
    const parsed = GenerateContentSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);

    // Tenant isolation: every body-supplied resource ID must belong to
    // a workspace the requester owns. We check before doing any
    // expensive AI work so a probe attack returns instantly.
    const ownerCheck = await assertClientOwnedByCurrentUser(parsed.data.clientId, req);
    if (ownerCheck) return sendError(res, ownerCheck.status, ownerCheck.code, ownerCheck.message);
    try {
      await assertDataItemInClient(parsed.data.dataItemId, parsed.data.clientId);
    } catch (e) {
      return sendError(res, e.status ?? 404, e.code ?? "NOT_FOUND", e.message);
    }

    // Service health pre-flight
    if (await getServiceStatus("openai") === "down") return sendError(res, 503, "SERVICE_UNAVAILABLE", "Content generation temporarily unavailable. Please try again in a few minutes.");
    const throttle = await getThrottlePolicy();
    if (throttle.adminPaused) return sendError(res, 503, "SERVICE_UNAVAILABLE", "AI generation is temporarily paused by the administrator.");

    // Global budget check
    if (await isProviderBudgetExceeded("openai")) return sendError(res, 503, "BUDGET_EXCEEDED", "AI text generation is temporarily unavailable due to budget limits. Please try again later.");

    // Idempotency: reject duplicate requests within 10s window
    const dedupKey = await acquireDedup(req.user.id, "generate", parsed.data);
    if (!dedupKey) return sendError(res, 429, "DUPLICATE_REQUEST", "A generation is already in progress. Please wait.");

    // Usage limit check
    const allowed = await checkUsageLimit(req.user.id, "posts");
    if (!allowed) { await releaseDedup(dedupKey); return sendError(res, 402, "USAGE_LIMIT", "You have reached your monthly generation limit. Upgrade your plan for more."); }

    const actorSub = getAuth0Sub(req);
    const { dataItemId, blueprintId, ...genData } = parsed.data;
    req.log?.info({ clientId: parsed.data.clientId, userId: req.user?.id, channel: parsed.data.channel }, "generation_started");
    const draft = await service.generateDraft({
      ...genData,
      createdBy: actorSub,
      dataItemId,
      blueprintId,
      userId: req.user.id,
    });

    await releaseDedup(dedupKey);
    await incrementUsage(req.user.id, "posts");
    req.log?.info({ draftId: draft.id, clientId: parsed.data.clientId, channel: draft.channel }, "generation_succeeded");

    // Fire-and-forget: record activity
    recordActivity({
      userId: req.user.id,
      clientId: parsed.data.clientId,
      eventType: "DRAFT_CREATED",
      payload: { channel: draft.channel, clientId: parsed.data.clientId },
      resourceType: "draft",
      resourceId: draft.id,
    }).catch(() => {});

    // Fire-and-forget: check if usage is nearing limit
    checkUsageNearing(req.user.id, "posts").then((info) => {
      if (info) enqueueNotification({
        userId: req.user.id,
        eventType: "USAGE_LIMIT_NEARING",
        payload: info,
        resourceType: "usage",
        resourceId: `${req.user.id}:posts`,
      });
    }).catch(() => {});

    res.status(201).json(draft);
  } catch (err) {
    req.log?.error({ clientId: parsed.data.clientId, userId: req.user?.id, err: err?.message, code: err?.code }, "generation_failed");
    next(err);
  }
});

// ── Content Remix ────────────────────────────────────────────────────

studioRouter.post(`${BASE}/workspaces/:id/remix`, requireClientOwner, async (req, res, next) => {
  try {
    const { draftId } = req.body;
    if (!draftId || typeof draftId !== "string") return sendError(res, 400, "VALIDATION_ERROR", "draftId is required.");

    // Cross-workspace check: requireClientOwner verified :id, but the
    // body draftId could be smuggled in from another workspace.
    try {
      await assertDraftInClient(draftId, req.params.id);
    } catch (e) {
      return sendError(res, e.status ?? 404, e.code ?? "NOT_FOUND", e.message);
    }

    // Service health pre-flight
    if (await getServiceStatus("openai") === "down") return sendError(res, 503, "SERVICE_UNAVAILABLE", "Content generation temporarily unavailable. Please try again in a few minutes.");
    const throttle = await getThrottlePolicy();
    if (throttle.adminPaused) return sendError(res, 503, "SERVICE_UNAVAILABLE", "AI generation is temporarily paused by the administrator.");
    if (await isProviderBudgetExceeded("openai")) return sendError(res, 503, "BUDGET_EXCEEDED", "AI text generation is temporarily unavailable due to budget limits. Please try again later.");

    const dedupKey = await acquireDedup(req.user.id, "remix", { draftId });
    if (!dedupKey) return sendError(res, 429, "DUPLICATE_REQUEST", "A remix is already in progress. Please wait.");

    const allowed = await checkUsageLimit(req.user.id, "posts");
    if (!allowed) { await releaseDedup(dedupKey); return sendError(res, 402, "USAGE_LIMIT", "You have reached your monthly generation limit."); }

    const actorSub = getAuth0Sub(req);
    const drafts = await service.remixDraft({
      clientId: req.params.id,
      draftId,
      createdBy: actorSub,
      userId: req.user.id,
    });

    await releaseDedup(dedupKey);
    await incrementUsage(req.user.id, "posts");

    recordActivity({
      userId: req.user.id,
      clientId: req.params.id,
      eventType: "CONTENT_REMIXED",
      payload: { draftId, formats: drafts.length },
      resourceType: "draft",
      resourceId: draftId,
    }).catch(() => {});

    res.status(201).json({ drafts });
  } catch (err) {
    next(err);
  }
});

// ── Post Timing ──────────────────────────────────────────────────────

studioRouter.get(`${BASE}/timing-suggestions`, (req, res) => {
  res.json(getAllTimingSuggestions());
});

// ── Series Builder ───────────────────────────────────────────────────

studioRouter.get(`${BASE}/series-templates`, (req, res) => {
  res.json({ templates: service.SERIES_TEMPLATES.map((t) => ({
    id: t.id,
    name: t.name,
    description: t.description,
    defaultParts: t.defaultParts,
    maxParts: t.maxParts,
  }))});
});

studioRouter.post(
  `${BASE}/workspaces/:id/series`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = GenerateSeriesSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      // Service health pre-flight
      if (await getServiceStatus("openai") === "down") return sendError(res, 503, "SERVICE_UNAVAILABLE", "Content generation temporarily unavailable.");
      if (await isProviderBudgetExceeded("openai")) return sendError(res, 503, "BUDGET_EXCEEDED", "AI generation temporarily unavailable due to budget limits.");

      const dedupKey = await acquireDedup(req.user.id, "series", parsed.data);
      if (!dedupKey) return sendError(res, 429, "DUPLICATE_REQUEST", "A series is already being generated. Please wait.");

      const allowed = await checkUsageLimit(req.user.id, "posts");
      if (!allowed) return sendError(res, 403, "USAGE_LIMIT", "Post limit reached for this billing period.");

      const actorSub = getAuth0Sub(req);
      const result = await service.generateSeries(req.params.id, actorSub, {
        ...parsed.data,
        userId: req.user.id,
      });

      await releaseDedup(dedupKey);

      // Track usage for each generated draft
      const successCount = result.drafts.filter((d) => d.status !== "FAILED").length;
      if (successCount > 0) {
        incrementUsage(req.user.id, "posts", successCount).catch(() => {});
      }

      recordActivity({
        userId: req.user.id,
        clientId: req.params.id,
        eventType: "SERIES_GENERATED",
        title: `Generated series: ${result.seriesName}`,
        description: `${result.totalParts} parts created`,
        icon: "layers",
        resourceType: "series",
        resourceId: result.seriesId,
      }).catch(() => {});

      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── Performance Feedback ──────────────────────────────────────────────

studioRouter.post(
  `${BASE}/workspaces/:id/drafts/:draftId/rate`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = RatePerformanceSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      // requireClientOwner only verifies :id. The :draftId path param
      // could point at a draft in some other workspace.
      try {
        await assertDraftInClient(req.params.draftId, req.params.id);
      } catch (e) {
        return sendError(res, e.status ?? 404, e.code ?? "NOT_FOUND", e.message);
      }

      const draft = await service.ratePerformance(req.params.draftId, {
        rating: parsed.data.rating,
      });
      res.json(service.formatDraft(draft));
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.get(
  `${BASE}/workspaces/:id/performance/insights`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const result = await service.getPerformanceInsights(req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.get(
  `${BASE}/workspaces/:id/performance/profile`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const profile = await service.getPerformanceProfile(req.params.id);
      res.json(profile);
    } catch (err) {
      next(err);
    }
  }
);

// ── Content Ideas ──────────────────────────────────────────────────────

studioRouter.post(`${BASE}/workspaces/:id/ideas`, requireClientOwner, async (req, res, next) => {
  try {
    // Service health pre-flight
    if (await getServiceStatus("openai") === "down") return sendError(res, 503, "SERVICE_UNAVAILABLE", "Content generation temporarily unavailable. Please try again in a few minutes.");
    { const throttle = await getThrottlePolicy(); if (throttle.adminPaused) return sendError(res, 503, "SERVICE_UNAVAILABLE", "AI generation is temporarily paused by the administrator."); }

    // Global budget check
    if (await isProviderBudgetExceeded("openai")) return sendError(res, 503, "BUDGET_EXCEEDED", "AI text generation is temporarily unavailable due to budget limits. Please try again later.");

    const dedupKey = await acquireDedup(req.user.id, "ideas", { clientId: req.params.id });
    if (!dedupKey) return sendError(res, 429, "DUPLICATE_REQUEST", "Idea generation is already in progress. Please wait.");

    const ideas = await service.generateContentIdeas(req.params.id, { userId: req.user.id });
    await releaseDedup(dedupKey);
    res.json({ ideas });
  } catch (err) {
    next(err);
  }
});

// ── Batch-complete notification ──────────────────────────────────────────

studioRouter.post(`${BASE}/workspaces/:id/batch-complete`, requireClientOwner, async (req, res, next) => {
  try {
    const count = parseInt(req.body.count) || 0;
    if (count > 0) {
      enqueueNotification({
        userId: req.user.id,
        eventType: "BATCH_COMPLETE",
        payload: { count, clientId: req.params.id },
        resourceType: "client",
        resourceId: req.params.id,
      }).catch(() => {});
    }
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Autopilot ──────────────────────────────────────────────────────────

studioRouter.post(
  `${BASE}/workspaces/:id/autopilot/preview`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = AutopilotPreviewSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const result = await previewAutopilot(req.params.id, parsed.data);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/workspaces/:id/autopilot/execute`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = AutopilotExecuteSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      // Service health pre-flight
      if (await getServiceStatus("openai") === "down") return sendError(res, 503, "SERVICE_UNAVAILABLE", "Content generation temporarily unavailable. Please try again in a few minutes.");
      { const throttle = await getThrottlePolicy(); if (throttle.adminPaused) return sendError(res, 503, "SERVICE_UNAVAILABLE", "AI generation is temporarily paused by the administrator."); }

      // Global budget check
      if (await isProviderBudgetExceeded("openai")) return sendError(res, 503, "BUDGET_EXCEEDED", "AI text generation is temporarily unavailable due to budget limits. Please try again later.");

      const actorSub = getAuth0Sub(req);
      const result = await executeAutopilot(req.params.id, actorSub, {
        suggestions: parsed.data.suggestions,
        channel: parsed.data.channel,
        autoSchedule: parsed.data.autoSchedule,
        generateDraft: service.generateDraft,
        scheduleDraft: service.scheduleDraft,
        checkUsageLimit,
        incrementUsage,
        userId: req.user.id,
      });

      // Fire-and-forget: notification + activity
      if (result.generated > 0) {
        enqueueNotification({
          userId: req.user.id,
          eventType: "BATCH_COMPLETE",
          payload: { count: result.generated, clientId: req.params.id, source: "autopilot" },
          resourceType: "client",
          resourceId: req.params.id,
        }).catch(() => {});

        recordActivity({
          userId: req.user.id,
          clientId: req.params.id,
          eventType: "AUTOPILOT_EXECUTED",
          payload: {
            generated: result.generated,
            scheduled: result.scheduled,
            clientId: req.params.id,
          },
          resourceType: "client",
          resourceId: req.params.id,
        }).catch(() => {});
      }

      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── Drafts ──────────────────────────────────────────────────────────────

studioRouter.get(`${BASE}/drafts`, async (req, res, next) => {
  try {
    const parsed = ListDraftsQuerySchema.safeParse(req.query);
    if (!parsed.success) return validationError(res, parsed.error.issues);

    // Tenant isolation: only return drafts whose parent Client is owned
    // by the authenticated user. If a clientId filter was supplied,
    // verify the requester owns it; otherwise, scope the query to all
    // clients owned by the requester.
    const actorSub = getAuth0Sub(req);
    if (parsed.data.clientId) {
      const owner = await prisma.client.findUnique({
        where: { id: parsed.data.clientId },
        select: { createdBy: true },
      });
      if (!owner || owner.createdBy !== actorSub) {
        return sendError(res, 404, "NOT_FOUND", "Client not found");
      }
    } else {
      const owned = await prisma.client.findMany({
        where: { createdBy: actorSub },
        select: { id: true },
      });
      // No clients → empty list. Don't query drafts at all.
      if (owned.length === 0) {
        return res.json({ drafts: [] });
      }
      // Pass the explicit owned-id list down to the service. If the
      // service supports `clientIds`, prefer that; else pass each
      // request through and post-filter as a defensive measure.
      parsed.data.clientIds = owned.map((c) => c.id);
    }

    const drafts = await service.listDrafts(parsed.data);
    res.json({ drafts: drafts.map(service.formatDraft) });
  } catch (err) {
    next(err);
  }
});

studioRouter.get(`${BASE}/drafts/:id`, requireDraftOwner, async (req, res, next) => {
  try {
    const draft = await service.getDraft(req.params.id);
    if (!draft) return sendError(res, 404, "NOT_FOUND", "Draft not found");
    res.json(service.formatDraft(draft));
  } catch (err) {
    next(err);
  }
});

studioRouter.patch(`${BASE}/drafts/:id`, requireDraftOwner, async (req, res, next) => {
  try {
    const parsed = UpdateDraftSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    const draft = await service.updateDraft(req.params.id, parsed.data);
    res.json(service.formatDraft(draft));
  } catch (err) {
    next(err);
  }
});

studioRouter.delete(`${BASE}/drafts/:id`, requireDraftOwner, async (req, res, next) => {
  try {
    await service.deleteDraft(req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

studioRouter.delete(
  `${BASE}/workspaces/:id/drafts`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const result = await service.deleteDraftsByClient(req.params.id);
      res.json({ ok: true, deleted: result.count });
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.post(`${BASE}/drafts/:id/duplicate`, requireDraftOwner, async (req, res, next) => {
  try {
    const actorSub = getAuth0Sub(req);
    const draft = await service.duplicateDraft(req.params.id, actorSub);
    res.json(service.formatDraft(draft));
  } catch (err) {
    next(err);
  }
});

studioRouter.post(`${BASE}/drafts/:id/approve`, requireDraftOwner, async (req, res, next) => {
  try {
    const actorSub = getAuth0Sub(req);
    const draft = await service.approveDraft(req.params.id, actorSub);

    recordActivity({
      userId: req.user.id,
      clientId: draft.clientId,
      eventType: "DRAFT_APPROVED",
      payload: { channel: draft.channel, clientId: draft.clientId },
      resourceType: "draft",
      resourceId: draft.id,
    }).catch(() => {});

    // Check if approved draft has persona-generated media
    const linkedAssets = await prisma.draftAsset.findMany({
      where: { draftId: req.params.id },
      include: { asset: { select: { personaSnapshot: true } } },
    });
    const personaAsset = linkedAssets.find(da => da.asset?.personaSnapshot);
    if (personaAsset) {
      recordActivity({
        userId: req.user.id,
        clientId: draft.clientId,
        eventType: "PERSONA_IMAGE_APPROVED",
        payload: { personaSnapshot: personaAsset.asset.personaSnapshot, postId: req.params.id, clientId: draft.clientId },
        resourceType: "draft",
        resourceId: req.params.id,
      }).catch(() => {});
    }

    res.json(service.formatDraft(draft));
  } catch (err) {
    next(err);
  }
});

studioRouter.post(`${BASE}/drafts/:id/reject`, requireDraftOwner, async (req, res, next) => {
  try {
    const parsed = RejectDraftSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    const actorSub = getAuth0Sub(req);
    const draft = await service.rejectDraft(
      req.params.id,
      parsed.data.reason,
      actorSub
    );

    recordActivity({
      userId: req.user.id,
      clientId: draft.clientId,
      eventType: "DRAFT_REJECTED",
      payload: { channel: draft.channel, reason: parsed.data.reason, clientId: draft.clientId },
      resourceType: "draft",
      resourceId: draft.id,
    }).catch(() => {});

    res.json(service.formatDraft(draft));
  } catch (err) {
    next(err);
  }
});

studioRouter.post(`${BASE}/drafts/:id/schedule`, requireDraftOwner, async (req, res, next) => {
  try {
    const parsed = ScheduleDraftSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);

    // Pre-validate: ensure the draft's channel has an active connection
    const draftRecord = await prisma.draft.findUnique({
      where: { id: req.params.id },
      select: { channel: true, clientId: true, mediaUrl: true, mediaType: true },
    });
    if (draftRecord) {
      const conn = await prisma.channelConnection.findUnique({
        where: { clientId_channel: { clientId: draftRecord.clientId, channel: draftRecord.channel } },
      });
      if (!conn || conn.status !== 'CONNECTED') {
        return sendError(
          res,
          422,
          'SCHEDULE_NO_CONNECTION',
          `Cannot schedule: your ${draftRecord.channel} account is not connected. Please connect it in Settings → Channels before scheduling.`
        );
      }

      // Pre-validate media requirements
      const mediaValidation = validateDraftMedia(draftRecord);
      if (mediaValidation.errors.length > 0) {
        return sendError(
          res,
          422,
          'MEDIA_VALIDATION_FAILED',
          mediaValidation.errors.join("; ")
        );
      }
    }

    const actorSub = getAuth0Sub(req);
    req.log?.info({ draftId: req.params.id, channel: draftRecord?.channel, clientId: draftRecord?.clientId, scheduledFor: parsed.data.scheduledFor }, "schedule_started");
    const draft = await service.scheduleDraft(
      req.params.id,
      parsed.data.scheduledFor,
      actorSub
    );

    req.log?.info({ draftId: req.params.id, channel: draft.channel, clientId: draft.clientId, scheduledFor: parsed.data.scheduledFor }, "schedule_succeeded");

    recordActivity({
      userId: req.user.id,
      clientId: draft.clientId,
      eventType: "DRAFT_SCHEDULED",
      payload: { channel: draft.channel, scheduledFor: parsed.data.scheduledFor, clientId: draft.clientId },
      resourceType: "draft",
      resourceId: draft.id,
    }).catch(() => {});

    res.json(service.formatDraft(draft));
  } catch (err) {
    req.log?.error({ draftId: req.params.id, err: err?.message, code: err?.code }, "schedule_failed");
    next(err);
  }
});

// Auto-schedule: distribute drafts across upcoming days at 9/12/15/18
// LOCAL time in the workspace's `Client.timezone`. Falls back to a safe
// default if the timezone is missing or invalid (logged so we can spot
// it). Never produces a past `scheduledFor`.
studioRouter.post(`${BASE}/workspaces/:id/auto-schedule`, requireClientOwner, async (req, res, next) => {
  try {
    const { draftIds } = req.body;
    if (!Array.isArray(draftIds) || draftIds.length === 0) {
      return sendError(res, 400, "VALIDATION", "draftIds array is required");
    }
    const actorSub = getAuth0Sub(req);

    const client = await prisma.client.findUnique({
      where: { id: req.params.id },
      select: { timezone: true },
    });
    const { timezone, fellBack } = resolveClientTimezone(client?.timezone);
    if (fellBack) {
      req.log?.warn(
        { clientId: req.params.id, raw: client?.timezone, fallback: timezone },
        "auto_schedule_timezone_fallback"
      );
    }

    // Tenant isolation: filter draftIds down to those that actually
    // belong to :id. requireClientOwner verified the workspace, but the
    // body draftIds[] could include drafts from other workspaces.
    // We deliberately do NOT distinguish "wrong workspace" from
    // "doesn't exist" in the response — exposing that would let an
    // attacker probe ownership by ID. The internal log line records
    // the count so on-call can investigate without leaking to clients.
    const ownedDrafts = await prisma.draft.findMany({
      where: { id: { in: draftIds }, clientId: req.params.id },
      select: { id: true },
    });
    const ownedIdSet = new Set(ownedDrafts.map((d) => d.id));
    const ownedIds = draftIds.filter((id) => ownedIdSet.has(id));

    const slots = computeAutoScheduleSlots({
      count: ownedIds.length,
      timeZone: timezone,
    });
    const scheduled = [];

    for (let i = 0; i < ownedIds.length; i++) {
      try {
        const draft = await service.scheduleDraft(ownedIds[i], slots[i].toISOString(), actorSub);
        scheduled.push(service.formatDraft(draft));
      } catch {
        // Drafts that exist in this workspace but can't be scheduled
        // (e.g. wrong status, already published) — counted as state-
        // rejected by the classifier below.
      }
    }

    const breakdown = classifyAutoScheduleResult({
      submittedIds: draftIds,
      ownedIdSet,
      scheduledCount: scheduled.length,
    });

    if (breakdown.rejectedCount > 0) {
      req.log?.warn(
        {
          clientId: req.params.id,
          submitted: draftIds.length,
          scheduledCount: scheduled.length,
          rejectedCount: breakdown.rejectedCount,
          ownershipRejected: breakdown.ownershipRejected,
          stateRejected: breakdown.stateRejected,
        },
        "auto_schedule_rejected_drafts"
      );
    }

    res.json({
      scheduled,
      scheduledCount: scheduled.length,
      rejectedCount: breakdown.rejectedCount,
      rejectedReason: breakdown.rejectedReason,
      timezone,
      // Legacy field — kept so existing clients keep rendering.
      count: scheduled.length,
    });
  } catch (err) {
    next(err);
  }
});

studioRouter.post(`${BASE}/drafts/:id/publish`, requireDraftOwner, async (req, res, next) => {
  // Hoisted so the catch block at the bottom of the handler can log
  // channel/clientId. Without this, a publish failure throws before
  // the inner const is hit, and the catch's reference becomes a
  // ReferenceError that masks the real provider error with a 500.
  let draftRecord = null;
  try {
    // Usage limit check
    const allowed = await checkUsageLimit(req.user.id, "posts");
    if (!allowed) return sendError(res, 402, "USAGE_LIMIT", "You have reached your monthly publish limit. Upgrade your plan for more.");

    // Pre-validate: ensure the draft's channel has an active connection
    draftRecord = await prisma.draft.findUnique({
      where: { id: req.params.id },
      select: { channel: true, clientId: true, mediaUrl: true, mediaType: true },
    });
    if (draftRecord) {
      const conn = await prisma.channelConnection.findUnique({
        where: { clientId_channel: { clientId: draftRecord.clientId, channel: draftRecord.channel } },
      });
      if (!conn || conn.status !== 'CONNECTED') {
        return sendError(
          res,
          422,
          'PUBLISH_NO_CONNECTION',
          `Cannot publish: your ${draftRecord.channel} account is not connected. Please connect it in Settings → Channels before publishing.`
        );
      }

      // Pre-validate media requirements
      const mediaValidation = validateDraftMedia(draftRecord);
      if (mediaValidation.errors.length > 0) {
        return sendError(
          res,
          422,
          'MEDIA_VALIDATION_FAILED',
          mediaValidation.errors.join("; ")
        );
      }
    }

    const actorSub = getAuth0Sub(req);
    req.log?.info({ draftId: req.params.id, channel: draftRecord?.channel, clientId: draftRecord?.clientId, userId: req.user?.id }, "publish_started");
    const draft = await service.publishDraft({
      draftId: req.params.id,
      actorSub,
      source: "manual",
    });

    await incrementUsage(req.user.id, "posts");
    req.log?.info({ draftId: req.params.id, channel: draftRecord?.channel, clientId: draftRecord?.clientId }, "publish_succeeded");

    checkUsageNearing(req.user.id, "posts").then((info) => {
      if (info) {
        req.log?.info({ userId: req.user.id, metric: info.metric, used: info.used, limit: info.limit, status: info.status }, "billing_limit_nearing");
        enqueueNotification({
          userId: req.user.id,
          eventType: "USAGE_LIMIT_NEARING",
          payload: info,
          resourceType: "usage",
          resourceId: `${req.user.id}:posts`,
        });
      }
    }).catch(() => {});

    res.json(draft);
  } catch (err) {
    req.log?.error({ draftId: req.params.id, channel: draftRecord?.channel, clientId: draftRecord?.clientId, err: err?.message, code: err?.code }, "publish_failed");
    next(err);
  }
});

// ── Inline AI Actions ───────────────────────────────────────────────────

studioRouter.post(`${BASE}/drafts/:id/inline-action`, requireDraftOwner, async (req, res, next) => {
  try {
    const parsed = InlineActionSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);

    if (await getServiceStatus("openai") === "down") {
      return sendError(res, 503, "SERVICE_UNAVAILABLE", "AI temporarily unavailable.");
    }
    if (await isProviderBudgetExceeded("openai")) {
      return sendError(res, 503, "BUDGET_EXCEEDED", "AI budget limit reached.");
    }

    const dedupKey = await acquireDedup(req.user.id, "inline_action", { draftId: req.params.id, ...parsed.data });
    if (!dedupKey) return sendError(res, 429, "DUPLICATE_REQUEST", "Action already in progress.");

    const allowed = await checkUsageLimit(req.user.id, "posts");
    if (!allowed) {
      await releaseDedup(dedupKey);
      return sendError(res, 402, "USAGE_LIMIT", "Monthly limit reached.");
    }

    const { executeInlineAction } = await import("./inlineAction.service.js");
    const result = await executeInlineAction({
      draftId: req.params.id,
      actionType: parsed.data.actionType,
      params: parsed.data.params || {},
      userId: getAuth0Sub(req),
    });

    await releaseDedup(dedupKey);
    if (parsed.data.actionType === "generate_variations") {
      await incrementUsage(req.user.id, "posts");
    }

    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ── Media assets ───────────────────────────────────────────────────────

studioRouter.get(
  `${BASE}/workspaces/:id/assets`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = ListAssetsQuerySchema.safeParse({
        ...req.query,
        clientId: req.params.id,
      });
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const limit = parsed.data.limit ?? 50;
      const assets = await service.listAssets(parsed.data);
      const formatted = assets.map(service.formatAsset);
      const hasMore = assets.length === limit;
      const nextCursor = assets.length > 0 ? assets[assets.length - 1].id : null;
      res.json({ assets: formatted, hasMore, nextCursor });
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.get(`${BASE}/assets/:assetId`, requireAssetOwner, async (req, res, next) => {
  try {
    const asset = await service.getAsset(req.params.assetId);
    if (!asset) return sendError(res, 404, "NOT_FOUND", "Asset not found");
    res.json(service.formatAsset(asset));
  } catch (err) {
    next(err);
  }
});

studioRouter.post(
  `${BASE}/workspaces/:id/assets/upload`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      let buffer;
      if (Buffer.isBuffer(req.body)) {
        buffer = req.body;
      } else {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        buffer = Buffer.concat(chunks);
      }

      if (buffer.length === 0) {
        return sendError(res, 400, "NO_FILE", "Request body is empty");
      }

      const actorSub = getAuth0Sub(req);

      // MIME safety: sniff the actual bytes — never trust the request's
      // Content-Type header (it's caller-controlled). We only accept the
      // formats our publishing channels support.
      const sniffedImage = sniffImageMime(buffer);
      const sniffedVideo = sniffVideoMime(buffer);
      if (!sniffedImage && !sniffedVideo) {
        return sendError(
          res,
          415,
          "UNSUPPORTED_MEDIA_TYPE",
          "Unsupported file type. Allowed: JPEG, PNG, WebP, GIF, MP4, MOV, WebM."
        );
      }
      const isVideo = Boolean(sniffedVideo);
      const contentType = sniffedImage ?? sniffedVideo;

      // Tenant isolation for cross-resource ids on the query string.
      // requireClientOwner has already verified :id, so we only need
      // to confirm any provided draftId/folderId live in that same
      // workspace before letting the service touch them.
      try {
        await assertDraftInClient(req.query.draftId ?? null, req.params.id);
        await assertFolderInClient(req.query.folderId ?? null, req.params.id);
      } catch (e) {
        return sendError(res, e.status ?? 404, e.code ?? "NOT_FOUND", e.message);
      }

      // Usage + storage limit checks (skip quota for onboarding uploads)
      const isOnboarding = req.query.onboarding === "true";
      const usageField = isVideo ? "videos" : "images";
      if (!isOnboarding) {
        const quotaErr = await enforceUsageLimit(req.user.id, usageField);
        if (quotaErr) return sendError(res, 402, quotaErr.code, `Monthly ${usageField} upload limit reached. Upgrade your plan for more.`, quotaErr);
      }
      const storageOk = await checkStorageLimit(req.user.id, buffer.length, isVideo);
      if (!storageOk.allowed) return sendError(res, 402, "STORAGE_LIMIT", storageOk.reason, { current: storageOk.current, limit: storageOk.limit });

      let asset;
      if (isVideo) {
        asset = await service.uploadVideoAsset({
          clientId: req.params.id,
          buffer,
          mimeType: contentType,
          filename: req.query.filename ?? null,
          altText: req.query.altText ?? null,
          caption: req.query.caption ?? null,
          draftId: req.query.draftId ?? null,
          createdBy: actorSub,
        });
      } else {
        asset = await service.uploadAsset({
          clientId: req.params.id,
          buffer,
          filename: req.query.filename ?? null,
          altText: req.query.altText ?? null,
          caption: req.query.caption ?? null,
          draftId: req.query.draftId ?? null,
          folderId: req.query.folderId ?? null,
          createdBy: actorSub,
        });
      }
      await incrementUsage(req.user.id, usageField);
      res.status(201).json(service.formatAsset(asset));
    } catch (err) {
      next(err);
    }
  }
);

// Upload asset from external URL — fetches the image and rehosts on Cloudinary.
studioRouter.post(
  `${BASE}/workspaces/:id/assets/upload-from-url`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = UploadFromUrlSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      const { url, folderId, filename, onboarding } = parsed.data;
      const clientId = req.params.id;
      const actorSub = getAuth0Sub(req);

      // Cross-workspace folder check — folderId in body must live in
      // the workspace whose ownership requireClientOwner just verified.
      try {
        await assertFolderInClient(folderId ?? null, clientId);
      } catch (e) {
        return sendError(res, e.status ?? 404, e.code ?? "NOT_FOUND", e.message);
      }

      // Fetch the image with timeout and size limits
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      let resp;
      try {
        // Extract origin for Referer — many CDNs require it
        let referer = "";
        try { referer = new URL(url).origin + "/"; } catch {}
        resp = await fetch(url, {
          signal: controller.signal,
          redirect: "follow",
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
            Accept: "image/*,*/*",
            ...(referer && { Referer: referer }),
          },
        });
      } finally {
        clearTimeout(timeout);
      }
      if (!resp.ok) {
        return sendError(res, 400, "FETCH_FAILED", `Failed to fetch image (${resp.status})`);
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      if (buffer.length > 10 * 1024 * 1024) {
        return sendError(res, 400, "TOO_LARGE", "Image exceeds 10 MB limit");
      }

      // Verify it's actually an image by sniffing magic bytes — the
      // Content-Type from a remote CDN can lie. We only accept the
      // image formats our publishing channels support.
      const sniffed = sniffImageMime(buffer);
      if (!sniffed) {
        return sendError(
          res,
          415,
          "UNSUPPORTED_MEDIA_TYPE",
          "URL did not return a supported image (JPEG, PNG, WebP, GIF)."
        );
      }

      // Usage + storage limit checks (skip quota for onboarding imports)
      if (!onboarding) {
        const imgQuotaErr = await enforceUsageLimit(req.user.id, "images");
        if (imgQuotaErr) return sendError(res, 402, imgQuotaErr.code, "Monthly image upload limit reached. Upgrade your plan for more.", imgQuotaErr);
      }
      const storageOk = await checkStorageLimit(req.user.id, buffer.length, false);
      if (!storageOk.allowed) return sendError(res, 402, "STORAGE_LIMIT", storageOk.reason, { current: storageOk.current, limit: storageOk.limit });

      const asset = await service.uploadAsset({
        clientId,
        buffer,
        filename: filename || null,
        altText: null,
        caption: null,
        draftId: null,
        folderId: folderId || null,
        createdBy: actorSub,
        source: "IMPORTED",
      });
      await incrementUsage(req.user.id, "images");
      res.status(201).json(service.formatAsset(asset));
    } catch (err) {
      if (err.name === "AbortError") {
        return sendError(res, 400, "TIMEOUT", "Image fetch timed out");
      }
      next(err);
    }
  }
);

studioRouter.delete(
  `${BASE}/assets/:assetId`,
  requireAssetOwner,
  async (req, res, next) => {
    try {
      const asset = await service.deleteAsset(req.params.assetId);
      if (!asset) return sendError(res, 404, "NOT_FOUND", "Asset not found");
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// ── Asset folders ─────────────────────────────────────────────────────

studioRouter.get(
  `${BASE}/workspaces/:id/folders`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const folders = await service.listFolders(req.params.id);
      res.json({
        folders: folders.map((f) => ({
          id: f.id,
          clientId: f.clientId,
          name: f.name,
          assetCount: f._count.assets,
          createdAt: f.createdAt,
          updatedAt: f.updatedAt,
        })),
      });
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/workspaces/:id/folders`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const { name } = req.body;
      if (!name || typeof name !== "string" || !name.trim()) {
        return validationError(res, [{ path: ["name"], message: "Folder name is required" }]);
      }
      const trimmed = name.trim();
      // Idempotent create: if a folder with this name already exists in
      // the workspace, return it with 200 instead of 409. Eliminates the
      // cross-tab / cache-stale race the campaign builder hits when it
      // optimistically tries to create a per-listing folder.
      const existing = await prisma.assetFolder.findFirst({
        where: { clientId: req.params.id, name: trimmed },
        include: { _count: { select: { assets: true } } },
      });
      if (existing) {
        return res.status(200).json({
          id: existing.id,
          clientId: existing.clientId,
          name: existing.name,
          assetCount: existing._count.assets,
          createdAt: existing.createdAt,
          updatedAt: existing.updatedAt,
        });
      }
      const folder = await service.createFolder({ clientId: req.params.id, name: trimmed });
      res.status(201).json({
        id: folder.id,
        clientId: folder.clientId,
        name: folder.name,
        assetCount: folder._count.assets,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
      });
    } catch (err) {
      // Even with the pre-check above, a concurrent insert can still
      // race past it and trip the unique index. Treat that as the same
      // "already exists" case rather than surfacing a 409 — re-fetch
      // and return the winner.
      if (err?.code === "P2002") {
        const winner = await prisma.assetFolder.findFirst({
          where: { clientId: req.params.id, name: req.body?.name?.trim?.() ?? "" },
          include: { _count: { select: { assets: true } } },
        });
        if (winner) {
          return res.status(200).json({
            id: winner.id,
            clientId: winner.clientId,
            name: winner.name,
            assetCount: winner._count.assets,
            createdAt: winner.createdAt,
            updatedAt: winner.updatedAt,
          });
        }
        return sendError(res, 409, "DUPLICATE_FOLDER", "A folder with that name already exists");
      }
      next(err);
    }
  }
);

studioRouter.patch(
  `${BASE}/workspaces/:id/folders/:folderId`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const { name } = req.body;
      if (!name || typeof name !== "string" || !name.trim()) {
        return validationError(res, [{ path: ["name"], message: "Folder name is required" }]);
      }
      // requireClientOwner only proves the workspace is owned. Confirm
      // the folder actually lives inside that workspace, otherwise
      // user A could rename user B's folder by smuggling B's folderId
      // through their own workspace's :id.
      try {
        await assertFolderInClient(req.params.folderId, req.params.id);
      } catch (e) {
        return sendError(res, e.status ?? 404, e.code ?? "NOT_FOUND", e.message);
      }
      const folder = await service.renameFolder(req.params.folderId, name);
      res.json({
        id: folder.id,
        clientId: folder.clientId,
        name: folder.name,
        assetCount: folder._count.assets,
        createdAt: folder.createdAt,
        updatedAt: folder.updatedAt,
      });
    } catch (err) {
      if (err?.code === "P2002") {
        return sendError(res, 409, "DUPLICATE_FOLDER", "A folder with that name already exists");
      }
      if (err?.code === "P2025") {
        return sendError(res, 404, "NOT_FOUND", "Folder not found");
      }
      next(err);
    }
  }
);

studioRouter.delete(
  `${BASE}/workspaces/:id/folders/:folderId`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      try {
        await assertFolderInClient(req.params.folderId, req.params.id);
      } catch (e) {
        return sendError(res, e.status ?? 404, e.code ?? "NOT_FOUND", e.message);
      }
      await service.deleteFolder(req.params.folderId);
      res.json({ ok: true });
    } catch (err) {
      if (err?.code === "P2025") {
        return sendError(res, 404, "NOT_FOUND", "Folder not found");
      }
      next(err);
    }
  }
);

// ── Asset folder / tag operations ─────────────────────────────────────

studioRouter.patch(
  `${BASE}/assets/:assetId/folder`,
  requireAssetOwner,
  async (req, res, next) => {
    try {
      const { folderId } = req.body;
      // requireAssetOwner attached req.asset = { id, clientId }. If a
      // target folderId is provided, it must live in the same workspace
      // as the asset — otherwise a user could move an owned asset into
      // some other workspace's folder.
      if (folderId) {
        try {
          await assertFolderInClient(folderId, req.asset.clientId);
        } catch (e) {
          return sendError(res, e.status ?? 404, e.code ?? "NOT_FOUND", e.message);
        }
      }
      const asset = await service.moveAssetToFolder(req.params.assetId, folderId ?? null);
      res.json(service.formatAsset(asset));
    } catch (err) {
      if (err?.code === "P2025") {
        return sendError(res, 404, "NOT_FOUND", "Asset not found");
      }
      next(err);
    }
  }
);

studioRouter.patch(
  `${BASE}/assets/:assetId/tags`,
  requireAssetOwner,
  async (req, res, next) => {
    try {
      const { tags } = req.body;
      if (!Array.isArray(tags)) {
        return validationError(res, [{ path: ["tags"], message: "tags must be an array of strings" }]);
      }
      const asset = await service.updateAssetTags(req.params.assetId, tags);
      res.json(service.formatAsset(asset));
    } catch (err) {
      if (err?.code === "P2025") {
        return sendError(res, 404, "NOT_FOUND", "Asset not found");
      }
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/workspaces/:id/assets/:assetId/auto-tag`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const asset = await service.getAsset(req.params.assetId);
      if (!asset || asset.clientId !== req.params.id) {
        return sendError(res, 404, "NOT_FOUND", "Asset not found");
      }
      if (!asset.url) {
        return sendError(res, 422, "NO_URL", "Asset has no URL for classification");
      }

      // Get industry tag defaults for the workspace
      const client = await prisma.client.findUnique({
        where: { id: req.params.id },
        select: { industryKey: true },
      });
      const tagDefaults = getAssetTagDefaults(client?.industryKey);
      const tagList = tagDefaults.length > 0
        ? tagDefaults.join(", ")
        : "exterior, kitchen, living_room, dining_room, bedroom, bathroom, backyard, garage, pool, office, laundry, floorplan, aerial, neighborhood, detail, other";

      const { extractFromImage } = await import("./generation/openai.provider.js");
      const prompt = `Classify this image. Return a JSON object with "tags" (array of strings) from ONLY these options: [${tagList}]. Pick 1-3 tags that best describe what's shown. If unsure, use "other".`;

      const result = await extractFromImage({ base64: asset.url, prompt });
      const suggestedTags = Array.isArray(result?.parsed?.tags) ? result.parsed.tags : [];

      // Merge with existing tags and save directly so callers don't need a
      // second round-trip.  This fixes the multi-upload race where only the
      // last mutation's onSuccess callback fired.
      const merged = Array.from(new Set([...(asset.tags ?? []), ...suggestedTags]));
      if (merged.length > 0) {
        await service.updateAssetTags(req.params.assetId, merged);
      }

      res.json({ suggestedTags, savedTags: merged });
    } catch (err) {
      next(err);
    }
  }
);

// ── Batch auto-tag: classify multiple assets in parallel ────────────
studioRouter.post(
  `${BASE}/workspaces/:id/assets/batch-auto-tag`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const { assetIds } = req.body;
      if (!Array.isArray(assetIds) || assetIds.length === 0) {
        return validationError(res, [{ path: ["assetIds"], message: "assetIds must be a non-empty array" }]);
      }
      // Cap at 20 to prevent abuse
      const ids = assetIds.slice(0, 20);

      const client = await prisma.client.findUnique({
        where: { id: req.params.id },
        select: { industryKey: true },
      });
      const tagDefaults = getAssetTagDefaults(client?.industryKey);
      const tagList = tagDefaults.length > 0
        ? tagDefaults.join(", ")
        : "exterior, kitchen, living_room, dining_room, bedroom, bathroom, backyard, garage, pool, office, laundry, floorplan, aerial, neighborhood, detail, other";

      const { extractFromImage } = await import("./generation/openai.provider.js");
      const prompt = `Classify this image. Return a JSON object with "tags" (array of strings) from ONLY these options: [${tagList}]. Pick 1-3 tags that best describe what's shown. If unsure, use "other".`;

      // Process in parallel batches of 5
      const results = [];
      for (let i = 0; i < ids.length; i += 5) {
        const batch = ids.slice(i, i + 5);
        const batchResults = await Promise.allSettled(
          batch.map(async (assetId) => {
            const asset = await service.getAsset(assetId);
            if (!asset || asset.clientId !== req.params.id || !asset.url) {
              return { assetId, tags: [], error: "not_found" };
            }
            try {
              const result = await extractFromImage({ base64: asset.url, prompt });
              const suggestedTags = Array.isArray(result?.parsed?.tags) ? result.parsed.tags : [];
              const merged = Array.from(new Set([...(asset.tags ?? []), ...suggestedTags]));
              if (merged.length > 0) {
                await service.updateAssetTags(assetId, merged);
              }
              return { assetId, tags: merged };
            } catch {
              return { assetId, tags: asset.tags ?? [], error: "classification_failed" };
            }
          })
        );
        for (const r of batchResults) {
          results.push(r.status === "fulfilled" ? r.value : { assetId: "unknown", tags: [], error: "failed" });
        }
      }

      res.json({ results });
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.get(
  `${BASE}/workspaces/:id/asset-tag-defaults`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const client = await prisma.client.findUnique({
        where: { id: req.params.id },
        select: { industryKey: true },
      });
      const tags = getAssetTagDefaults(client?.industryKey);
      res.json({ tags });
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/assets/generate`,
  async (req, res, next) => {
    try {
      const parsed = GenerateMediaSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      // Tenant isolation: clientId in body must be owned by the
      // requester, and any draftId / folderId references must live
      // inside the same workspace.
      const ownerCheck = await assertClientOwnedByCurrentUser(parsed.data.clientId, req);
      if (ownerCheck) return sendError(res, ownerCheck.status, ownerCheck.code, ownerCheck.message);
      try {
        await assertDraftInClient(parsed.data.draftId, parsed.data.clientId);
        await assertFolderInClient(parsed.data.folderId, parsed.data.clientId);
      } catch (e) {
        return sendError(res, e.status ?? 404, e.code ?? "NOT_FOUND", e.message);
      }

      // Service health pre-flight
      if (await getServiceStatus("fal") === "down") return sendError(res, 503, "SERVICE_UNAVAILABLE", "Image generation temporarily limited. Please try again in a few minutes.");
      { const throttle = await getThrottlePolicy(); if (throttle.adminPaused) return sendError(res, 503, "SERVICE_UNAVAILABLE", "AI generation is temporarily paused by the administrator."); }

      // Global budget check
      if (await isProviderBudgetExceeded("fal")) return sendError(res, 503, "BUDGET_EXCEEDED", "AI image generation is temporarily unavailable due to budget limits. Please try again later.");

      const dedupKey = await acquireDedup(req.user.id, "image", parsed.data);
      if (!dedupKey) return sendError(res, 429, "DUPLICATE_REQUEST", "An image generation is already in progress. Please wait.");

      // Usage limit check (generation-specific + total image count)
      const genQuotaErr = await enforceUsageLimit(req.user.id, "imageGenerations");
      if (genQuotaErr) { await releaseDedup(dedupKey); return sendError(res, 402, genQuotaErr.code, "You have reached your monthly image generation limit. Upgrade your plan for more.", genQuotaErr); }
      const imgQuotaErr = await enforceUsageLimit(req.user.id, "images");
      if (imgQuotaErr) { await releaseDedup(dedupKey); return sendError(res, 402, imgQuotaErr.code, "You have reached your monthly image limit. Upgrade your plan for more.", imgQuotaErr); }
      // Storage check (~2 MB estimated per generated image)
      const storageOk = await checkStorageLimit(req.user.id, 2 * 1024 * 1024, false);
      if (!storageOk.allowed) { await releaseDedup(dedupKey); return sendError(res, 402, "STORAGE_LIMIT", storageOk.reason, { current: storageOk.current, limit: storageOk.limit }); }

      const actorSub = getAuth0Sub(req);
      const asset = await service.enqueueGeneration({
        ...parsed.data,
        createdBy: actorSub,
        userId: req.user.id,
      });

      await releaseDedup(dedupKey);
      await Promise.all([
        incrementUsage(req.user.id, "imageGenerations"),
        incrementUsage(req.user.id, "images"),
      ]);

      trackAiUsage({
        userId: req.user.id,
        clientId: parsed.data.clientId,
        actionType: "IMAGE",
        model: parsed.data.model ?? "fal-ai/flux/dev",
        promptTokens: 0,
        completionTokens: 0,
      });

      checkUsageNearing(req.user.id, "imageGenerations").then((info) => {
        if (info) enqueueNotification({
          userId: req.user.id,
          eventType: "USAGE_LIMIT_NEARING",
          payload: info,
          resourceType: "usage",
          resourceId: `${req.user.id}:imageGenerations`,
        });
      }).catch(() => {});

      // Persona analytics
      if (asset.personaUsed) {
        recordActivity({
          userId: req.user.id,
          clientId: parsed.data.clientId,
          eventType: "PERSONA_USED_IN_IMAGE",
          payload: { personaType: asset.personaType, postId: parsed.data.draftId, clientId: parsed.data.clientId },
          resourceType: "asset",
          resourceId: asset.id,
        }).catch(() => {});
      } else if (asset.personaSkipped) {
        recordActivity({
          userId: req.user.id,
          clientId: parsed.data.clientId,
          eventType: "PERSONA_SKIPPED",
          payload: { guidance: parsed.data.guidance?.slice(0, 100), clientId: parsed.data.clientId },
          resourceType: "asset",
          resourceId: asset.id,
        }).catch(() => {});
      }

      const response = service.formatAsset(asset);
      if (asset.queued === false) response.processingNote = "Processing delayed — your content is being generated";
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.get(
  `${BASE}/video-presets`,
  async (_req, res) => {
    const presets = Object.entries(service.VIDEO_PRESETS).map(([key, p]) => ({
      key,
      label: p.label,
      suggestedDuration: p.suggestedDuration,
      defaultAspectRatio: p.defaultAspectRatio,
    }));
    res.json({ presets });
  }
);

studioRouter.post(
  `${BASE}/assets/generate-video`,
  async (req, res, next) => {
    try {
      const parsed = GenerateVideoSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      // Tenant isolation — same shape as image generation.
      const ownerCheck = await assertClientOwnedByCurrentUser(parsed.data.clientId, req);
      if (ownerCheck) return sendError(res, ownerCheck.status, ownerCheck.code, ownerCheck.message);
      try {
        await assertDraftInClient(parsed.data.draftId, parsed.data.clientId);
        await assertFolderInClient(parsed.data.folderId, parsed.data.clientId);
      } catch (e) {
        return sendError(res, e.status ?? 404, e.code ?? "NOT_FOUND", e.message);
      }

      // Service health pre-flight
      if (await getServiceStatus("fal") === "down") return sendError(res, 503, "SERVICE_UNAVAILABLE", "Video generation temporarily limited. Please try again in a few minutes.");
      const throttle = await getThrottlePolicy();
      if (throttle.adminPaused) return sendError(res, 503, "SERVICE_UNAVAILABLE", "AI generation is temporarily paused by the administrator.");

      // Explicit tier gate — check if video generation is allowed on this plan.
      // Use getEffectiveTier so a pre-checkout customer row never grants paid limits.
      const sub = await getSubscription(req.user.id);
      const tier = getEffectiveTier(sub);
      const tierLimits = getLimitsForTier(tier);
      if (tierLimits.videoGenerations === 0) return sendError(res, 402, "TIER_LIMIT", "Video generation is not available on your plan. Upgrade to a higher tier.");

      // Video throttle — disabled when fal budget at warning+
      if (throttle.videoDisabled) return sendError(res, 503, "FEATURE_THROTTLED", "Video generation is temporarily limited to manage costs. Please try again later.");

      // Global budget check
      if (await isProviderBudgetExceeded("fal")) return sendError(res, 503, "BUDGET_EXCEEDED", "AI video generation is temporarily unavailable due to budget limits. Please try again later.");

      const dedupKey = await acquireDedup(req.user.id, "video", parsed.data);
      if (!dedupKey) return sendError(res, 429, "DUPLICATE_REQUEST", "A video generation is already in progress. Please wait.");

      // Usage limit check (generation-specific + total video count)
      const vidGenQuotaErr = await enforceUsageLimit(req.user.id, "videoGenerations");
      if (vidGenQuotaErr) { await releaseDedup(dedupKey); return sendError(res, 402, vidGenQuotaErr.code, "You have reached your monthly video generation limit. Upgrade your plan for more.", vidGenQuotaErr); }
      const vidQuotaErr = await enforceUsageLimit(req.user.id, "videos");
      if (vidQuotaErr) { await releaseDedup(dedupKey); return sendError(res, 402, vidQuotaErr.code, "You have reached your monthly video limit. Upgrade your plan for more.", vidQuotaErr); }
      // Storage check (~10 MB estimated per generated video)
      const vidStorageOk = await checkStorageLimit(req.user.id, 10 * 1024 * 1024, true);
      if (!vidStorageOk.allowed) { await releaseDedup(dedupKey); return sendError(res, 402, "STORAGE_LIMIT", vidStorageOk.reason, { current: vidStorageOk.current, limit: vidStorageOk.limit }); }

      const actorSub = getAuth0Sub(req);
      const asset = await service.enqueueVideoGeneration({
        ...parsed.data,
        createdBy: actorSub,
        userId: req.user.id,
      });

      await releaseDedup(dedupKey);
      await Promise.all([
        incrementUsage(req.user.id, "videoGenerations"),
        incrementUsage(req.user.id, "videos"),
      ]);

      trackAiUsage({
        userId: req.user.id,
        clientId: parsed.data.clientId,
        actionType: "VIDEO",
        model: parsed.data.model ?? "fal-ai/minimax/video-01-live",
        promptTokens: 0,
        completionTokens: 0,
      });

      checkUsageNearing(req.user.id, "videoGenerations").then((info) => {
        if (info) enqueueNotification({
          userId: req.user.id,
          eventType: "USAGE_LIMIT_NEARING",
          payload: info,
          resourceType: "usage",
          resourceId: `${req.user.id}:videoGenerations`,
        });
      }).catch(() => {});

      const response = service.formatAsset(asset);
      if (asset.queued === false) response.processingNote = "Processing delayed — your content is being generated";
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/assets/:assetId/attach`,
  requireAssetOwner,
  requireAssetAndDraftSameWorkspace,
  async (req, res, next) => {
    try {
      const parsed = AttachAssetSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const asset = await service.attachAssetToDraft({
        assetId: req.params.assetId,
        ...parsed.data,
      });
      res.json(service.formatAsset(asset));
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/assets/:assetId/detach`,
  requireAssetOwner,
  async (req, res, next) => {
    try {
      const asset = await service.detachAssetFromDraft(req.params.assetId);
      res.json(service.formatAsset(asset));
    } catch (err) {
      next(err);
    }
  }
);

// ── Asset link / unlink (many-to-many) ──────────────────────────────────

studioRouter.post(
  `${BASE}/assets/:assetId/link`,
  requireAssetOwner,
  requireAssetAndDraftSameWorkspace,
  async (req, res, next) => {
    try {
      const parsed = LinkAssetSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const { draftId, role, orderIndex } = parsed.data;
      await service.linkAssetToDraft(req.params.assetId, draftId, role, orderIndex);
      const asset = await service.getAsset(req.params.assetId);
      res.json(service.formatAsset(asset));
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.delete(
  `${BASE}/assets/:assetId/link/:draftId`,
  requireAssetOwner,
  requireAssetAndDraftSameWorkspace,
  async (req, res, next) => {
    try {
      // Check if the asset being unlinked has persona data
      const unlinkingAsset = await service.getAsset(req.params.assetId);
      await service.unlinkAssetFromDraft(req.params.assetId, req.params.draftId);

      if (unlinkingAsset?.personaSnapshot) {
        recordActivity({
          userId: req.user.id,
          clientId: unlinkingAsset.clientId,
          eventType: "PERSONA_MEDIA_REPLACED",
          payload: { personaSnapshot: unlinkingAsset.personaSnapshot, draftId: req.params.draftId, clientId: unlinkingAsset.clientId },
          resourceType: "asset",
          resourceId: req.params.assetId,
        }).catch(() => {});
      }

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/assets/:assetId/persona-feedback`,
  requireAssetOwner,
  async (req, res, next) => {
    try {
      const parsed = PersonaFeedbackSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      const asset = await service.getAsset(req.params.assetId);
      if (!asset) return sendError(res, 404, "NOT_FOUND", "Asset not found");
      if (!asset.personaSnapshot) return sendError(res, 422, "NOT_PERSONA_ASSET", "Asset was not generated with a persona");

      recordActivity({
        userId: req.user.id,
        clientId: asset.clientId,
        eventType: "PERSONA_IMAGE_REJECTED",
        payload: {
          feedbackReason: parsed.data.reason,
          feedbackDetail: parsed.data.detail ?? null,
          personaSnapshot: asset.personaSnapshot,
          clientId: asset.clientId,
        },
        resourceType: "asset",
        resourceId: asset.id,
      }).catch(() => {});

      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.get(
  `${BASE}/assets/:assetId/usage`,
  requireAssetOwner,
  async (req, res, next) => {
    try {
      const rows = await service.getAssetUsage(req.params.assetId);
      const drafts = rows.map((r) => ({
        id: r.draft.id,
        channel: r.draft.channel,
        bodySnippet: r.draft.body?.slice(0, 80) ?? "",
        status: r.draft.status,
        role: r.role,
      }));
      res.json({ drafts });
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/assets/:assetId/generate-post`,
  requireAssetOwner,
  async (req, res, next) => {
    try {
      const parsed = GeneratePostFromAssetSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      const asset = await service.getAsset(req.params.assetId);
      if (!asset) return sendError(res, 404, "NOT_FOUND", "Asset not found");

      // Usage limit check
      const allowed = await checkUsageLimit(req.user.id, "posts");
      if (!allowed) return sendError(res, 402, "USAGE_LIMIT", "You have reached your monthly generation limit. Upgrade your plan for more.");

      // Build guidance from the asset's context
      const context = asset.renderedPrompt || asset.caption || asset.filename || "image";
      const guidance = parsed.data.guidance
        ? `${parsed.data.guidance}\n\nAsset context: ${context}`
        : `Write a social media post inspired by this visual: ${context}`;

      const actorSub = getAuth0Sub(req);
      const draft = await service.generateDraft({
        clientId: asset.clientId,
        kind: parsed.data.kind,
        channel: parsed.data.channel,
        guidance,
        createdBy: actorSub,
        userId: req.user.id,
      });

      await incrementUsage(req.user.id, "posts");

      // Auto-link the asset to the new draft
      await service.linkAssetToDraft(asset.id, draft.id, "primary");

      res.status(201).json(draft);
    } catch (err) {
      next(err);
    }
  }
);

// ── Post metrics ───────────────────────────────────────────────────────

studioRouter.get(
  `${BASE}/drafts/:id/metrics`,
  requireDraftOwner,
  async (req, res, next) => {
    try {
      const metrics = await service.getMetrics(req.params.id);
      res.json({ metrics: service.formatMetrics(metrics) });
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.get(
  `${BASE}/workspaces/:id/metrics`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = MetricsSummaryQuerySchema.safeParse(req.query);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const summary = await service.getClientMetricsSummary({
        clientId: req.params.id,
        ...parsed.data,
      });
      res.json(summary);
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/drafts/:id/metrics/sync`,
  requireDraftOwner,
  async (req, res, next) => {
    try {
      const result = await service.syncMetrics(req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.get(
  `${BASE}/workspaces/:id/metrics/sync-status`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const status = await service.getMetricsSyncStatus(req.params.id);
      res.json(status);
    } catch (err) {
      next(err);
    }
  }
);

// Admin/dev-only batch sync of Facebook + Instagram metrics for a
// workspace. Used for Meta App Review: triggers real Graph API calls
// against connections that include read_insights /
// instagram_manage_insights so the App Review dashboard registers the
// required API calls. Bypasses the 1h cooldown via force=true in the
// service. Role gate runs before ownership so we don't leak workspace
// existence to non-admins.
studioRouter.post(
  `${BASE}/workspaces/:id/metrics/sync-meta`,
  requireInternalAccess,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const result = await service.syncMetricsForClient(req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// TEMPORARY — Meta App Review API check tool. Hits one Page-level
// Insights endpoint (read_insights) and one IG user-level Insights
// endpoint (instagram_manage_insights) so Meta's App Review dashboard
// can detect actual API usage. Delete this route, the service it
// calls, and the frontend button after Meta approves. See
// docs/meta-app-review-api-checks.md for the removal checklist.
studioRouter.post(
  `${BASE}/workspaces/:id/dev/meta/app-review-checks`,
  requireInternalAccess,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const result = await service.runMetaAppReviewChecks(req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── Threads replies ────────────────────────────────────────────────────
//
// Demonstrates threads_read_replies and threads_manage_replies. The
// list route fetches replies on a published Threads post; the
// visibility route hides/unhides a single reply (explicit user
// action only — no automation).
studioRouter.get(
  `${BASE}/drafts/:id/threads/replies`,
  requireDraftOwner,
  async (req, res, next) => {
    try {
      const draft = await prisma.draft.findUnique({
        where: { id: req.params.id },
        select: { clientId: true },
      });
      if (!draft) return sendError(res, 404, "DRAFT_NOT_FOUND", "Draft not found");
      const result = await service.listThreadsRepliesForDraft({
        draftId: req.params.id,
        clientId: draft.clientId,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/drafts/:id/threads/replies/:replyId/visibility`,
  requireDraftOwner,
  async (req, res, next) => {
    try {
      const hide = req.body?.hide;
      if (typeof hide !== "boolean") {
        return validationError(res, [
          { code: "invalid_type", path: ["hide"], message: "hide must be a boolean" },
        ]);
      }
      const draft = await prisma.draft.findUnique({
        where: { id: req.params.id },
        select: { clientId: true },
      });
      if (!draft) return sendError(res, 404, "DRAFT_NOT_FOUND", "Draft not found");
      const result = await service.setThreadsReplyHidden({
        draftId: req.params.id,
        clientId: draft.clientId,
        replyId: req.params.replyId,
        hide,
        actorSub: getAuth0Sub(req),
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── Connection validation ──────────────────────────────────────────────

studioRouter.post(
  `${BASE}/workspaces/:id/connections/:channel/validate`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const paramCheck = ChannelParamSchema.safeParse({
        channel: req.params.channel,
      });
      if (!paramCheck.success)
        return validationError(res, paramCheck.error.issues);
      const result = await service.validateConnection(
        req.params.id,
        paramCheck.data.channel
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── Channel connections ─────────────────────────────────────────────────

studioRouter.get(
  `${BASE}/workspaces/:id/connections`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const connections = await service.listConnections(req.params.id);
      res.json({ connections });
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/workspaces/:id/connections/:channel/oauth/start`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const paramCheck = ChannelParamSchema.safeParse({
        channel: req.params.channel,
      });
      if (!paramCheck.success) return validationError(res, paramCheck.error.issues);
      const { channel } = paramCheck.data;
      const clientId = req.params.id;

      const oauth = getOAuthForChannel(channel);

      const { token, expiresAt } = await signState({ clientId, channel });
      const authUrl = await oauth.buildAuthUrl({ state: token });
      res.json({ authUrl, state: token, expiresAt });
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/oauth/complete`,
  async (req, res, next) => {
    try {
      const parsed = OAuthCompleteSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      const { code, state } = parsed.data;
      const payload = await verifyState(state);
      const { clientId, channel } = payload;

      // The state JWT carries clientId, but verify the completing
      // user actually owns that workspace. Without this, anyone who
      // intercepts the state token (e.g. via shared device, log
      // leak) could finalize a connection in someone else's account.
      const ownerCheck = await assertClientOwnedByCurrentUser(clientId, req);
      if (ownerCheck) return sendError(res, ownerCheck.status, ownerCheck.code, ownerCheck.message);

      const oauth = getOAuthForChannel(channel);
      const tokenBundle = await oauth.exchangeCode({ code, state });

      const actorSub = getAuth0Sub(req);
      const row = await service.upsertConnection({
        clientId,
        channel,
        accessToken: tokenBundle.accessToken,
        refreshToken: tokenBundle.refreshToken,
        tokenExpiresAt: tokenBundle.tokenExpiresAt,
        scopes: tokenBundle.scopes,
        externalAccountId: tokenBundle.externalAccountId,
        displayName: tokenBundle.displayName,
        createdBy: actorSub,
      });

      req.log?.info({ clientId, channel, userId: req.user?.id }, "oauth_connected");

      recordActivity({
        userId: req.user.id,
        clientId,
        eventType: "CONNECTION_CONNECTED",
        payload: { channel, clientId },
        resourceType: "connection",
        resourceId: row.id,
      }).catch(() => {});

      res.json({ connection: service.formatConnection(row) });
    } catch (err) {
      req.log?.error({ err: err?.message, code: err?.code }, "oauth_failed");
      next(err);
    }
  }
);

studioRouter.delete(
  `${BASE}/workspaces/:id/connections/:channel`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const paramCheck = ChannelParamSchema.safeParse({
        channel: req.params.channel,
      });
      if (!paramCheck.success)
        return validationError(res, paramCheck.error.issues);
      await service.deleteConnection(req.params.id, paramCheck.data.channel);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

// ── LinkedIn Organization Page picker ────────────────────────────────
//
// Two-step UI flow that runs after a successful org OAuth:
//   1. GET  …/connections/LINKEDIN_ORGANIZATION_PAGE/orgs
//      → returns the orgs the connecting member can administer.
//      The UI renders a picker.
//   2. POST …/connections/LINKEDIN_ORGANIZATION_PAGE/orgs/select
//      → persists the chosen org URN on the existing connection row
//      so subsequent publishes know which Page to author as.
//
// requireClientOwner verifies the workspace; we then look up the
// LINKEDIN_ORGANIZATION_PAGE connection for that workspace ourselves
// — the channel name is fixed, so no extra ownership check is needed.

studioRouter.get(
  `${BASE}/workspaces/:id/connections/LINKEDIN_ORGANIZATION_PAGE/orgs`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const conn = await prisma.channelConnection.findUnique({
        where: {
          clientId_channel: {
            clientId: req.params.id,
            channel: "LINKEDIN_ORGANIZATION_PAGE",
          },
        },
        select: { id: true },
      });
      if (!conn) {
        return sendError(
          res,
          404,
          "NO_CONNECTION",
          "Connect a LinkedIn Organization Page first, then choose which Page to publish to."
        );
      }
      const { listManageableOrganizations } = await import(
        "./linkedinOrgPages.service.js"
      );
      const orgs = await listManageableOrganizations({ connectionId: conn.id });
      if (orgs.length === 0) {
        return res.json({
          orgs: [],
          message:
            "No LinkedIn Organization Pages were found for this account. Make sure your LinkedIn account is an admin or content admin of the Page.",
        });
      }
      res.json({ orgs });
    } catch (err) {
      // The service throws typed errors with .status and .code; relay
      // those instead of letting the catch-all hand back a 500.
      if (err?.code && err?.status) {
        return sendError(res, err.status, err.code, err.message);
      }
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/workspaces/:id/connections/LINKEDIN_ORGANIZATION_PAGE/orgs/select`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const { organizationId, organizationName } = req.body ?? {};
      if (!organizationId || typeof organizationId !== "string") {
        return validationError(res, [
          { path: ["organizationId"], message: "organizationId is required" },
        ]);
      }
      const conn = await prisma.channelConnection.findUnique({
        where: {
          clientId_channel: {
            clientId: req.params.id,
            channel: "LINKEDIN_ORGANIZATION_PAGE",
          },
        },
        select: { id: true },
      });
      if (!conn) {
        return sendError(res, 404, "NO_CONNECTION", "No LinkedIn Organization Page connection.");
      }
      const { saveSelectedOrganization } = await import(
        "./linkedinOrgPages.service.js"
      );
      const updated = await saveSelectedOrganization({
        connectionId: conn.id,
        organizationId,
        organizationName,
      });
      res.json({ connection: updated });
    } catch (err) {
      if (err?.code && err?.status) {
        return sendError(res, err.status, err.code, err.message);
      }
      next(err);
    }
  }
);

// ── Pinterest board picker ───────────────────────────────────────────
//
// Mirrors the LinkedIn Organization Page picker pattern: after a
// successful Pinterest OAuth callback the connection has the user's
// Pinterest @username on it but no destination board. This pair of
// endpoints drives the picker UI.

studioRouter.get(
  `${BASE}/workspaces/:id/connections/PINTEREST/boards`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const conn = await prisma.channelConnection.findUnique({
        where: {
          clientId_channel: {
            clientId: req.params.id,
            channel: "PINTEREST",
          },
        },
        select: { id: true },
      });
      if (!conn) {
        return sendError(
          res,
          404,
          "NO_CONNECTION",
          "Connect Pinterest first, then choose which board to publish to."
        );
      }
      const { listBoards } = await import("./pinterestBoards.service.js");
      const boards = await listBoards({ connectionId: conn.id });
      if (boards.length === 0) {
        return res.json({
          boards: [],
          message:
            "No Pinterest boards were found. Create a board in Pinterest, then reconnect or refresh.",
        });
      }
      res.json({ boards });
    } catch (err) {
      if (err?.code && err?.status) {
        return sendError(res, err.status, err.code, err.message);
      }
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/workspaces/:id/connections/PINTEREST/boards`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const { name, description } = req.body ?? {};
      if (!name || typeof name !== "string" || !name.trim()) {
        return validationError(res, [
          { path: ["name"], message: "name is required" },
        ]);
      }
      const conn = await prisma.channelConnection.findUnique({
        where: {
          clientId_channel: {
            clientId: req.params.id,
            channel: "PINTEREST",
          },
        },
        select: { id: true },
      });
      if (!conn) {
        return sendError(res, 404, "NO_CONNECTION", "No Pinterest connection.");
      }
      const { createBoard } = await import("./pinterestBoards.service.js");
      const board = await createBoard({
        connectionId: conn.id,
        name,
        description: description ?? null,
      });
      res.status(201).json({ board });
    } catch (err) {
      if (err?.code && err?.status) {
        return sendError(res, err.status, err.code, err.message);
      }
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/workspaces/:id/connections/PINTEREST/boards/select`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const { boardId, boardName } = req.body ?? {};
      if (!boardId || typeof boardId !== "string") {
        return validationError(res, [
          { path: ["boardId"], message: "boardId is required" },
        ]);
      }
      const conn = await prisma.channelConnection.findUnique({
        where: {
          clientId_channel: {
            clientId: req.params.id,
            channel: "PINTEREST",
          },
        },
        select: { id: true },
      });
      if (!conn) {
        return sendError(res, 404, "NO_CONNECTION", "No Pinterest connection.");
      }
      const { saveSelectedBoard } = await import("./pinterestBoards.service.js");
      const updated = await saveSelectedBoard({
        connectionId: conn.id,
        boardId,
        boardName,
      });
      res.json({ connection: updated });
    } catch (err) {
      if (err?.code && err?.status) {
        return sendError(res, err.status, err.code, err.message);
      }
      next(err);
    }
  }
);

// ── Tech Stack ────────────────────────────────────────────────────────

/**
 * GET /api/v1/workspaces/:id/tech-stack
 * Returns the merged tech stack view (industry config + workspace connection state).
 */
studioRouter.get(
  `${BASE}/workspaces/:id/tech-stack`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const items = await getWorkspaceTechStackView(req.params.id);
      res.json({ techStack: items });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PUT /api/v1/workspaces/:id/tech-stack/:providerKey
 * Save metadata for a manual tech stack item and mark it as connected.
 */
studioRouter.put(
  `${BASE}/workspaces/:id/tech-stack/:providerKey`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const { providerKey } = req.params;

      // Look up workspace's industry to validate the item exists and is manual
      const client = await prisma.client.findUnique({
        where: { id: req.params.id },
        select: { industryKey: true },
      });
      if (!client?.industryKey) {
        return sendError(res, 404, "NOT_FOUND", "Workspace not found.");
      }

      const items = getIndustryTechStack(client.industryKey);
      const item = items.find((i) => i.providerKey === providerKey);
      if (!item) {
        return sendError(res, 404, "NOT_FOUND", `Tech stack item "${providerKey}" not found.`);
      }
      if (item.connectionMode !== "manual") {
        return sendError(res, 400, "NOT_MANUAL", "This item does not support manual setup.");
      }
      if (!item.manualSetup?.fields?.length) {
        return sendError(res, 400, "NO_SETUP_CONFIG", "This item has no manual setup config.");
      }

      const parsed = ManualSetupSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      // Validate required fields and normalize values
      const metadata = { ...parsed.data.metadata };
      for (const field of item.manualSetup.fields) {
        let value = (metadata[field.key] ?? "").trim();

        if (field.required && !value) {
          return sendError(res, 400, "VALIDATION", `${field.label} is required.`);
        }

        // URL normalization for url-type fields
        if (field.type === "url" && value) {
          if (!/^https?:\/\//i.test(value)) {
            value = `https://${value}`;
          }
          try {
            new URL(value);
          } catch {
            return sendError(res, 400, "INVALID_URL", `${field.label}: please enter a valid URL.`);
          }
        }

        // Encrypt password/secret fields before storing
        if (field.type === "password" && value) {
          value = encryptToken(value);
        }

        metadata[field.key] = value;
      }

      const connection = await upsertWorkspaceTechStackConnection(
        req.params.id,
        providerKey,
        "connected",
        { metadataJson: metadata },
      );

      // Invalidate generation context cache so prompts pick up new tech stack state
      invalidateClientContext(req.params.id).catch(() => {});

      res.json({ connection });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/workspaces/:id/tech-stack/listing_feed/refresh
 * Extract listings from the stored sourceUrl and save as WorkspaceDataItems.
 */
studioRouter.post(
  `${BASE}/workspaces/:id/tech-stack/listing_feed/refresh`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const workspaceId = req.params.id;

      // Validate workspace is real_estate industry
      const client = await prisma.client.findUnique({
        where: { id: workspaceId },
        select: { industryKey: true },
      });
      if (!client || client.industryKey !== "real_estate") {
        return sendError(res, 400, "WRONG_INDUSTRY", "Listing feeds are only available for real estate workspaces.");
      }

      // Parse optional body override
      const parsed = ListingFeedRefreshSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      // Get stored connection for sourceUrl
      const existing = await prisma.workspaceTechStackConnection.findUnique({
        where: { workspaceId_providerKey: { workspaceId, providerKey: "listing_feed" } },
      });

      const sourceUrl = parsed.data?.sourceUrl || existing?.metadataJson?.sourceUrl;
      if (!sourceUrl) {
        return sendError(res, 400, "NO_SOURCE_URL", "No listings page URL configured. Set one up first via tech stack.");
      }

      // Extract listings using existing AI pipeline
      const hint = "Extract property listings from this page. For each listing, extract: title/address, price, bedrooms, bathrooms, square footage, and image URL. Focus only on real estate property listings.";
      const { items: allItems } = await importService.extractFromUrl(sourceUrl, { hint });

      // Filter to CUSTOM type (listings) and cap at 10
      const listings = allItems.filter((i) => i.type === "CUSTOM").slice(0, 10);

      // Stamp source attribution for provenance tracking
      const stampedListings = listings.map((item) => ({
        ...item,
        dataJson: stampSourceAttribution(item.dataJson || {}, RE_SOURCE_TYPES.LISTING_FEED, { sourceUrl }),
      }));

      // Persist via existing saveImportedItems
      if (stampedListings.length > 0) {
        await importService.saveImportedItems(workspaceId, {
          items: stampedListings,
          sourceType: "URL",
          sourceUrl,
        });
      }

      // Update connection metadata with sync info
      const lastSyncedAt = new Date().toISOString();
      await upsertWorkspaceTechStackConnection(workspaceId, "listing_feed", "connected", {
        metadataJson: {
          ...(existing?.metadataJson ?? {}),
          sourceUrl,
          lastSyncedAt,
          listingCount: listings.length,
        },
      });

      // Invalidate context cache
      invalidateClientContext(workspaceId).catch(() => {});

      // Fire-and-forget: run autopilot if enabled (replaces old direct auto-generation)
      let autopilotTriggered = false;
      if (listings.length > 0) {
        runAutopilot(workspaceId).catch(() => {});
        autopilotTriggered = true;
      }

      res.json({ listings: listings.length, lastSyncedAt, autopilotTriggered });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/workspaces/:id/tech-stack/idx_website/refresh
 * Re-crawl the stored website URL and update metadata.
 */
studioRouter.post(
  `${BASE}/workspaces/:id/tech-stack/idx_website/refresh`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const workspaceId = req.params.id;

      const existing = await prisma.workspaceTechStackConnection.findUnique({
        where: { workspaceId_providerKey: { workspaceId, providerKey: "idx_website" } },
      });

      const url = existing?.metadataJson?.url;
      if (!url) {
        return sendError(res, 400, "NO_URL", "No website URL configured. Set one up first via tech stack.");
      }

      const crawled = await crawlWebsite(url, { maxPages: 20 });
      const lastSyncedAt = new Date().toISOString();

      await upsertWorkspaceTechStackConnection(workspaceId, "idx_website", "connected", {
        metadataJson: {
          ...(existing.metadataJson ?? {}),
          lastSyncedAt,
          pageCount: crawled.pages.length,
        },
      });

      invalidateClientContext(workspaceId).catch(() => {});

      res.json({ pages: crawled.pages.length, lastSyncedAt });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PATCH /api/v1/workspaces/:id/tech-stack/listing_feed/settings
 * Update listing feeds settings (e.g. autoGenerateOnImport).
 */
studioRouter.patch(
  `${BASE}/workspaces/:id/tech-stack/listing_feed/settings`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const workspaceId = req.params.id;
      const parsed = ListingFeedSettingsSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      const existing = await prisma.workspaceTechStackConnection.findUnique({
        where: { workspaceId_providerKey: { workspaceId, providerKey: "listing_feed" } },
      });
      if (!existing) {
        return sendError(res, 404, "NOT_FOUND", "Listing feeds not configured yet.");
      }

      const updated = await upsertWorkspaceTechStackConnection(workspaceId, "listing_feed", existing.connectionStatus, {
        metadataJson: {
          ...(existing.metadataJson ?? {}),
          autoGenerateOnImport: parsed.data.autoGenerateOnImport,
        },
      });

      res.json({ settings: { autoGenerateOnImport: parsed.data.autoGenerateOnImport } });
    } catch (err) {
      next(err);
    }
  }
);

// ── Campaigns ─────────────────────────────────────────────────────────
//
// Read-only endpoints for the new first-class Campaign rows.
// save-drafts creates Campaign records; this surface lets the
// Planner, Dashboard, and future Sites/Ads modules read canonical
// campaign metadata when present (falling back to the Draft
// denorm fields when not).

/**
 * GET /api/v1/workspaces/:id/campaigns
 *
 * Optional ?status=… filter restricts to one CampaignStatus value;
 * otherwise returns every campaign in the workspace ordered by
 * createdAt desc.
 */
studioRouter.get(
  `${BASE}/workspaces/:id/campaigns`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const where = { clientId: req.params.id };
      if (typeof req.query.status === "string" && req.query.status) {
        where.status = req.query.status;
      }
      const rows = await prisma.campaign.findMany({
        where,
        orderBy: { createdAt: "desc" },
      });
      res.json({ campaigns: rows.map(formatCampaign) });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/campaigns/:id
 *
 * Single-campaign read. Loads the row, verifies workspace
 * ownership against the requesting user, then returns the
 * serialized Campaign. 404 when missing; 403 when the campaign
 * belongs to another workspace.
 */
studioRouter.get(
  `${BASE}/campaigns/:id`,
  async (req, res, next) => {
    try {
      const row = await prisma.campaign.findUnique({
        where: { id: req.params.id },
      });
      if (!row) {
        return sendError(res, 404, "CAMPAIGN_NOT_FOUND", "Campaign not found");
      }
      // Manual ownership check — the requireClientOwner middleware
      // keys off :id meaning workspace id, not campaign id, so we
      // load the row first and check clientId against the user's
      // owned workspaces.
      const client = await prisma.client.findUnique({
        where: { id: row.clientId },
        select: { createdBy: true },
      });
      if (!client || client.createdBy !== req.user.id) {
        return sendError(res, 403, "FORBIDDEN", "You don't have access to this campaign");
      }
      res.json({ campaign: formatCampaign(row) });
    } catch (err) {
      next(err);
    }
  }
);

// ── Suite Feature Flags ───────────────────────────────────────────────
//
// Workspace-scoped read endpoint that returns the active state of
// each suite-module feature flag (Sites, Inbox, Ads). The
// dashboard sidebar + module shells gate visibility off these
// values. Evaluated server-side via the existing
// configService.evaluateFlag() helper, which already supports
// per-workspace targeting + global enablement + rollout
// percentages.
//
// Returns a flat shape so the web client doesn't have to
// re-parse — one query, three booleans.
studioRouter.get(
  `${BASE}/workspaces/:id/suite-flags`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const ctx = { workspaceId: req.params.id, userId: req.user?.id };
      const [sites, inbox, ads] = await Promise.all([
        evaluateFlag("suite.sites", ctx),
        evaluateFlag("suite.inbox", ctx),
        evaluateFlag("suite.ads", ctx),
      ]);
      res.json({ sites, inbox, ads });
    } catch (err) {
      next(err);
    }
  }
);

// ── Content Preferences ───────────────────────────────────────────────
//
// Persistent per-workspace assistant defaults — channels, cadence,
// CTA style, etc. The Create assistant reads these via
// useContentPreferences on the web side. GET returns a default-filled
// shape even when no row exists yet, so the settings page doesn't
// need to special-case "first load".

/**
 * GET /api/v1/workspaces/:id/content-preferences
 */
studioRouter.get(
  `${BASE}/workspaces/:id/content-preferences`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const preferences = await getContentPreferences(req.params.id);
      res.json({ preferences });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PUT /api/v1/workspaces/:id/content-preferences
 */
studioRouter.put(
  `${BASE}/workspaces/:id/content-preferences`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = ContentPreferencesUpdateSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const preferences = await updateContentPreferences(
        req.params.id,
        parsed.data,
      );
      res.json({ preferences });
    } catch (err) {
      next(err);
    }
  }
);

// ── Autopilot (Real Estate v2) ─────────────────────────────────────────

/**
 * GET /api/v1/workspaces/:id/autopilot/settings
 */
studioRouter.get(
  `${BASE}/workspaces/:id/autopilot/settings`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const settings = await getAutopilotSettings(req.params.id);
      res.json({ settings });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * PUT /api/v1/workspaces/:id/autopilot/settings
 */
studioRouter.put(
  `${BASE}/workspaces/:id/autopilot/settings`,
  requireClientOwner,
  requireTier("PRO"),
  async (req, res, next) => {
    try {
      const parsed = AutopilotSettingsSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const settings = await updateAutopilotSettings(req.params.id, parsed.data);
      res.json({ settings });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/workspaces/:id/autopilot/run
 * Manual trigger — evaluates triggers + settings + guardrails,
 * creates at most one draft or returns no_action.
 */
studioRouter.post(
  `${BASE}/workspaces/:id/autopilot/run`,
  requireClientOwner,
  requireTier("PRO"),
  async (req, res, next) => {
    try {
      const result = await runAutopilot(req.params.id, { mode: "manual" });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/workspaces/:id/autopilot/status
 * Dashboard-friendly autopilot status summary.
 */
studioRouter.get(
  `${BASE}/workspaces/:id/autopilot/status`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const status = await getAutopilotStatus(req.params.id);
      res.json(status);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/workspaces/:id/autopilot/scheduled-run
 * Scheduled autopilot run — evaluates coverage + triggers, may create up to
 * maxDraftsPerScheduledRun drafts. Intended for external scheduler / cron.
 */
studioRouter.post(
  `${BASE}/workspaces/:id/autopilot/scheduled-run`,
  requireClientOwner,
  requireTier("PRO"),
  async (req, res, next) => {
    try {
      const result = await runScheduledAutopilot(req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/internal/autopilot/evaluate-all
 * Internal endpoint — runs scheduled autopilot for all enabled workspaces.
 * Intended to be called by an external cron job (e.g. daily).
 * No workspace ownership check — protected by route prefix / API key in production.
 */
studioRouter.post(
  `${BASE}/internal/autopilot/evaluate-all`,
  async (req, res, next) => {
    try {
      const result = await evaluateAllAutopilotWorkspaces();
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/workspaces/:id/autopilot/readiness
 * Readiness checklist for autopilot activation.
 */
studioRouter.get(
  `${BASE}/workspaces/:id/autopilot/readiness`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const result = await getAutopilotReadiness(req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/workspaces/:id/autopilot/activity
 * Recent autopilot-generated draft activity.
 */
studioRouter.get(
  `${BASE}/workspaces/:id/autopilot/activity`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(parseInt(req.query.limit) || 20, 1), 50);
      const result = await getAutopilotActivity(req.params.id, limit);
      res.json({ activity: result });
    } catch (err) {
      next(err);
    }
  }
);

// ── Planner Suggestions ──────────────────────────────────────────────────

studioRouter.post(
  `${BASE}/workspaces/:id/planner/suggestions`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = PlannerSuggestionsSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      const result = await getPlannerSuggestions(req.params.id, {
        weekStart: parsed.data.weekStart,
        weekEnd: parsed.data.weekEnd,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/workspaces/:id/planner/plan-week`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = PlanMyWeekSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      // Service health pre-flight
      if (await getServiceStatus("openai") === "down") return sendError(res, 503, "SERVICE_UNAVAILABLE", "Content generation temporarily unavailable. Please try again in a few minutes.");
      { const throttle = await getThrottlePolicy(); if (throttle.adminPaused) return sendError(res, 503, "SERVICE_UNAVAILABLE", "AI generation is temporarily paused by the administrator."); }

      // Global budget check
      if (await isProviderBudgetExceeded("openai")) return sendError(res, 503, "BUDGET_EXCEEDED", "AI text generation is temporarily unavailable due to budget limits. Please try again later.");

      // Default to current week if not provided
      const now = new Date();
      const dayOfWeek = now.getDay();
      const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
      const weekStart = parsed.data.weekStart ?? new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset).toISOString().slice(0, 10);
      const weekEnd = parsed.data.weekEnd ?? new Date(now.getFullYear(), now.getMonth(), now.getDate() + mondayOffset + 6).toISOString().slice(0, 10);

      const actorSub = getAuth0Sub(req);
      const result = await planMyWeek(req.params.id, actorSub, {
        weekStart,
        weekEnd,
        generateDraft: service.generateDraft,
        scheduleDraft: service.scheduleDraft,
        checkUsageLimit,
        incrementUsage,
        userId: req.user.id,
      });

      // Fire-and-forget: notification + activity
      if (result.generated > 0) {
        enqueueNotification({
          userId: req.user.id,
          eventType: "BATCH_COMPLETE",
          payload: { count: result.generated, clientId: req.params.id, source: "plan_week" },
          resourceType: "client",
          resourceId: req.params.id,
        }).catch(() => {});

        recordActivity({
          userId: req.user.id,
          clientId: req.params.id,
          eventType: "PLAN_WEEK_EXECUTED",
          payload: {
            generated: result.generated,
            scheduled: result.scheduled,
            clientId: req.params.id,
          },
          resourceType: "client",
          resourceId: req.params.id,
        }).catch(() => {});
      }

      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/workspaces/:id/planner/swap-suggestion`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = SwapSuggestionSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      const result = await swapSuggestion(req.params.id, {
        excludeDataItemIds: parsed.data.excludeDataItemIds,
        targetDate: parsed.data.targetDate,
        channel: parsed.data.channel,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── Listing Ingestion ─────────────────────────────────────────────────────

/**
 * POST /api/v1/workspaces/:id/listings/manual
 * Ingest a single listing from manual entry.
 */
studioRouter.post(
  `${BASE}/workspaces/:id/listings/manual`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = ManualListingSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      const result = await listingIngestion.ingestManualListing(
        req.params.id,
        parsed.data
      );
      res.status(result.created ? 201 : 200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/workspaces/:id/listings/csv/preview
 * Preview CSV for listing import — returns headers, row count, auto-detected mapping.
 */
studioRouter.post(
  `${BASE}/workspaces/:id/listings/csv/preview`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = ListingCSVPreviewSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      const result = listingIngestion.previewListingCSV(parsed.data.csvContent);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/workspaces/:id/listings/csv/import
 * Import listings from CSV with column mapping.
 */
studioRouter.post(
  `${BASE}/workspaces/:id/listings/csv/import`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = ListingCSVImportSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      const result = await listingIngestion.ingestCsvListings(
        req.params.id,
        parsed.data.csvContent,
        { columnMapping: parsed.data.columnMapping }
      );
      res.status(201).json(result);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/workspaces/:id/listings/url
 * Import a listing from a URL (best-effort scraping). Returns preview.
 */
studioRouter.post(
  `${BASE}/workspaces/:id/listings/url`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = ListingUrlImportSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      const result = await listingIngestion.ingestUrlListing(
        req.params.id,
        parsed.data.url
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/workspaces/:id/listings/url/confirm
 * Confirm and save a URL-imported listing after user review/edit.
 */
studioRouter.post(
  `${BASE}/workspaces/:id/listings/url/confirm`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = ListingConfirmUrlSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      const result = await listingIngestion.confirmUrlListing(
        req.params.id,
        parsed.data
      );
      res.status(result.created ? 201 : 200).json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── Listing Campaign ──────────────────────────────────────────────────────

/**
 * POST /api/v1/workspaces/:id/listing-campaign/generate
 * Generate a multi-post listing marketing campaign sequence (3-6 coordinated posts)
 * from property data in a single AI call.
 */
studioRouter.post(
  `${BASE}/workspaces/:id/listing-campaign/generate`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const { propertyData, campaignType, imageContext, slots, dataItemId, sourceType: rawSourceType } = req.body;
      if (!propertyData || typeof propertyData !== "object") {
        return validationError(res, [{ path: ["propertyData"], message: "Property data is required" }]);
      }
      // Legacy clients (and the regenerate-post endpoint) don't send
      // sourceType — default to 'property' so existing real-estate
      // flows behave identically.
      const sourceType = ["property", "data_item", "idea"].includes(rawSourceType)
        ? rawSourceType
        : "property";

      // Service health pre-flight
      if (await getServiceStatus("openai") === "down") return sendError(res, 503, "SERVICE_UNAVAILABLE", "Content generation temporarily unavailable. Please try again in a few minutes.");
      if (await isProviderBudgetExceeded("openai")) return sendError(res, 503, "BUDGET_EXCEEDED", "AI text generation is temporarily unavailable due to budget limits. Please try again later.");

      // Usage limit check
      const allowed = await checkUsageLimit(req.user.id, "posts");
      if (!allowed) return sendError(res, 403, "USAGE_LIMIT", "You've reached your generation limit. Upgrade to generate more.");

      // Dedup
      const dedupKey = await acquireDedup(req.user.id, "listing-campaign", propertyData);
      if (!dedupKey) return sendError(res, 409, "DUPLICATE_REQUEST", "Campaign generation already in progress.");

      try {
        const clientId = req.params.id;
        const actorSub = getAuth0Sub(req);
        req.log?.info({ clientId, userId: req.user?.id, campaignType }, "campaign_extraction_started");

        // Resolve / record the source data item.
        //
        //  - property + dataItemId → verify workspace ownership and reuse.
        //  - property without dataItemId → ingest a synthetic listing
        //    (legacy real-estate path; preserves attribution for older
        //    callers that haven't yet wired up the new source picker).
        //  - data_item → must come with a dataItemId; verify ownership.
        //  - idea → no data item is created (the prompt receives the
        //    raw idea text via propertyData).
        let resolvedDataItemId = null;
        if (dataItemId && typeof dataItemId === "string") {
          const existing = await prisma.workspaceDataItem.findFirst({
            where: { id: dataItemId, clientId },
            select: { id: true },
          });
          if (existing) resolvedDataItemId = existing.id;
        }
        if (sourceType === "property" && !resolvedDataItemId) {
          const derivedTitle = propertyData.title
            || propertyData.name
            || (propertyData.year && propertyData.make && propertyData.model
                ? `${propertyData.year} ${propertyData.make} ${propertyData.model}`
                : null)
            || propertyData.address
            || "Campaign Item";

          const listingResult = await listingIngestion.ingestManualListing(clientId, {
            title: derivedTitle,
            address: propertyData.address || "",
            price: propertyData.price ? Number(propertyData.price) : undefined,
            beds: propertyData.beds ? Number(propertyData.beds) : undefined,
            baths: propertyData.baths ? Number(propertyData.baths) : undefined,
            sqft: propertyData.sqft ? Number(propertyData.sqft) : undefined,
            description: propertyData.description || "",
            highlights: propertyData.highlights ? propertyData.highlights.split(",").map((s) => s.trim()).filter(Boolean) : [],
            propertyType: propertyData.propertyType || undefined,
          });
          resolvedDataItemId = listingResult.dataItem?.id ?? null;
        }

        // Load generation context + RE assets
        const { loadClientGenerationContext } = await import("./generation/clientOrchestrator.js");
        const { buildSystemPrompt, buildCampaignUserPrompt, buildCampaignResponseFormat } = await import("./generation/promptBuilder.js");
        const { generateStructuredContent } = await import("./generation/openai.provider.js");
        const { loadRealEstateGenerationAssets } = await import("../industry/realEstateGeneration.js");
        const { findBestBlueprintForItem } = await import("./blueprint.service.js");

        const ctx = await loadClientGenerationContext(clientId);

        let realEstateAssets = null;
        if (ctx.realEstateContext) {
          try { realEstateAssets = await loadRealEstateGenerationAssets(clientId, ctx.realEstateContext); } catch {}
        }

        // ContentBlueprint injection — only for content-asset
        // campaigns. The frontend tucks the data item type into
        // propertyData._dataItemType so we can look up a matching
        // structural template here without changing the body shape.
        // Falls through silently when no match (the existing prompt
        // path stays intact).
        let blueprint = null;
        if (sourceType === "data_item") {
          const dataItemType = typeof propertyData?._dataItemType === "string"
            ? propertyData._dataItemType
            : null;
          const slotChannels = Array.isArray(slots)
            ? Array.from(
                new Set(
                  slots
                    .map((s) => (typeof s?.channel === "string" ? s.channel : null))
                    .filter(Boolean)
                )
              )
            : [];
          if (dataItemType) {
            try {
              blueprint = await findBestBlueprintForItem({
                dataItemType,
                channels: slotChannels,
              });
            } catch (err) {
              // Don't fail the whole generate call on a blueprint
              // lookup error — log + continue without it.
              req.log?.warn(
                { err: err?.message, dataItemType },
                "blueprint_lookup_failed"
              );
            }
          }
        }

        const systemPrompt = buildSystemPrompt(ctx);
        const safeImageContext = Array.isArray(imageContext)
          ? imageContext.slice(0, 8).map((img) => ({
              label: typeof img?.label === "string" ? img.label.slice(0, 30) : "other",
              description: typeof img?.description === "string" ? img.description.slice(0, 100) : "",
            }))
          : null;
        const userPrompt = buildCampaignUserPrompt(
          ctx,
          propertyData,
          campaignType,
          safeImageContext,
          slots,
          {
            sourceType,
            blueprint: blueprint
              ? {
                  name: blueprint.name,
                  category: blueprint.category,
                  promptTemplate: blueprint.promptTemplate,
                }
              : null,
          }
        );
        const responseFormat = buildCampaignResponseFormat();

        const result = await generateStructuredContent({
          systemPrompt,
          userPrompt,
          responseFormat,
          taskType: "campaign_generation",
          temperature: 0.7,
        });

        // Track usage
        if (req.user.id) {
          trackAiUsage({
            userId: req.user.id,
            clientId,
            actionType: "GENERATE_CAMPAIGN",
            model: result.model,
            promptTokens: result.usage?.prompt_tokens ?? 0,
            completionTokens: result.usage?.completion_tokens ?? 0,
          });
        }
        await incrementUsage(req.user.id, "posts");

        const campaignData = result.parsed;
        if (ctx.brandPersona?.status === "COMPLETED") {
          const { evaluateCampaignPostRecommendation } = await import("./personaRecommendation.service.js");
          campaignData.posts = campaignData.posts.map((post) => ({
            ...post,
            personaRecommendation: evaluateCampaignPostRecommendation(ctx.brandPersona, post),
          }));
        }

        req.log?.info({ clientId, postCount: campaignData?.posts?.length, campaignType }, "campaign_extraction_succeeded");
        res.json({
          dataItemId: resolvedDataItemId,
          campaign: campaignData,
        });
      } finally {
        await releaseDedup(dedupKey);
      }
    } catch (err) {
      req.log?.error({ clientId: req.params.id, userId: req.user?.id, campaignType, err: err?.message, code: err?.code }, "campaign_extraction_failed");
      next(err);
    }
  }
);

// ── Listing Campaign — Regenerate Single Post ─────────────────────────────

/**
 * POST /api/v1/workspaces/:id/listing-campaign/regenerate-post
 * Regenerate a single campaign post using the same property/campaign context.
 * Accepts: { propertyData, campaignType, slot: { channel, day, label, angle }, campaignSummary, imageContext }
 * Returns: { post: CampaignPost }
 */
studioRouter.post(
  `${BASE}/workspaces/:id/listing-campaign/regenerate-post`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const {
        propertyData,
        campaignType,
        slot,
        campaignSummary,
        imageContext,
        // Source attribution — added so per-post regen works for
        // content-asset and idea campaigns. Legacy callers without
        // these fields still get the prior property-only behavior
        // because sourceType defaults to 'property'.
        sourceType: rawSourceType,
        sourceTitle,
        sourceDataItemType,
        campaignIdea,
      } = req.body;
      if (!propertyData || typeof propertyData !== "object") {
        return validationError(res, [{ path: ["propertyData"], message: "Property data / post context is required" }]);
      }
      if (!slot || typeof slot !== "object" || !slot.channel || !slot.day || !slot.label) {
        return validationError(res, [{ path: ["slot"], message: "Slot with channel, day, and label is required" }]);
      }
      // Frontend synthesizes propertyData for non-property sources
      // (mirroring the save-drafts contract) so the existence check
      // above passes. sourceType tells the prompt builder how to
      // frame the context.
      const sourceType = ["property", "data_item", "idea"].includes(rawSourceType)
        ? rawSourceType
        : "property";
      void sourceTitle; // currently unused server-side; reserved for prompt enrichment
      void campaignIdea; // already carried inside propertyData.idea by the frontend

      // Service health pre-flight
      if (await getServiceStatus("openai") === "down") return sendError(res, 503, "SERVICE_UNAVAILABLE", "Content generation temporarily unavailable. Please try again in a few minutes.");
      if (await isProviderBudgetExceeded("openai")) return sendError(res, 503, "BUDGET_EXCEEDED", "AI text generation is temporarily unavailable due to budget limits. Please try again later.");

      // Usage limit check
      const allowed = await checkUsageLimit(req.user.id, "posts");
      if (!allowed) return sendError(res, 403, "USAGE_LIMIT", "You've reached your generation limit. Upgrade to generate more.");

      // Dedup
      const dedupKey = await acquireDedup(req.user.id, "regenerate-post", { ...propertyData, slot });
      if (!dedupKey) return sendError(res, 409, "DUPLICATE_REQUEST", "Post regeneration already in progress.");

      try {
        const clientId = req.params.id;

        // Load generation context
        const { loadClientGenerationContext } = await import("./generation/clientOrchestrator.js");
        const { buildSystemPrompt, buildRegeneratePostUserPrompt, buildRegeneratePostResponseFormat } = await import("./generation/promptBuilder.js");
        const { generateStructuredContent } = await import("./generation/openai.provider.js");
        const { findBestBlueprintForItem } = await import("./blueprint.service.js");

        const ctx = await loadClientGenerationContext(clientId);

        // Content-asset regens get a structural blueprint (same
        // logic as the initial generate route). Property and idea
        // regens don't — property has its built-in playbook; idea
        // campaigns don't have a matching data-item type.
        let blueprint = null;
        if (sourceType === "data_item") {
          const dataItemType =
            (typeof sourceDataItemType === "string" && sourceDataItemType) ||
            (typeof propertyData?._dataItemType === "string" ? propertyData._dataItemType : null);
          if (dataItemType) {
            try {
              blueprint = await findBestBlueprintForItem({
                dataItemType,
                channels: slot?.channel ? [slot.channel] : [],
              });
            } catch (err) {
              req.log?.warn(
                { err: err?.message, dataItemType },
                "blueprint_lookup_failed_in_regenerate"
              );
            }
          }
        }

        const systemPrompt = buildSystemPrompt(ctx);
        const safeImageContext = Array.isArray(imageContext)
          ? imageContext.slice(0, 8).map((img) => ({
              label: typeof img?.label === "string" ? img.label.slice(0, 30) : "other",
              description: typeof img?.description === "string" ? img.description.slice(0, 100) : "",
            }))
          : null;
        const userPrompt = buildRegeneratePostUserPrompt(
          ctx,
          propertyData,
          campaignType,
          slot,
          campaignSummary,
          safeImageContext,
          {
            sourceType,
            blueprint: blueprint
              ? {
                  name: blueprint.name,
                  category: blueprint.category,
                  promptTemplate: blueprint.promptTemplate,
                }
              : null,
          }
        );
        const responseFormat = buildRegeneratePostResponseFormat();

        const result = await generateStructuredContent({
          systemPrompt,
          userPrompt,
          responseFormat,
          taskType: "campaign_generation",
          temperature: 0.7,
        });

        // Track usage
        if (req.user.id) {
          trackAiUsage({
            userId: req.user.id,
            clientId,
            actionType: "REGENERATE_POST",
            model: result.model,
            promptTokens: result.usage?.prompt_tokens ?? 0,
            completionTokens: result.usage?.completion_tokens ?? 0,
          });
        }
        await incrementUsage(req.user.id, "posts");

        const postData = result.parsed?.post ?? result.parsed;
        if (ctx.brandPersona?.status === "COMPLETED") {
          const { evaluateCampaignPostRecommendation } = await import("./personaRecommendation.service.js");
          postData.personaRecommendation = evaluateCampaignPostRecommendation(ctx.brandPersona, postData);
        }

        res.json({ post: postData });
      } finally {
        await releaseDedup(dedupKey);
      }
    } catch (err) {
      next(err);
    }
  }
);

// ── Listing Campaign — Image Extraction ────────────────────────────────────

/**
 * POST /api/v1/workspaces/:id/listing-campaign/extract-image
 *
 * Replicate + SAM 2 based extraction (spinstr101). OpenAI is NOT used for
 * image region / bbox / gallery detection anymore. OpenAI Vision is still
 * used for extracting the TEXT listing fields (address, price, beds, etc.)
 * from the screenshot — that is a different job from image extraction.
 *
 * Pipeline:
 *   1) In parallel:
 *      a) SAM 2 on Replicate → individual_masks → bboxes → filter → rank
 *      b) OpenAI Vision (text-only prompt) → property fields
 *   2) Merge results, preserve the existing response shape so the frontend
 *      crop pipeline keeps working unchanged.
 */
studioRouter.post(
  `${BASE}/workspaces/:id/listing-campaign/extract-image`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const { image } = req.body;
      if (!image || typeof image !== "string") {
        return validationError(res, [{ path: ["image"], message: "Base64 image data URL is required" }]);
      }

      // Enhancement run usage limit check
      const enhQuotaErr = await enforceUsageLimit(req.user.id, "enhancementRuns");
      if (enhQuotaErr) return sendError(res, 402, enhQuotaErr.code, "Monthly enhancement limit reached. Upgrade your plan for more.", enhQuotaErr);

      const debug = String(req.query.debug ?? "") === "1";

      // Budget / health guards. OpenAI is gated for the text extractor; the
      // SAM 2 path only runs if Replicate is reachable.
      const openaiDown = (await getServiceStatus("openai")) === "down" || (await isProviderBudgetExceeded("openai"));
      const { extractListingScreenshot, emptyExtraction } = await import(
        "./segmentation/listingScreenshotExtraction.service.js"
      );
      const { extractFromImage } = await import("./generation/openai.provider.js");

      // ─── 1a. SAM 2 segmentation (primary image extractor) ─────────────
      const runSegmentation = extractListingScreenshot({ imageUrl: image, debug })
        .catch((err) => {
          req.log?.warn?.({ err }, "sam2 segmentation failed");
          return emptyExtraction({ reason: err?.code ?? "error" });
        });

      // ─── 1b. OpenAI Vision — TEXT FIELDS ONLY (no bbox work) ──────────
      const textPrompt = `You are extracting listing details from a real estate page screenshot. Return ONLY the text fields listed below as JSON. Do NOT return any bounding boxes, regions, or image locations.

Return this JSON exactly:
{
  "address": "Full street address or null",
  "price": number or null,
  "beds": number or null,
  "baths": number or null,
  "sqft": number or null,
  "propertyType": "Single Family | Condo | Townhouse | Multi-Family | Land | Commercial | Other or null",
  "description": "Brief property description or null",
  "highlights": "Comma-separated notable features or null",
  "neighborhood": "Neighborhood or area name or null",
  "cta": "Call-to-action text or null",
  "agentName": "Agent name or null",
  "brokerage": "Brokerage name or null"
}

If a field is not clearly visible on the page, return null for that field. Never fabricate.`;

      const runTextExtract = openaiDown
        ? Promise.resolve({ parsed: {}, model: null, usage: null, skipped: true })
        : extractFromImage({ base64: image, prompt: textPrompt }).catch((err) => {
            req.log?.warn?.({ err }, "openai text extraction failed");
            return { parsed: {}, model: null, usage: null, error: err?.message ?? String(err) };
          });

      const [segResult, textResult] = await Promise.all([runSegmentation, runTextExtract]);

      // Always log segmentation diagnostics so prod failures surface a reason
      // without needing ?debug=1 on the request.
      req.log?.info?.(
        {
          diagnostics: segResult?.diagnostics ?? null,
          detectedCount: segResult?.detectedCount ?? 0,
          heroFound: !!segResult?.heroImage,
          galleryCount: segResult?.galleryImages?.length ?? 0,
          textExtract: {
            skipped: !!textResult?.skipped,
            error: textResult?.error ?? null,
            model: textResult?.model ?? null,
          },
          imageKind: typeof image === "string"
            ? (image.startsWith("data:") ? "dataUrl" : "http")
            : "unknown",
          imageBytes: typeof image === "string" ? image.length : 0,
        },
        "listing extract-image complete",
      );

      // ─── 2. Merge ────────────────────────────────────────────────────
      const extracted = textResult?.parsed && typeof textResult.parsed === "object"
        ? textResult.parsed
        : {};
      const keyFields = ["address", "price", "beds", "baths", "sqft"];
      const filledKeys = keyFields.filter((k) => extracted[k] != null);
      const confidence = filledKeys.length >= 4 ? "full" : "partial";

      if (req.user?.id && textResult?.usage) {
        trackAiUsage({
          userId: req.user.id,
          clientId: req.params.id,
          actionType: "EXTRACT_IMAGE",
          model: textResult.model,
          promptTokens: textResult.usage?.prompt_tokens ?? 0,
          completionTokens: textResult.usage?.completion_tokens ?? 0,
        });
      }

      const responseBody = {
        extracted,
        confidence,
        galleryContainer: segResult.galleryContainer,
        heroImage: segResult.heroImage,
        galleryImages: segResult.galleryImages,
        imageRegions: segResult.imageRegions,
        detectedCount: segResult.detectedCount,
        extractionSource: segResult.extractionSource,
        // Always expose lightweight diagnostics so the frontend can display
        // a useful reason when no regions were detected.
        diagnostics: segResult.diagnostics ?? null,
        // Legacy fields kept null for backward-compat with the frontend.
        didSecondPass: false,
        suspicionReason: null,
      };

      if (debug) {
        responseBody.debug = {
          containerFound: !!segResult.galleryContainer,
          hero: !!segResult.heroImage,
          galleryTileCount: segResult.galleryImages.length,
          extractionSource: segResult.extractionSource,
          segmentation: segResult.debug ?? null,
          textExtract: {
            skipped: !!textResult?.skipped,
            error: textResult?.error ?? null,
            model: textResult?.model ?? null,
            usage: textResult?.usage ?? null,
          },
        };
      }

      await incrementUsage(req.user.id, "enhancementRuns");
      return res.json(responseBody);
    } catch (err) {
      next(err);
    }
  }
);


// ── Listing Campaign — Upload Selected Image Crops ────────────────────────

/**
 * POST /api/v1/workspaces/:id/listing-campaign/upload-images
 * Accept an array of selected image crops (base64 data URLs) from the client,
 * upload each to Cloudinary, and create MediaAsset records with source=IMPORTED.
 */
studioRouter.post(
  `${BASE}/workspaces/:id/listing-campaign/upload-images`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const { images, folderId } = req.body;
      if (!Array.isArray(images) || images.length === 0) {
        return validationError(res, [{ path: ["images"], message: "images array is required" }]);
      }
      if (images.length > 12) {
        return sendError(res, 400, "TOO_MANY_IMAGES", "Maximum 12 images per upload");
      }

      // Cross-workspace folder check.
      try {
        await assertFolderInClient(folderId ?? null, req.params.id);
      } catch (e) {
        return sendError(res, e.status ?? 404, e.code ?? "NOT_FOUND", e.message);
      }

      const { getImageStorageService } = await import("../../services/storage/imageStorage.js");
      const storage = getImageStorageService();

      const clientId = req.params.id;
      const userId = req.user.id;

      // Enforce image usage limit before uploading
      const quotaErr = await enforceUsageLimit(userId, "images");
      if (quotaErr) return sendError(res, 402, "IMAGE_LIMIT_EXCEEDED", "Monthly image limit reached. Upgrade your plan for more.", quotaErr);

      const uploaded = [];
      let runningBytes = 0;
      for (const img of images) {
        if (!img || typeof img !== "object") continue;
        const { dataUrl, label, caption, isEnhanced, qualityScore, qualityLabel } = img;
        if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) continue;

        // Parse data URL → buffer (we trust nothing about the declared mime,
        // we sniff the bytes below).
        const commaIdx = dataUrl.indexOf(",");
        if (commaIdx < 0) continue;
        const base64Data = dataUrl.slice(commaIdx + 1);
        const buffer = Buffer.from(base64Data, "base64");
        if (buffer.length === 0 || buffer.length > 15 * 1024 * 1024) continue; // 15MB cap

        // MIME sniff — never trust the data: URL's declared mime
        const mimeType = sniffImageMime(buffer);
        if (!mimeType) continue;

        // Storage gate per item — at 12×15MB this batch can be ~180MB and
        // the loop-level upstream check was missing entirely before.
        runningBytes += buffer.length;
        const storageOk = await checkStorageLimit(userId, runningBytes, false);
        if (!storageOk.allowed) {
          return sendError(
            res,
            402,
            "STORAGE_LIMIT",
            storageOk.reason,
            { current: storageOk.current, limit: storageOk.limit, uploadedSoFar: uploaded.length }
          );
        }

        // Validate + sanitize enhancement metadata (spinstr97)
        const safeIsEnhanced = isEnhanced === true;
        const safeQualityScore = typeof qualityScore === "number" && Number.isFinite(qualityScore)
          ? Math.max(0, Math.min(100, qualityScore))
          : null;
        const safeQualityLabel = ["good", "fair", "low"].includes(qualityLabel) ? qualityLabel : null;

        try {
          const result = await storage.upload(buffer, {
            folder: `squadpitch/listing-campaigns/${clientId}`,
          });
          const asset = await prisma.mediaAsset.create({
            data: {
              clientId,
              source: "IMPORTED",
              status: "READY",
              url: result.url,
              publicId: result.publicId,
              width: result.width ?? null,
              height: result.height ?? null,
              bytes: result.bytes ?? buffer.length,
              mimeType,
              assetType: "image",
              filename: typeof label === "string" && label
                ? `listing-${label}${safeIsEnhanced ? "-enhanced" : ""}.${result.format ?? "jpg"}`
                : `listing-image${safeIsEnhanced ? "-enhanced" : ""}.${result.format ?? "jpg"}`,
              altText: typeof caption === "string" ? caption.slice(0, 200) : null,
              caption: typeof label === "string" ? label.slice(0, 50) : null,
              isEnhanced: safeIsEnhanced,
              qualityScore: safeQualityScore,
              qualityLabel: safeQualityLabel,
              createdBy: userId,
              ...(typeof folderId === "string" && folderId ? { folderId } : {}),
            },
          });
          await incrementUsage(userId, "images");
          uploaded.push({
            id: asset.id,
            url: asset.url,
            label: asset.caption,
            description: asset.altText,
            width: asset.width,
            height: asset.height,
            isEnhanced: asset.isEnhanced,
            qualityScore: asset.qualityScore,
            qualityLabel: asset.qualityLabel,
          });
        } catch (err) {
          console.error("[upload-images] Cloudinary upload failed:", err?.message ?? err);
          // Continue with other images — best effort (do NOT block flow if enhancement or upload fails)
        }
      }

      if (uploaded.length === 0) {
        return sendError(res, 502, "UPLOAD_FAILED", "Could not upload any of the selected images");
      }

      res.json({ assets: uploaded });
    } catch (err) {
      next(err);
    }
  }
);

// ── Listing Campaign — Save Drafts ────────────────────────────────────────

/**
 * POST /api/v1/workspaces/:id/listing-campaign/save-drafts
 * Save multi-post campaign as Draft records with campaign fields.
 * Accepts schedule preset (7/10/14 days) for automatic date spacing.
 */
studioRouter.post(
  `${BASE}/workspaces/:id/listing-campaign/save-drafts`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const {
        campaign,
        propertyData,
        campaignType,
        dataItemId,
        schedulePreset,
        addToPlanner,
        mediaAssetIds,
        startDate,
        slots,
        // Source attribution — added so the route can build a
        // source-aware campaign name and persist source metadata
        // for Planner. Legacy callers without these fields still
        // get the prior property-style name.
        sourceType: rawSourceType,
        sourceTitle,
        sourceDataItemType,
        campaignIdea,
      } = req.body;
      if (!campaign || !Array.isArray(campaign.posts) || campaign.posts.length === 0) {
        return validationError(res, [{ path: ["campaign"], message: "Campaign with posts array is required" }]);
      }

      const clientId = req.params.id;

      // Validate that any supplied mediaAssetIds belong to this workspace
      let validAssetIds = [];
      if (Array.isArray(mediaAssetIds) && mediaAssetIds.length > 0) {
        const assets = await prisma.mediaAsset.findMany({
          where: { id: { in: mediaAssetIds.slice(0, 12) }, clientId },
          select: { id: true },
        });
        validAssetIds = assets.map((a) => a.id);
      }

      // Build a source-aware campaign name.
      //
      //   property   → "508 King George Court — just listed"
      //   data_item  → "Spring buyer guide — promotion offer"
      //   idea       → "Promote our spring offer — lead generation"
      //                  (idea snippet ≤60 chars), or fall back to
      //                  "Custom — lead generation" when no idea text.
      const sourceType = ["property", "data_item", "idea"].includes(rawSourceType)
        ? rawSourceType
        : "property";
      const campaignTypeLabel = (campaignType || (sourceType === "property" ? "just_listed" : "general"))
        .replace(/_/g, " ");
      const truncate = (s, n) => (s && s.length > n ? `${s.slice(0, n - 1)}…` : s);
      let campaignNameRoot;
      if (sourceType === "property") {
        campaignNameRoot = propertyData?.address || propertyData?.title || sourceTitle || "Listing";
      } else if (sourceType === "data_item") {
        campaignNameRoot = sourceTitle || propertyData?.title || "Content asset";
      } else {
        // idea
        const ideaSnippet = typeof campaignIdea === "string" ? truncate(campaignIdea.trim(), 60) : null;
        campaignNameRoot = ideaSnippet || "Custom";
      }
      // Campaign id — we let Prisma generate a cuid via the model's
      // implicit string PK so new campaigns get the same id shape as
      // every other Squadpitch entity. Legacy `camp_<ts>_<rand>` ids
      // from before the Campaign model existed are preserved via
      // the backfill script and remain valid (Campaign.id is just
      // TEXT — either format coexists).
      const campaignName = campaign.campaignName || `${campaignNameRoot} — ${campaignTypeLabel}`;
      const totalPosts = campaign.posts.length;

      // Source attribution stored on each Draft's `warnings` array
      // (existing pattern — free-form `key:value` tags). The Planner
      // / Dashboard already reads `warnings` for source labels; this
      // keeps schema unchanged while making non-property campaigns
      // legible.
      const warnings = [
        `source:${sourceType}`,
        `campaignType:${campaignType || "just_listed"}`,
        `campaignNameRoot:${campaignNameRoot}`,
      ];
      if (sourceType === "property" && propertyData?.address) {
        warnings.push(`address:${propertyData.address}`);
      }
      if (sourceTitle) warnings.push(`sourceTitle:${truncate(sourceTitle, 120)}`);
      if (sourceDataItemType) warnings.push(`sourceDataItemType:${sourceDataItemType}`);
      if (sourceType === "idea" && typeof campaignIdea === "string" && campaignIdea.trim()) {
        warnings.push(`campaignIdea:${truncate(campaignIdea.trim(), 200)}`);
      }
      if (dataItemId) warnings.push(`dataItemId:${dataItemId}`);

      // ── Scheduling preferences (Plan 10 enforcement) ──────────────
      //
      // Resolve workspace-level scheduling defaults server-side so
      // the client can't lie about its own preferences. Loaded in
      // parallel and used to:
      //   - anchor each post at the user's preferredPostingTime
      //     converted from Client.timezone to UTC (instead of the
      //     legacy 10:00 UTC hardcode)
      //   - bump each scheduled date forward to the next allowed
      //     posting day when preferredPostingDays is set
      //   - drive the alwaysRequireReview status mapping (see below)
      //
      // Any of these can be unset; missing fields fall through to
      // the prior 10:00 UTC / no-bump / no-review-required behavior.
      const [contentPrefs, clientTimezone] = await Promise.all([
        getContentPreferences(clientId).catch(() => null),
        getClientTimezone(clientId).catch(() => 'UTC'),
      ]);
      const preferredPostingTime = contentPrefs?.preferredPostingTime || null;
      const preferredPostingDays = Array.isArray(contentPrefs?.preferredPostingDays)
        ? contentPrefs.preferredPostingDays
        : [];
      const alwaysRequireReview = contentPrefs?.alwaysRequireReview !== false;

      // Schedule spacing: map each post's campaignDay to a real
      // datetime. The campaignStartDate confirmed by the user in the
      // schedule-review step anchors day 1 — without it, posts used
      // to silently anchor to "today + 1 day" regardless of what the
      // schedule UI showed. When startDate is absent (legacy callers,
      // ad-hoc generation paths) we fall back to today so existing
      // behaviour is preserved.
      const presetDays = schedulePreset === 14 ? 14 : schedulePreset === 10 ? 10 : 7;
      const maxCampaignDay = Math.max(...campaign.posts.map((p) => p.campaignDay || 1));

      // Anchor a campaign day at the user's preferredPostingTime in
      // Client.timezone when both are set; otherwise fall back to
      // the legacy 10:00 UTC behavior. We compute the anchor by
      // converting `startDate` + `preferredPostingTime` from the
      // workspace timezone to UTC.
      const anchorLocalDate =
        typeof startDate === "string" && /^\d{4}-\d{2}-\d{2}$/.test(startDate)
          ? startDate
          : null;
      function resolveAnchor() {
        if (anchorLocalDate && preferredPostingTime) {
          const utc = zonedLocalToUtc(
            anchorLocalDate,
            preferredPostingTime,
            clientTimezone,
          );
          if (utc) return utc;
        }
        if (anchorLocalDate) {
          // Legacy fallback: parse startDate as 10:00 UTC, same as
          // before the Plan 10 changes.
          const parsed = new Date(`${anchorLocalDate}T10:00:00Z`);
          if (!Number.isNaN(parsed.getTime())) return parsed;
        }
        const fallback = new Date(Date.now() + 24 * 60 * 60 * 1000);
        fallback.setUTCHours(10, 0, 0, 0);
        return fallback;
      }
      const scheduleAnchor = resolveAnchor();

      function computeScheduledDate(campaignDay) {
        if (!addToPlanner) return null;
        // Scale campaign days to fit within the preset window
        const dayOffset = maxCampaignDay > 1
          ? Math.round(((campaignDay - 1) / (maxCampaignDay - 1)) * (presetDays - 1))
          : 0;
        // Anchor day 1 at the user's confirmed start date. Day N
        // lands `dayOffset` days after that.
        let date = new Date(scheduleAnchor.getTime() + dayOffset * 24 * 60 * 60 * 1000);
        // Apply day-of-week bump if the user has restricted posting
        // days. Day-of-week is evaluated in the workspace timezone
        // so a "Mon/Wed/Fri" rule actually lines up with the
        // calendar the user sees.
        if (preferredPostingDays.length > 0) {
          date = bumpToNextAllowedDay(date, preferredPostingDays, clientTimezone);
        }
        return date;
      }
      // Acknowledge `slots` so eslint / linters don't flag the
      // unused destructured field. The current scheduler keys off
      // campaignDay only; slot ordering is implicit in the per-post
      // campaignDay sent up by the review card.
      void slots;

      // Status mapping (Plan 10):
      //   addToPlanner=true  → explicit Approve & Schedule. Always
      //                        proceeds to SCHEDULED — the user
      //                        clicking that button counts as
      //                        review.
      //   addToPlanner=false → "Save as Drafts". If the workspace
      //                        has alwaysRequireReview set (the
      //                        default), use PENDING_REVIEW so the
      //                        Planner's "Needs Review" chip lights
      //                        up. Otherwise fall back to DRAFT for
      //                        workspaces that opted out of the
      //                        review gate.
      const draftStatusForUnscheduled = alwaysRequireReview ? "PENDING_REVIEW" : "DRAFT";

      // Pre-compute each draft's scheduledFor up front so the
      // Campaign row can record the actual schedule envelope
      // (startsAt = earliest, endsAt = latest). Without this we'd
      // have to use the stale scheduleAnchor, which doesn't account
      // for the per-slot day-of-week bump from preferredPostingDays.
      const scheduledForByIdx = campaign.posts.map((post, idx) =>
        computeScheduledDate(post.campaignDay || idx + 1),
      );
      const scheduledDates = scheduledForByIdx.filter((d) => d != null);
      const campaignStartsAt = scheduledDates.length > 0
        ? new Date(Math.min(...scheduledDates.map((d) => d.getTime())))
        : null;
      const campaignEndsAt = scheduledDates.length > 0
        ? new Date(Math.max(...scheduledDates.map((d) => d.getTime())))
        : null;

      // Promote Campaign to a first-class row before the draft
      // batch lands. New campaigns receive a cuid via Prisma; the
      // existing `Draft.warnings` source tags are still written
      // (back-compat) so any reader that hasn't migrated to
      // Campaign.sourceType/etc. keeps working.
      const campaignRow = await prisma.campaign.create({
        data: {
          // id omitted — Prisma generates a cuid via the model's
          // @default(cuid()). Backfill rows pass an explicit id to
          // preserve legacy `camp_<ts>_<rand>` strings.
          clientId,
          name: campaignName,
          campaignType: campaignType || "just_listed",
          sourceType,
          sourceDataItemId: sourceType === "data_item" ? dataItemId ?? null : (sourceType === "property" ? dataItemId ?? null : null),
          sourceTitle:
            sourceType === "property"
              ? propertyData?.address ?? propertyData?.title ?? sourceTitle ?? null
              : sourceType === "data_item"
                ? sourceTitle ?? null
                : null,
          campaignIdea:
            sourceType === "idea" && typeof campaignIdea === "string"
              ? campaignIdea.trim() || null
              : null,
          status: initialCampaignStatus({ addToPlanner, alwaysRequireReview }),
          startsAt: campaignStartsAt,
          endsAt: campaignEndsAt,
          createdBy: req.user.id,
        },
      });
      const campaignId = campaignRow.id;

      const drafts = await Promise.all(
        campaign.posts.map((post, idx) => {
          const scheduledFor = scheduledForByIdx[idx];
          return prisma.draft.create({
            data: {
              clientId,
              kind: "POST",
              status: addToPlanner ? "SCHEDULED" : draftStatusForUnscheduled,
              channel: post.channel || "INSTAGRAM",
              generationGuidance: `${campaignName} — ${post.label || `Post ${idx + 1}`}`,
              body: post.body || "",
              hooks: [],
              hashtags: post.hashtags || [],
              cta: post.cta || null,
              // Persist bodyAlt, subject, hookScore, imageHint, slotType in
              // the variations JSON so they survive save/reload. The Draft
              // schema uses variations as free-form extension storage.
              variations: {
                ...(post.bodyAlt ? { bodyAlt: post.bodyAlt } : {}),
                ...(post.subject ? { subject: post.subject } : {}),
                ...(post.hookScore != null ? { hookScore: post.hookScore } : {}),
                ...(post.imageHint ? { imageHint: post.imageHint } : {}),
                ...(post.slotType ? { slotType: post.slotType } : {}),
              },
              warnings: [...warnings, `angle:${post.angle || "promotional"}`],
              createdBy: req.user.id,
              // Campaign fields
              campaignId,
              campaignName,
              campaignType: campaignType || "just_listed",
              campaignDay: post.campaignDay || idx + 1,
              campaignOrder: idx + 1,
              campaignTotal: totalPosts,
              ...(scheduledFor ? { scheduledFor } : {}),
            },
          });
        })
      );

      // Link selected media assets to each draft (one DraftAsset per asset per draft).
      // If a post has per-post `assignedImageIds`, use only those assets.
      // Otherwise fall back to linking all `mediaAssetIds` (backward compat).
      if (validAssetIds.length > 0) {
        const validAssetIdSet = new Set(validAssetIds);
        const draftAssetRows = [];
        for (let dIdx = 0; dIdx < drafts.length; dIdx += 1) {
          const draft = drafts[dIdx];
          const post = campaign.posts[dIdx];
          console.log('[MEDIA SAVE] campaign post assignedImageIds', post?.assignedImageIds);
          // Per-post assigned images take priority
          const perPost = Array.isArray(post?.assignedImageIds) && post.assignedImageIds.length > 0
            ? post.assignedImageIds.filter((id) => validAssetIdSet.has(id))
            : null;
          const idsForThisDraft = perPost || validAssetIds;
          for (let i = 0; i < idsForThisDraft.length; i += 1) {
            draftAssetRows.push({
              draftId: draft.id,
              assetId: idsForThisDraft[i],
              role: i === 0 ? "primary" : null,
              orderIndex: i,
            });
          }
        }
        if (draftAssetRows.length > 0) {
          await prisma.draftAsset.createMany({ data: draftAssetRows, skipDuplicates: true });
        }

        // Hydrate each draft's mediaUrl from its primary asset so downstream
        // views (Content Library, Planner) show the image without joining DraftAsset.
        const primaryByDraft = new Map();
        for (const row of draftAssetRows) {
          if (row.role === "primary") primaryByDraft.set(row.draftId, row.assetId);
        }
        if (primaryByDraft.size > 0) {
          const assets = await prisma.mediaAsset.findMany({
            where: { id: { in: Array.from(primaryByDraft.values()) } },
            select: { id: true, url: true, assetType: true },
          });
          const assetUrlMap = new Map();
          for (const a of assets) assetUrlMap.set(a.id, { url: a.url, type: a.assetType });
          const updates = [];
          for (const [draftId, assetId] of primaryByDraft.entries()) {
            const info = assetUrlMap.get(assetId);
            if (info?.url) {
              updates.push(
                prisma.draft.update({
                  where: { id: draftId },
                  data: { mediaUrl: info.url, mediaType: info.type || "image" },
                })
              );
              // Update the in-memory draft so the response includes mediaUrl
              const draftObj = drafts.find((d) => d.id === draftId);
              if (draftObj) {
                draftObj.mediaUrl = info.url;
                draftObj.mediaType = info.type || "image";
              }
            }
          }
          if (updates.length > 0) await Promise.all(updates);
        }
      }

      // Log final media state for each draft
      for (const d of drafts) {
        console.log('[MEDIA SAVE] campaign draft mediaUrl', d.id, d.mediaUrl);
      }
      res.json({ drafts, campaignId, campaignName, attachedAssetCount: validAssetIds.length });
    } catch (err) {
      next(err);
    }
  }
);

// ── Google Business Profile Integration ───────────────────────────────────

/**
 * POST /api/v1/workspaces/:id/integrations/gbp/connect
 * Start GBP OAuth flow. Returns { authUrl }.
 */
studioRouter.post(
  `${BASE}/workspaces/:id/integrations/gbp/connect`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const nonce = crypto.randomBytes(16).toString("hex");
      const key = `sp:gbp-oauth:${nonce}`;
      await redisSet(key, JSON.stringify({ clientId: req.params.id, userId: req.user.id }), 600);

      const authUrl = gbpProvider.getAuthUrl(nonce);
      res.json({ authUrl });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/workspaces/:id/integrations/gbp/callback
 * Complete GBP OAuth. Body: { code, state }.
 */
studioRouter.post(
  `${BASE}/workspaces/:id/integrations/gbp/callback`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = GBPCallbackSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      const { code, state } = parsed.data;

      // Consume OAuth state
      const key = `sp:gbp-oauth:${state}`;
      const raw = await redisGet(key);
      if (!raw) return sendError(res, 400, "INVALID_STATE", "Invalid or expired OAuth state");

      const stateData = JSON.parse(raw);
      if (stateData.userId !== req.user.id) {
        return sendError(res, 403, "STATE_MISMATCH", "OAuth state user mismatch");
      }

      await redisDel(key);

      // Exchange code for tokens
      const tokens = await gbpProvider.exchangeCode(code);

      // List accounts to help user pick location
      const tempConfig = { accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
      let accounts = [];
      let locations = [];
      try {
        accounts = await gbpProvider.listAccounts(tempConfig);
        if (accounts.length > 0) {
          locations = await gbpProvider.listLocations(tempConfig, accounts[0].name);
        }
      } catch {
        // OAuth succeeded but listing failed — still save tokens
      }

      // Save connection with tokens.
      // Need at least one account+location to be fully connected.
      // 0 accounts or 0 locations → connected but incomplete (sync will auto-discover)
      // 1 location → auto-connect
      // 2+ locations → pending (user must pick)
      const hasAccount = accounts.length > 0;
      const autoConnect = hasAccount && locations.length <= 1;
      const needsPick = hasAccount && locations.length > 1;
      const status = needsPick ? "pending" : autoConnect ? "connected" : "connected";

      await upsertWorkspaceTechStackConnection(req.params.id, "google_business_profile",
        status,
        {
          metadataJson: {
            accessToken: tokens.accessToken,
            refreshToken: tokens.refreshToken,
            email: tokens.email,
            accountId: accounts[0]?.name || null,
            locationId: autoConnect && locations[0] ? locations[0].name : null,
            locationName: autoConnect && locations[0] ? locations[0].title : null,
          },
        }
      );

      invalidateClientContext(req.params.id).catch(() => {});

      res.json({
        connected: true,
        email: tokens.email,
        accounts,
        locations,
        needsLocationSelection: needsPick,
      });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/workspaces/:id/integrations/gbp/set-location
 * Set the GBP location after OAuth if multiple locations exist.
 */
studioRouter.post(
  `${BASE}/workspaces/:id/integrations/gbp/set-location`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = GBPSetLocationSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      const connection = await prisma.workspaceTechStackConnection.findUnique({
        where: { workspaceId_providerKey: { workspaceId: req.params.id, providerKey: "google_business_profile" } },
      });

      if (!connection) return sendError(res, 404, "NOT_FOUND", "GBP connection not found");

      await prisma.workspaceTechStackConnection.update({
        where: { id: connection.id },
        data: {
          connectionStatus: "connected",
          metadataJson: {
            ...(connection.metadataJson || {}),
            accountId: parsed.data.accountId,
            locationId: parsed.data.locationId,
            locationName: parsed.data.locationName || null,
          },
        },
      });

      invalidateClientContext(req.params.id).catch(() => {});
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/workspaces/:id/integrations/gbp/sync
 * Trigger a GBP sync (reviews + business info).
 */
studioRouter.post(
  `${BASE}/workspaces/:id/integrations/gbp/sync`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const result = await syncGBP(req.params.id);

      // Fire-and-forget: run autopilot if new reviews imported
      if (result.reviewsImported > 0) {
        runAutopilot(req.params.id).catch(() => {});
      }

      invalidateClientContext(req.params.id).catch(() => {});
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * DELETE /api/v1/workspaces/:id/integrations/gbp/disconnect
 * Disconnect GBP integration.
 */
studioRouter.delete(
  `${BASE}/workspaces/:id/integrations/gbp/disconnect`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      await upsertWorkspaceTechStackConnection(req.params.id, "google_business_profile", "not_connected", {
        metadataJson: {},
      });
      invalidateClientContext(req.params.id).catch(() => {});
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/workspaces/:id/integrations/gbp/reviews
 * Get stored GBP reviews from WorkspaceDataItems (no API call).
 */
studioRouter.get(
  `${BASE}/workspaces/:id/integrations/gbp/reviews`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const result = await getGBPReviews(req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/workspaces/:id/integrations/gbp/profile
 * Get stored GBP business profile from connection metadata.
 */
studioRouter.get(
  `${BASE}/workspaces/:id/integrations/gbp/profile`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const profile = await getGBPBusinessProfile(req.params.id);
      if (!profile) return sendError(res, 404, "NOT_FOUND", "GBP not connected");
      res.json(profile);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/workspaces/:id/integrations/gbp/reply
 * Reply to a GBP review. Body: { reviewId, replyText }.
 */
studioRouter.post(
  `${BASE}/workspaces/:id/integrations/gbp/reply`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = GBPReplySchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      const connection = await prisma.workspaceTechStackConnection.findUnique({
        where: { workspaceId_providerKey: { workspaceId: req.params.id, providerKey: "google_business_profile" } },
      });
      if (!connection || connection.connectionStatus !== "connected") {
        return sendError(res, 400, "NOT_CONNECTED", "GBP not connected");
      }

      const config = connection.metadataJson || {};
      const result = await gbpProvider.replyToReview(
        config, config.accountId, config.locationId,
        parsed.data.reviewId, parsed.data.replyText
      );

      res.json({ ok: true, reply: result });
    } catch (err) {
      if (err.permanent) {
        return sendError(res, 401, "TOKEN_EXPIRED", err.message);
      }
      next(err);
    }
  }
);

/**
 * POST /api/v1/workspaces/:id/integrations/gbp/post
 * Create a GBP local post. Body: { summary, callToAction? }.
 */
studioRouter.post(
  `${BASE}/workspaces/:id/integrations/gbp/post`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = GBPPostSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      const connection = await prisma.workspaceTechStackConnection.findUnique({
        where: { workspaceId_providerKey: { workspaceId: req.params.id, providerKey: "google_business_profile" } },
      });
      if (!connection || connection.connectionStatus !== "connected") {
        return sendError(res, 400, "NOT_CONNECTED", "GBP not connected");
      }

      const config = connection.metadataJson || {};
      const result = await gbpProvider.createLocalPost(
        config, config.accountId, config.locationId,
        parsed.data
      );

      res.json({ ok: true, post: result });
    } catch (err) {
      if (err.permanent) {
        return sendError(res, 401, "TOKEN_EXPIRED", err.message);
      }
      next(err);
    }
  }
);

/**
 * GET /api/v1/workspaces/:id/integrations/gbp/insights
 * Returns aggregate review insights from connection metadata.
 */
studioRouter.get(
  `${BASE}/workspaces/:id/integrations/gbp/insights`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const insights = await getGBPInsights(req.params.id);
      if (!insights) return sendError(res, 404, "NOT_FOUND", "No review insights available");
      res.json(insights);
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/workspaces/:id/integrations/gbp/analyze
 * Triggers on-demand re-analysis of all GBP reviews.
 */
studioRouter.post(
  `${BASE}/workspaces/:id/integrations/gbp/analyze`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const result = await reanalyzeAllReviews(req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── CRM Integration (Follow Up Boss) ─────────────────────────────────────

/**
 * POST /api/v1/workspaces/:id/integrations/crm/connect
 * Connect CRM with API key. Body: { apiKey }.
 */
studioRouter.post(
  `${BASE}/workspaces/:id/integrations/crm/connect`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = CRMConnectSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      // Validate the API key
      const validation = await fubProvider.validateApiKey(parsed.data.apiKey);
      if (!validation.valid) {
        return sendError(res, 400, "INVALID_API_KEY", validation.error || "Invalid API key");
      }

      // Encrypt and store
      const encryptedKey = fubProvider.encryptApiKey(parsed.data.apiKey);

      await upsertWorkspaceTechStackConnection(req.params.id, "real_estate_crm", "connected", {
        metadataJson: {
          apiKey: encryptedKey,
          provider: "follow_up_boss",
          userName: validation.userName,
          connectedAt: new Date().toISOString(),
        },
      });

      invalidateClientContext(req.params.id).catch(() => {});
      res.json({ connected: true, userName: validation.userName });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * POST /api/v1/workspaces/:id/integrations/crm/sync
 * Trigger a CRM sync (deals + contacts + notes).
 */
studioRouter.post(
  `${BASE}/workspaces/:id/integrations/crm/sync`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const result = await syncCRM(req.params.id);

      // Fire-and-forget: run autopilot if new content signals found
      if (result.milestonesImported > 0 || result.testimonialsImported > 0) {
        runAutopilot(req.params.id).catch(() => {});
      }

      invalidateClientContext(req.params.id).catch(() => {});
      res.json(result);
    } catch (err) {
      // Token decryption failures mean the key needs to be re-entered
      if (err.code === "TOKEN_DECRYPT_MALFORMED" || err.message?.includes("Malformed encrypted token")) {
        return sendError(res, 400, "INVALID_KEY", "CRM API key is invalid — please reconnect your CRM.");
      }
      next(err);
    }
  }
);

/**
 * DELETE /api/v1/workspaces/:id/integrations/crm/disconnect
 * Disconnect CRM integration.
 */
studioRouter.delete(
  `${BASE}/workspaces/:id/integrations/crm/disconnect`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      await upsertWorkspaceTechStackConnection(req.params.id, "real_estate_crm", "not_connected", {
        metadataJson: {},
      });
      invalidateClientContext(req.params.id).catch(() => {});
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

/**
 * GET /api/v1/workspaces/:id/integrations/status
 * Get connection status for GBP + CRM.
 */
studioRouter.get(
  `${BASE}/workspaces/:id/integrations/status`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const [gbp, crm] = await Promise.all([
        prisma.workspaceTechStackConnection.findUnique({
          where: { workspaceId_providerKey: { workspaceId: req.params.id, providerKey: "google_business_profile" } },
        }),
        prisma.workspaceTechStackConnection.findUnique({
          where: { workspaceId_providerKey: { workspaceId: req.params.id, providerKey: "real_estate_crm" } },
        }),
      ]);

      res.json({
        gbp: gbp ? {
          status: gbp.connectionStatus,
          email: gbp.metadataJson?.email || null,
          locationName: gbp.metadataJson?.locationName || null,
          businessName: gbp.metadataJson?.businessName || null,
          lastSyncedAt: gbp.metadataJson?.lastSyncedAt || null,
          reviewCount: gbp.metadataJson?.reviewCount || 0,
          averageRating: gbp.metadataJson?.averageRating || null,
          unrepliedReviewCount: gbp.metadataJson?.unrepliedReviewCount || 0,
          lastError: gbp.lastError,
        } : { status: "not_connected" },
        crm: crm ? {
          status: crm.connectionStatus,
          provider: crm.metadataJson?.provider || null,
          userName: crm.metadataJson?.userName || null,
          lastSyncedAt: crm.metadataJson?.lastSyncedAt || null,
          dealCount: crm.metadataJson?.dealCount || 0,
          contactCount: crm.metadataJson?.contactCount || 0,
          lastError: crm.lastError,
        } : { status: "not_connected" },
      });
    } catch (err) {
      next(err);
    }
  }
);

// ── Integration Requests ──────────────────────────────────────────────────

/**
 * POST /api/v1/workspaces/:id/integrations/request
 * Record a request for a coming-soon integration. One per workspace per provider.
 */
studioRouter.post(
  `${BASE}/workspaces/:id/integrations/request`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const { providerKey, providerLabel } = req.body;
      if (!providerKey || typeof providerKey !== "string") {
        return validationError(res, [{ path: ["providerKey"], message: "providerKey is required" }]);
      }

      const clientId = req.params.id;

      // Check for existing request to prevent duplicates
      const existing = await prisma.workspaceTechStackConnection.findUnique({
        where: { workspaceId_providerKey: { workspaceId: clientId, providerKey } },
      });

      if (existing && existing.connectionStatus === "requested") {
        return res.json({ alreadyRequested: true });
      }

      // Only allow requests for non-connected providers
      if (existing && existing.connectionStatus === "connected") {
        return res.json({ alreadyConnected: true });
      }

      await upsertWorkspaceTechStackConnection(clientId, providerKey, "requested", {
        metadataJson: {
          providerLabel: providerLabel || providerKey,
          requestedAt: new Date().toISOString(),
          requestedBy: getAuth0Sub(req),
          source: "crm_integration_request",
        },
      });

      res.json({ requested: true });
    } catch (err) {
      next(err);
    }
  }
);

// ── Listing Feeds (multi-source) ────────────────────────────────────────

/** GET /api/v1/workspaces/:id/listing-feeds — list all listing sources */
studioRouter.get(
  `${BASE}/workspaces/:id/listing-feeds`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const sources = await listingFeedService.getListingSources(req.params.id);
      const stats = await listingFeedService.getListingFeedStats(req.params.id);
      res.json({ sources, stats });
    } catch (err) {
      next(err);
    }
  }
);

/** POST /api/v1/workspaces/:id/listing-feeds — create a new listing source */
studioRouter.post(
  `${BASE}/workspaces/:id/listing-feeds`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = CreateListingSourceSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const source = await listingFeedService.createListingSource(req.params.id, parsed.data);
      res.status(201).json(source);
    } catch (err) {
      next(err);
    }
  }
);

/** PATCH /api/v1/workspaces/:id/listing-feeds/:sourceId — update a listing source */
studioRouter.patch(
  `${BASE}/workspaces/:id/listing-feeds/:sourceId`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const parsed = UpdateListingSourceSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);
      const source = await listingFeedService.updateListingSource(req.params.id, req.params.sourceId, parsed.data);
      res.json(source);
    } catch (err) {
      next(err);
    }
  }
);

/** POST /api/v1/workspaces/:id/listing-feeds/:sourceId/sync — sync a URL listing source */
studioRouter.post(
  `${BASE}/workspaces/:id/listing-feeds/:sourceId/sync`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const result = await listingFeedService.syncListingSource(req.params.id, req.params.sourceId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

/** DELETE /api/v1/workspaces/:id/listing-feeds/:sourceId — remove a listing source */
studioRouter.delete(
  `${BASE}/workspaces/:id/listing-feeds/:sourceId`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const result = await listingFeedService.removeListingSource(req.params.id, req.params.sourceId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── Listing Enrichment ───────────────────────────────────────────────────

/** POST /api/v1/workspaces/:id/listings/:listingId/enrich — enrich a single listing */
studioRouter.post(
  `${BASE}/workspaces/:id/listings/:listingId/enrich`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const result = await enrichListingById(req.params.id, req.params.listingId);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

/** POST /api/v1/workspaces/:id/listings/enrich-all — bulk enrich (up to 20, fire-and-forget) */
studioRouter.post(
  `${BASE}/workspaces/:id/listings/enrich-all`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const result = await enrichAllListings(req.params.id, 20);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── Listing Events ───────────────────────────────────────────────────────

/** GET /api/v1/workspaces/:id/listings/:listingId/events — get listing events */
studioRouter.get(
  `${BASE}/workspaces/:id/listings/:listingId/events`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const item = await prisma.workspaceDataItem.findFirst({
        where: { id: req.params.listingId, clientId: req.params.id, status: "ACTIVE" },
        select: { dataJson: true },
      });
      if (!item) return res.status(404).json({ error: "Listing not found" });
      const events = getEvents(item.dataJson, req.query.type || null);
      res.json({ events });
    } catch (err) {
      next(err);
    }
  }
);

/** POST /api/v1/workspaces/:id/listings/evaluate-events — run stale/unpromoted scan */
studioRouter.post(
  `${BASE}/workspaces/:id/listings/evaluate-events`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const result = await evaluateStaleListings(req.params.id);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── Listing Simulator (dev only) ─────────────────────────────────────────

/** POST /api/v1/workspaces/:id/dev/listings/simulate — create N sample listings */
studioRouter.post(
  `${BASE}/workspaces/:id/dev/listings/simulate`,
  requireClientOwner,
  async (req, res, next) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(403).json({ error: "Simulator disabled in production" });
    }
    try {
      const { count = 5, options = {} } = req.body || {};
      const result = await generateSampleListings(req.params.id, count, options);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

/** POST /api/v1/workspaces/:id/dev/listings/:listingId/simulate-event — simulate lifecycle event */
studioRouter.post(
  `${BASE}/workspaces/:id/dev/listings/:listingId/simulate-event`,
  requireClientOwner,
  async (req, res, next) => {
    if (process.env.NODE_ENV === "production") {
      return res.status(403).json({ error: "Simulator disabled in production" });
    }
    try {
      const { event, data = {} } = req.body || {};
      if (!event) return res.status(400).json({ error: "Missing 'event' field" });
      const result = await simulateListingEvent(req.params.id, req.params.listingId, event, data);
      res.json(result);
    } catch (err) {
      next(err);
    }
  }
);

// ── Property Data ─────────────────────────────────────────────────────────

/** GET /api/v1/workspaces/:id/property-data/lookup?address=... */
studioRouter.get(
  `${BASE}/workspaces/:id/property-data/lookup`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const { address } = req.query;
      if (!address) return sendError(res, 400, "MISSING_PARAM", "address query param required");
      if (propertyDataService.getActivePropertyDataProviderName() === "none") {
        return sendError(res, 503, "PROVIDER_UNAVAILABLE", "No property data provider configured");
      }
      const result = await propertyDataService.lookupProperty(address);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

/** GET /api/v1/workspaces/:id/property-data/listings?city=...&state=...&zipCode=... */
studioRouter.get(
  `${BASE}/workspaces/:id/property-data/listings`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const { city, state, zipCode, address, propertyType, limit, offset } = req.query;
      if (!city && !state && !zipCode && !address) {
        return sendError(res, 400, "MISSING_PARAM", "At least one of city, state, zipCode, or address required");
      }
      if (propertyDataService.getActivePropertyDataProviderName() === "none") {
        return sendError(res, 503, "PROVIDER_UNAVAILABLE", "No property data provider configured");
      }
      const result = await propertyDataService.searchListings({
        city, state, zipCode, address, propertyType,
        limit: limit ? Number(limit) : undefined,
        offset: offset ? Number(offset) : undefined,
      });
      // Cache ZIP-only queries for the recommendation engine (nearby listings)
      if (zipCode && !address && !city && req.params.id) {
        const cacheKey = `sp:nearby:${req.params.id}`;
        redisSet(cacheKey, JSON.stringify(result), 86400).catch(() => {});
      }
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

/** GET /api/v1/workspaces/:id/property-data/valuation?address=... */
studioRouter.get(
  `${BASE}/workspaces/:id/property-data/valuation`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const { address } = req.query;
      if (!address) return sendError(res, 400, "MISSING_PARAM", "address query param required");
      if (propertyDataService.getActivePropertyDataProviderName() === "none") {
        return sendError(res, 503, "PROVIDER_UNAVAILABLE", "No property data provider configured");
      }
      const result = await propertyDataService.getPropertyValue(address);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

/** GET /api/v1/workspaces/:id/property-data/rent-estimate?address=... */
studioRouter.get(
  `${BASE}/workspaces/:id/property-data/rent-estimate`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const { address } = req.query;
      if (!address) return sendError(res, 400, "MISSING_PARAM", "address query param required");
      if (propertyDataService.getActivePropertyDataProviderName() === "none") {
        return sendError(res, 503, "PROVIDER_UNAVAILABLE", "No property data provider configured");
      }
      const result = await propertyDataService.getRentEstimate(address);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);

/** GET /api/v1/workspaces/:id/property-data/market?zipCode=... */
studioRouter.get(
  `${BASE}/workspaces/:id/property-data/market`,
  requireClientOwner,
  async (req, res, next) => {
    try {
      const { zipCode } = req.query;
      if (!zipCode) return sendError(res, 400, "MISSING_PARAM", "zipCode query param required");
      if (propertyDataService.getActivePropertyDataProviderName() === "none") {
        return sendError(res, 503, "PROVIDER_UNAVAILABLE", "No property data provider configured");
      }
      const result = await propertyDataService.getMarketData(zipCode);
      res.json({ data: result });
    } catch (err) {
      next(err);
    }
  }
);
