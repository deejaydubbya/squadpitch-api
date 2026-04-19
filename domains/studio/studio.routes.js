// Squadpitch studio routes.
//
// Mounted under /api/v1/*. The app-level requireAuth + requireUser
// guard in server.js covers /api/*, so this router doesn't add its own.

import express from "express";
import { prisma } from "../../prisma.js";
import { getAuth0Sub } from "../../middleware/auth.js";
import { sendError, validationError } from "../../lib/apiErrors.js";
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
import { checkUsageLimit, incrementUsage, checkUsageNearing, checkClientLimit, getSubscription, checkStorageLimit, buildQuotaError, enforceUsageLimit } from "../billing/billing.service.js";
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
import { getStarterAngles, getIndustryTechStack, getRecommendationTemplates, getAssetTagDefaults } from "../industry/industry.service.js";
import { RE_CAPABILITY_MAP } from "../industry/realEstateContext.js";
import {
  getWorkspaceTechStackView,
  upsertWorkspaceTechStackConnection,
} from "../industry/techStack.service.js";
import { invalidateClientContext } from "./generation/clientOrchestrator.js";
import { getAutopilotSettings, updateAutopilotSettings, runAutopilot, runScheduledAutopilot, evaluateAllAutopilotWorkspaces, getAutopilotStatus, getAutopilotReadiness, getAutopilotActivity } from "./autopilot.service.js";
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

// Ownership middleware: verifies the client belongs to the authenticated user.
async function requireClientOwner(req, res, next) {
  try {
    const clientId = req.params.id || req.params.clientId;
    const client = await prisma.client.findUnique({
      where: { id: clientId },
      select: { createdBy: true },
    });
    if (!client) return sendError(res, 404, "NOT_FOUND", "Client not found");
    if (client.createdBy !== getAuth0Sub(req)) {
      return sendError(res, 403, "FORBIDDEN", "Forbidden");
    }
    next();
  } catch (err) {
    next(err);
  }
}

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

studioRouter.get(`${BASE}/business-data/:itemId`, async (req, res, next) => {
  try {
    const item = await dataService.getDataItem(req.params.itemId);
    if (!item) return sendError(res, 404, "NOT_FOUND", "Data item not found");
    res.json(dataService.formatDataItem(item));
  } catch (err) {
    next(err);
  }
});

studioRouter.patch(`${BASE}/business-data/:itemId`, async (req, res, next) => {
  try {
    const parsed = UpdateDataItemSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    const item = await dataService.updateDataItem(req.params.itemId, parsed.data);
    res.json(dataService.formatDataItem(item));
  } catch (err) {
    next(err);
  }
});

