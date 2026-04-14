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
} from "./studio.schemas.js";
import { getAnalyticsOverview, getPostDetail } from "./analyticsOverview.service.js";
import * as dataService from "./data.service.js";
import * as blueprintService from "./blueprint.service.js";
import * as opportunityService from "./contentOpportunity.service.js";
import * as dataAnalyticsService from "./dataAnalytics.service.js";
import { generateInsights } from "./insights.service.js";
import { generateRecommendations } from "./recommendations.service.js";
import { previewAutopilot, executeAutopilot } from "./dataAwareAutopilot.service.js";
import { getDashboardRecommendations, getDashboardActions } from "./dashboard.service.js";
import { getUnusedData, getDataSuggestions } from "./dataUsage.service.js";
import { signState, verifyState } from "./oauth/oauthStateCodec.js";
import { getOAuthForChannel } from "./oauth/index.js";
import { checkUsageLimit, incrementUsage, checkUsageNearing, checkClientLimit, getSubscription } from "../billing/billing.service.js";
import { getLimitsForTier } from "../billing/billing.constants.js";
import { trackAiUsage } from "../billing/aiUsageTracking.service.js";
import { isProviderBudgetExceeded, getServiceStatus, getThrottlePolicy } from "../billing/serviceHealth.service.js";
import { redisGet, redisSet } from "../../redis.js";
import crypto from "crypto";
import { enqueueNotification, recordActivity } from "../notifications/notification.service.js";
import * as importService from "./dataImport.service.js";
import * as onboardingService from "./onboardingSetup.service.js";
import { getStarterAngles } from "../industry/industry.service.js";
import multer from "multer";
import { parseDocument, isAcceptedFile } from "./documentParser.js";

export const studioRouter = express.Router();

const BASE = "/api/v1";
const DEDUP_TTL = 10; // seconds — prevents double-click duplicate AI calls

/**
 * Acquire a short-lived Redis lock to prevent duplicate AI calls.
 * Returns true if the lock was acquired (proceed), false if already in-flight.
 */
async function acquireDedup(userId, action, body) {
  const hash = crypto.createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 16);
  const key = `sp:dedup:${userId}:${action}:${hash}`;
  const existing = await redisGet(key);
  if (existing) return false;
  await redisSet(key, "1", DEDUP_TTL);
  return true;
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
      const result = await getDataSuggestions(req.params.id);
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

    const { input, inputType, documentTexts = [], industryKey } = parsed.data;
    const hasUrl = inputType === "url" && input.length >= 3;
    const hasText = inputType === "text" && input.length >= 3;
    const hasDocs = documentTexts.length > 0;

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
      brandData = await onboardingService.extractBrandFromText(input, { industryKey });
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
    const canProceed = await acquireDedup(req.user.id, "generate", parsed.data);
    if (!canProceed) return sendError(res, 429, "DUPLICATE_REQUEST", "A generation is already in progress. Please wait.");

    // Usage limit check
    const allowed = await checkUsageLimit(req.user.id, "posts");
    if (!allowed) return sendError(res, 402, "USAGE_LIMIT", "You have reached your monthly generation limit. Upgrade your plan for more.");

    const actorSub = getAuth0Sub(req);
    const { dataItemId, blueprintId, ...genData } = parsed.data;
    const draft = await service.generateDraft({
      ...genData,
      createdBy: actorSub,
      dataItemId,
      blueprintId,
      userId: req.user.id,
    });

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

// ── Content Ideas ──────────────────────────────────────────────────────

