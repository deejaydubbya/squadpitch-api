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
  MetricsSummaryQuerySchema,
  ChannelParamSchema,
  OAuthCompleteSchema,
} from "./studio.schemas.js";
import { signState, verifyState } from "./oauth/oauthStateCodec.js";
import { getOAuthForChannel } from "./oauth/index.js";
import { checkUsageLimit, incrementUsage, checkUsageNearing, checkClientLimit } from "../billing/billing.service.js";
import { enqueueNotification } from "../notifications/notification.service.js";

export const studioRouter = express.Router();

const BASE = "/api/v1";

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

studioRouter.get(`${BASE}/clients`, async (req, res, next) => {
  try {
    const actorSub = getAuth0Sub(req);
    const clients = await service.listClients(actorSub);
    res.json({ clients: clients.map(service.formatClient) });
  } catch (err) {
    next(err);
  }
});

studioRouter.post(`${BASE}/clients`, async (req, res, next) => {
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

studioRouter.get(`${BASE}/clients/:id`, requireClientOwner, async (req, res, next) => {
  try {
    const actorSub = getAuth0Sub(req);
    const client = await service.getClient(req.params.id, actorSub);
    if (!client) return sendError(res, 404, "NOT_FOUND", "Client not found");
    res.json(service.formatClient(client));
  } catch (err) {
    next(err);
  }
});

studioRouter.patch(`${BASE}/clients/:id`, requireClientOwner, async (req, res, next) => {
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

studioRouter.delete(`${BASE}/clients/:id`, requireClientOwner, async (req, res, next) => {
  try {
    const actorSub = getAuth0Sub(req);
    const client = await service.archiveClient(req.params.id, actorSub);
    res.json(service.formatClient(client));
  } catch (err) {
    next(err);
  }
});

// ── Brand profile ───────────────────────────────────────────────────────

studioRouter.get(`${BASE}/clients/:id/brand`, requireClientOwner, async (req, res, next) => {
  try {
    const brand = await service.getBrandProfile(req.params.id);
    res.json({ brand: service.formatBrandProfile(brand) });
  } catch (err) {
    next(err);
  }
});

studioRouter.put(`${BASE}/clients/:id/brand`, requireClientOwner, async (req, res, next) => {
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

studioRouter.get(`${BASE}/clients/:id/voice`, requireClientOwner, async (req, res, next) => {
  try {
    const voice = await service.getVoiceProfile(req.params.id);
    res.json({ voice: service.formatVoiceProfile(voice) });
  } catch (err) {
    next(err);
  }
});

studioRouter.put(`${BASE}/clients/:id/voice`, requireClientOwner, async (req, res, next) => {
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

studioRouter.get(`${BASE}/clients/:id/media`, requireClientOwner, async (req, res, next) => {
  try {
    const media = await service.getMediaProfile(req.params.id);
    res.json({ media: service.formatMediaProfile(media) });
  } catch (err) {
    next(err);
  }
});

studioRouter.put(`${BASE}/clients/:id/media`, requireClientOwner, async (req, res, next) => {
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

studioRouter.get(`${BASE}/clients/:id/channels`, requireClientOwner, async (req, res, next) => {
  try {
    const channels = await service.listChannelSettings(req.params.id);
    res.json({ channels: channels.map(service.formatChannelSettings) });
  } catch (err) {
    next(err);
  }
});

studioRouter.put(`${BASE}/clients/:id/channels`, requireClientOwner, async (req, res, next) => {
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

// ── Analytics ───────────────────────────────────────────────────────────

studioRouter.get(`${BASE}/clients/:id/analytics`, requireClientOwner, async (req, res, next) => {
  try {
    const analytics = await service.getClientAnalytics(req.params.id);
    res.json(analytics);
  } catch (err) {
    next(err);
  }
});

// ── Generation ──────────────────────────────────────────────────────────

studioRouter.post(`${BASE}/generate`, async (req, res, next) => {
  try {
    const parsed = GenerateContentSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);

    // Usage limit check
    const allowed = await checkUsageLimit(req.user.id, "posts");
    if (!allowed) return sendError(res, 402, "USAGE_LIMIT", "You have reached your monthly generation limit. Upgrade your plan for more.");

    const actorSub = getAuth0Sub(req);
    const draft = await service.generateDraft({
      ...parsed.data,
      createdBy: actorSub,
    });

    await incrementUsage(req.user.id, "posts");

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

studioRouter.post(`${BASE}/clients/:id/ideas`, requireClientOwner, async (req, res, next) => {
  try {
    const ideas = await service.generateContentIdeas(req.params.id);
    res.json({ ideas });
  } catch (err) {
    next(err);
  }
});

// ── Batch-complete notification ──────────────────────────────────────────

studioRouter.post(`${BASE}/clients/:id/batch-complete`, requireClientOwner, async (req, res, next) => {
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
  `${BASE}/clients/:id/drafts`,
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
    res.json(service.formatDraft(draft));
  } catch (err) {
    next(err);
  }
});

// Auto-schedule: distribute drafts across upcoming days
studioRouter.post(`${BASE}/clients/:id/auto-schedule`, requireClientOwner, async (req, res, next) => {
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
  `${BASE}/clients/:id/assets`,
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
  `${BASE}/clients/:id/assets/upload`,
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

      // Usage limit check
      const allowed = await checkUsageLimit(req.user.id, "images");
      if (!allowed) return sendError(res, 402, "USAGE_LIMIT", "You have reached your monthly image generation limit. Upgrade your plan for more.");

      const actorSub = getAuth0Sub(req);
      const asset = await service.enqueueGeneration({
        ...parsed.data,
        createdBy: actorSub,
      });

      await incrementUsage(req.user.id, "images");

      checkUsageNearing(req.user.id, "images").then((info) => {
        if (info) enqueueNotification({
          userId: req.user.id,
          eventType: "USAGE_LIMIT_NEARING",
          payload: info,
          resourceType: "usage",
          resourceId: `${req.user.id}:images`,
        });
      }).catch(() => {});

      res.status(201).json(service.formatAsset(asset));
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

      // Usage limit check
      const allowed = await checkUsageLimit(req.user.id, "videos");
      if (!allowed) return sendError(res, 402, "USAGE_LIMIT", "You have reached your monthly video generation limit. Upgrade your plan for more.");

      const actorSub = getAuth0Sub(req);
      const asset = await service.enqueueVideoGeneration({
        ...parsed.data,
        createdBy: actorSub,
      });

      await incrementUsage(req.user.id, "videos");

      checkUsageNearing(req.user.id, "videos").then((info) => {
        if (info) enqueueNotification({
          userId: req.user.id,
          eventType: "USAGE_LIMIT_NEARING",
          payload: info,
          resourceType: "usage",
          resourceId: `${req.user.id}:videos`,
        });
      }).catch(() => {});

      res.status(201).json(service.formatAsset(asset));
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
  `${BASE}/clients/:id/metrics`,
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

// ── Connection validation ──────────────────────────────────────────────

studioRouter.post(
  `${BASE}/clients/:id/connections/:channel/validate`,
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
  `${BASE}/clients/:id/connections`,
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
  `${BASE}/clients/:id/connections/:channel/oauth/start`,
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

      res.json({ connection: service.formatConnection(row) });
    } catch (err) {
      next(err);
    }
  }
);

studioRouter.delete(
  `${BASE}/clients/:id/connections/:channel`,
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