studioRouter.post(
  `${BASE}/business-data/:itemId/archive`,
  async (req, res, next) => {
    try {
      const item = await dataService.archiveDataItem(req.params.itemId);
      res.json(dataService.formatDataItem(item));
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.delete(
  `${BASE}/business-data/:itemId`,
  async (req, res, next) => {
    try {
      await dataService.deleteDataItem(req.params.itemId);
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

studioRouter.get(
  `${BASE}/business-data/:itemId/opportunities`,
  async (req, res, next) => {
    try {
      const channel = req.query.channel || undefined;
      const opportunities = await opportunityService.getOpportunitiesForItem(
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
      .map(({ type, title, guidance }) => ({ type, title, guidance }));

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

      const { combinedText, images: crawledImages, logoUrl: crawledLogo } = await onboardingService.crawlAndCombine({
        url: hasUrl ? input : null,
        text: hasText ? input : null,
        documentTexts,
        onProgress: (p) => sendEvent(p),
      });
      images = crawledImages;
      logoUrl = crawledLogo || "";
      sendEvent({ event: "crawl:done" });

      // Extract sequentially: brand first, then data.
      // Running both in parallel can trigger OpenAI rate limits.
      sendEvent({ event: "extract:start" });

      brandData = await onboardingService.extractBrandData(combinedText, {
        url: hasUrl ? input : undefined,
        industryKey,
        agentContext,
      });
      sendEvent({ event: "brand:done", brandData, logoUrl });

      try {
        dataItems = await onboardingService.extractDataItems(combinedText, {
          url: hasUrl ? input : undefined,
          images: crawledImages,
          industryKey,
          onProgress: (items) => {
            sendEvent({ event: "data:progress", items, count: items.length });
          },
        });
        sendEvent({ event: "data:done", items: dataItems, count: dataItems.length });
      } catch (err) {
        console.error("[onboarding-stream] Data extraction failed:", err.message || err);
        sendEvent({ event: "data:done", items: [], count: 0 });
      }
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
      .map(({ type, title, guidance }) => ({ type, title, guidance }));

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
    await trackableLinkService.deleteLink(req.params.linkId);
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
    const draft = await service.generateDraft({
      ...genData,
      createdBy: actorSub,
      dataItemId,
      blueprintId,
      userId: req.user.id,
    });

    await releaseDedup(dedupKey);
    await incrementUsage(req.user.id, "posts");

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
    next(err);
  }
});

// ── Content Remix ────────────────────────────────────────────────────

studioRouter.post(`${BASE}/workspaces/:id/remix`, requireClientOwner, async (req, res, next) => {
  try {
    const { draftId } = req.body;
    if (!draftId || typeof draftId !== "string") return sendError(res, 400, "VALIDATION_ERROR", "draftId is required.");

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
    const drafts = await service.listDrafts(parsed.data);
    res.json({ drafts: drafts.map(service.formatDraft) });
  } catch (err) {
    next(err);
  }
});

studioRouter.get(`${BASE}/drafts/:id`, async (req, res, next) => {
  try {
    const draft = await service.getDraft(req.params.id);
    if (!draft) return sendError(res, 404, "NOT_FOUND", "Draft not found");
    res.json(service.formatDraft(draft));
  } catch (err) {
    next(err);
  }
});

studioRouter.patch(`${BASE}/drafts/:id`, async (req, res, next) => {
  try {
    const parsed = UpdateDraftSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    const draft = await service.updateDraft(req.params.id, parsed.data);
    res.json(service.formatDraft(draft));
  } catch (err) {
    next(err);
  }
});

studioRouter.delete(`${BASE}/drafts/:id`, async (req, res, next) => {
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

studioRouter.post(`${BASE}/drafts/:id/duplicate`, async (req, res, next) => {
  try {
    const actorSub = getAuth0Sub(req);
    const draft = await service.duplicateDraft(req.params.id, actorSub);
    res.json(service.formatDraft(draft));
  } catch (err) {
    next(err);
  }
});

studioRouter.post(`${BASE}/drafts/:id/approve`, async (req, res, next) => {
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

    res.json(service.formatDraft(draft));
  } catch (err) {
    next(err);
  }
});

studioRouter.post(`${BASE}/drafts/:id/reject`, async (req, res, next) => {
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

studioRouter.post(`${BASE}/drafts/:id/schedule`, async (req, res, next) => {
  try {
    const parsed = ScheduleDraftSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);

    // Pre-validate: ensure the draft's channel has an active connection
    const draftRecord = await prisma.draft.findUnique({
      where: { id: req.params.id },
      select: { channel: true, clientId: true },
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
    }

    const actorSub = getAuth0Sub(req);
    const draft = await service.scheduleDraft(
      req.params.id,
      parsed.data.scheduledFor,
      actorSub
    );

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
    next(err);
  }
});

// Auto-schedule: distribute drafts across upcoming days
studioRouter.post(`${BASE}/workspaces/:id/auto-schedule`, requireClientOwner, async (req, res, next) => {
  try {
    const { draftIds } = req.body;
    if (!Array.isArray(draftIds) || draftIds.length === 0) {
      return sendError(res, 400, "VALIDATION", "draftIds array is required");
    }
    const actorSub = getAuth0Sub(req);

    // Optimal posting times (hour in UTC)
    const OPTIMAL_HOURS = [9, 12, 15, 18];
    const now = new Date();
    const scheduled = [];

    for (let i = 0; i < draftIds.length; i++) {
      // Distribute across next 7 days
      const dayOffset = Math.floor(i / 2) + 1; // 2 posts per day max, start tomorrow
      const hourIdx = i % OPTIMAL_HOURS.length;

      const scheduledFor = new Date(now);
      scheduledFor.setDate(scheduledFor.getDate() + dayOffset);
      scheduledFor.setHours(OPTIMAL_HOURS[hourIdx], 0, 0, 0);

      try {
        const draft = await service.scheduleDraft(draftIds[i], scheduledFor.toISOString(), actorSub);
        scheduled.push(service.formatDraft(draft));
      } catch {
        // Skip drafts that can't be scheduled (wrong status, etc.)
      }
    }

    res.json({ scheduled, count: scheduled.length });
  } catch (err) {
    next(err);
  }
});

studioRouter.post(`${BASE}/drafts/:id/publish`, async (req, res, next) => {
  try {
    // Usage limit check
    const allowed = await checkUsageLimit(req.user.id, "posts");
    if (!allowed) return sendError(res, 402, "USAGE_LIMIT", "You have reached your monthly publish limit. Upgrade your plan for more.");

    const actorSub = getAuth0Sub(req);
    const draft = await service.publishDraft({
      draftId: req.params.id,
      actorSub,
      source: "manual",
    });

    await incrementUsage(req.user.id, "posts");

    checkUsageNearing(req.user.id, "posts").then((info) => {
      if (info) enqueueNotification({
        userId: req.user.id,
        eventType: "USAGE_LIMIT_NEARING",
        payload: info,
        resourceType: "usage",
        resourceId: `${req.user.id}:posts`,
      });
    }).catch(() => {});

    res.json(draft);
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
      const assets = await service.listAssets(parsed.data);
      res.json({ assets: assets.map(service.formatAsset) });
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.get(`${BASE}/assets/:assetId`, async (req, res, next) => {
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
      const contentType = req.headers["content-type"] || "";
      const isVideo = contentType.startsWith("video/") || req.query.assetType === "video";

      // Usage + storage limit checks
      const usageField = isVideo ? "videos" : "images";
      const quotaErr = await enforceUsageLimit(req.user.id, usageField);
      if (quotaErr) return sendError(res, 402, quotaErr.code, `Monthly ${usageField} upload limit reached. Upgrade your plan for more.`, quotaErr);
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

      const { url, folderId, filename } = parsed.data;
      const clientId = req.params.id;
      const actorSub = getAuth0Sub(req);

      // Fetch the image with timeout and size limits
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15_000);
      let resp;
      try {
        resp = await fetch(url, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }
      if (!resp.ok) {
        return sendError(res, 400, "FETCH_FAILED", `Failed to fetch image (${resp.status})`);
      }

      const contentType = resp.headers.get("content-type") || "";
      if (!contentType.startsWith("image/")) {
        return sendError(res, 400, "NOT_IMAGE", "URL does not point to an image");
      }

      const buffer = Buffer.from(await resp.arrayBuffer());
      if (buffer.length > 10 * 1024 * 1024) {
        return sendError(res, 400, "TOO_LARGE", "Image exceeds 10 MB limit");
      }

      // Usage + storage limit checks
      const imgQuotaErr = await enforceUsageLimit(req.user.id, "images");
      if (imgQuotaErr) return sendError(res, 402, imgQuotaErr.code, "Monthly image upload limit reached. Upgrade your plan for more.", imgQuotaErr);
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
      const folder = await service.createFolder({ clientId: req.params.id, name });
      res.status(201).json({
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
  async (req, res, next) => {
    try {
      const { folderId } = req.body;
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

      const response = service.formatAsset(asset);
      if (asset.queued === false) response.processingNote = "Processing delayed — your content is being generated";
      res.status(201).json(response);
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.post(
  `${BASE}/assets/generate-video`,
  async (req, res, next) => {
    try {
      const parsed = GenerateVideoSchema.safeParse(req.body);
      if (!parsed.success) return validationError(res, parsed.error.issues);

      // Service health pre-flight
      if (await getServiceStatus("fal") === "down") return sendError(res, 503, "SERVICE_UNAVAILABLE", "Video generation temporarily limited. Please try again in a few minutes.");
      const throttle = await getThrottlePolicy();
      if (throttle.adminPaused) return sendError(res, 503, "SERVICE_UNAVAILABLE", "AI generation is temporarily paused by the administrator.");

      // Explicit tier gate — check if video generation is allowed on this plan
      const sub = await getSubscription(req.user.id);
      const tier = sub?.tier ?? "FREE";
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
  async (req, res, next) => {
    try {
      await service.unlinkAssetFromDraft(req.params.assetId, req.params.draftId);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.get(
  `${BASE}/assets/:assetId/usage`,
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
      const { propertyData, campaignType, imageContext, slots } = req.body;
      if (!propertyData || typeof propertyData !== "object") {
        return validationError(res, [{ path: ["propertyData"], message: "Property data is required" }]);
      }

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

        // Save property as a data item via existing ingestion
        const listingResult = await listingIngestion.ingestManualListing(clientId, {
          address: propertyData.address || "",
          price: propertyData.price ? Number(propertyData.price) : undefined,
          beds: propertyData.beds ? Number(propertyData.beds) : undefined,
          baths: propertyData.baths ? Number(propertyData.baths) : undefined,
          sqft: propertyData.sqft ? Number(propertyData.sqft) : undefined,
          description: propertyData.description || "",
          highlights: propertyData.highlights ? propertyData.highlights.split(",").map((s) => s.trim()).filter(Boolean) : [],
          propertyType: propertyData.propertyType || undefined,
        });

        // Load generation context + RE assets
        const { loadClientGenerationContext } = await import("./generation/clientOrchestrator.js");
        const { buildSystemPrompt, buildCampaignUserPrompt, buildCampaignResponseFormat } = await import("./generation/promptBuilder.js");
        const { generateStructuredContent } = await import("./generation/openai.provider.js");
        const { loadRealEstateGenerationAssets } = await import("../industry/realEstateGeneration.js");

        const ctx = await loadClientGenerationContext(clientId);

        let realEstateAssets = null;
        if (ctx.realEstateContext) {
          try { realEstateAssets = await loadRealEstateGenerationAssets(clientId, ctx.realEstateContext); } catch {}
        }

        const systemPrompt = buildSystemPrompt(ctx);
        const safeImageContext = Array.isArray(imageContext)
          ? imageContext.slice(0, 8).map((img) => ({
              label: typeof img?.label === "string" ? img.label.slice(0, 30) : "other",
              description: typeof img?.description === "string" ? img.description.slice(0, 100) : "",
            }))
          : null;
        const userPrompt = buildCampaignUserPrompt(ctx, propertyData, campaignType, safeImageContext, slots);
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

        res.json({
          dataItemId: listingResult.dataItem?.id ?? null,
          campaign: result.parsed,
        });
      } finally {
        await releaseDedup(dedupKey);
      }
    } catch (err) {
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
      const { propertyData, campaignType, slot, campaignSummary, imageContext } = req.body;
      if (!propertyData || typeof propertyData !== "object") {
        return validationError(res, [{ path: ["propertyData"], message: "Property data is required" }]);
      }
      if (!slot || typeof slot !== "object" || !slot.channel || !slot.day || !slot.label) {
        return validationError(res, [{ path: ["slot"], message: "Slot with channel, day, and label is required" }]);
      }

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

        const ctx = await loadClientGenerationContext(clientId);

        const systemPrompt = buildSystemPrompt(ctx);
        const safeImageContext = Array.isArray(imageContext)
          ? imageContext.slice(0, 8).map((img) => ({
              label: typeof img?.label === "string" ? img.label.slice(0, 30) : "other",
              description: typeof img?.description === "string" ? img.description.slice(0, 100) : "",
            }))
          : null;
        const userPrompt = buildRegeneratePostUserPrompt(ctx, propertyData, campaignType, slot, campaignSummary, safeImageContext);
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

        res.json({ post: result.parsed?.post ?? result.parsed });
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
      const { images } = req.body;
      if (!Array.isArray(images) || images.length === 0) {
        return validationError(res, [{ path: ["images"], message: "images array is required" }]);
      }
      if (images.length > 12) {
        return sendError(res, 400, "TOO_MANY_IMAGES", "Maximum 12 images per upload");
      }

      const { getImageStorageService } = await import("../../services/storage/imageStorage.js");
      const storage = getImageStorageService();

      const clientId = req.params.id;
      const userId = req.user.id;

      const uploaded = [];
      for (const img of images) {
        if (!img || typeof img !== "object") continue;
        const { dataUrl, label, caption, isEnhanced, qualityScore, qualityLabel } = img;
        if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) continue;

        // Parse data URL → buffer + mime
        const commaIdx = dataUrl.indexOf(",");
        if (commaIdx < 0) continue;
        const meta = dataUrl.slice(5, commaIdx); // e.g. "image/png;base64"
        const mimeType = meta.split(";")[0] || "image/png";
        const base64Data = dataUrl.slice(commaIdx + 1);
        const buffer = Buffer.from(base64Data, "base64");
        if (buffer.length === 0 || buffer.length > 15 * 1024 * 1024) continue; // 15MB cap

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
            },
          });
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
      const { campaign, propertyData, campaignType, dataItemId, schedulePreset, addToPlanner, mediaAssetIds } = req.body;
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
      const address = propertyData?.address || "Listing Campaign";
      const campaignId = `camp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const campaignName = campaign.campaignName || `${address} — ${(campaignType || "just_listed").replace(/_/g, " ")}`;
      const totalPosts = campaign.posts.length;

      const warnings = [
        "source:listing-campaign",
        `campaignType:${campaignType || "just_listed"}`,
        `address:${address}`,
      ];
      if (dataItemId) warnings.push(`dataItemId:${dataItemId}`);

      // Schedule spacing: map campaignDay to real dates based on preset
      const presetDays = schedulePreset === 14 ? 14 : schedulePreset === 10 ? 10 : 7;
      const maxCampaignDay = Math.max(...campaign.posts.map((p) => p.campaignDay || 1));

      function computeScheduledDate(campaignDay) {
        if (!addToPlanner) return null;
        // Scale campaign days to fit within the preset window
        const dayOffset = maxCampaignDay > 1
          ? Math.round(((campaignDay - 1) / (maxCampaignDay - 1)) * (presetDays - 1))
          : 0;
        const date = new Date(Date.now() + (dayOffset + 1) * 24 * 60 * 60 * 1000);
        date.setUTCHours(10, 0, 0, 0);
        return date;
      }

      const drafts = await Promise.all(
        campaign.posts.map((post, idx) => {
          const scheduledFor = computeScheduledDate(post.campaignDay || idx + 1);
          return prisma.draft.create({
            data: {
              clientId,
              kind: "POST",
              status: addToPlanner ? "SCHEDULED" : "DRAFT",
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
            }
          }
          if (updates.length > 0) await Promise.all(updates);
        }
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