studioRouter.post(`${BASE}/workspaces/:id/ideas`, requireClientOwner, async (req, res, next) => {
  try {
    // Service health pre-flight
    if (await getServiceStatus("openai") === "down") return sendError(res, 503, "SERVICE_UNAVAILABLE", "Content generation temporarily unavailable. Please try again in a few minutes.");
    { const throttle = await getThrottlePolicy(); if (throttle.adminPaused) return sendError(res, 503, "SERVICE_UNAVAILABLE", "AI generation is temporarily paused by the administrator."); }

    // Global budget check
    if (await isProviderBudgetExceeded("openai")) return sendError(res, 503, "BUDGET_EXCEEDED", "AI text generation is temporarily unavailable due to budget limits. Please try again later.");

    const canProceed = await acquireDedup(req.user.id, "ideas", { clientId: req.params.id });
    if (!canProceed) return sendError(res, 429, "DUPLICATE_REQUEST", "Idea generation is already in progress. Please wait.");

    const ideas = await service.generateContentIdeas(req.params.id, { userId: req.user.id });
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
          createdBy: actorSub,
        });
      }
      res.status(201).json(service.formatAsset(asset));
    } catch (err) {
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

      const canProceed = await acquireDedup(req.user.id, "image", parsed.data);
      if (!canProceed) return sendError(res, 429, "DUPLICATE_REQUEST", "An image generation is already in progress. Please wait.");

      // Usage limit check
      const allowed = await checkUsageLimit(req.user.id, "images");
      if (!allowed) return sendError(res, 402, "USAGE_LIMIT", "You have reached your monthly image generation limit. Upgrade your plan for more.");

      const actorSub = getAuth0Sub(req);
      const asset = await service.enqueueGeneration({
        ...parsed.data,
        createdBy: actorSub,
        userId: req.user.id,
      });

      await incrementUsage(req.user.id, "images");

      trackAiUsage({
        userId: req.user.id,
        clientId: parsed.data.clientId,
        actionType: "IMAGE",
        model: parsed.data.model ?? "fal-ai/flux/dev",
        promptTokens: 0,
        completionTokens: 0,
      });

      checkUsageNearing(req.user.id, "images").then((info) => {
        if (info) enqueueNotification({
          userId: req.user.id,
          eventType: "USAGE_LIMIT_NEARING",
          payload: info,
          resourceType: "usage",
          resourceId: `${req.user.id}:images`,
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

      // Explicit tier gate — FREE/STARTER have 0 videos
      const sub = await getSubscription(req.user.id);
      const tier = sub?.tier ?? "FREE";
      const tierLimits = getLimitsForTier(tier);
      if (tierLimits.videos === 0) return sendError(res, 402, "TIER_LIMIT", "Video generation is not available on your plan. Upgrade to Pro or higher.");

      // Video throttle — disabled when fal budget at warning+
      if (throttle.videoDisabled) return sendError(res, 503, "FEATURE_THROTTLED", "Video generation is temporarily limited to manage costs. Please try again later.");

      // Global budget check
      if (await isProviderBudgetExceeded("fal")) return sendError(res, 503, "BUDGET_EXCEEDED", "AI video generation is temporarily unavailable due to budget limits. Please try again later.");

      const canProceed = await acquireDedup(req.user.id, "video", parsed.data);
      if (!canProceed) return sendError(res, 429, "DUPLICATE_REQUEST", "A video generation is already in progress. Please wait.");

      // Usage limit check
      const allowed = await checkUsageLimit(req.user.id, "videos");
      if (!allowed) return sendError(res, 402, "USAGE_LIMIT", "You have reached your monthly video generation limit. Upgrade your plan for more.");

      const actorSub = getAuth0Sub(req);
      const asset = await service.enqueueVideoGeneration({
        ...parsed.data,
        createdBy: actorSub,
        userId: req.user.id,
      });

      await incrementUsage(req.user.id, "videos");

      trackAiUsage({
        userId: req.user.id,
        clientId: parsed.data.clientId,
        actionType: "VIDEO",
        model: parsed.data.model ?? "fal-ai/minimax/video-01-live",
        promptTokens: 0,
        completionTokens: 0,
      });

      checkUsageNearing(req.user.id, "videos").then((info) => {
        if (info) enqueueNotification({
          userId: req.user.id,
          eventType: "USAGE_LIMIT_NEARING",
          payload: info,
          resourceType: "usage",
          resourceId: `${req.user.id}:videos`,
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
