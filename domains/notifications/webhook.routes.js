// Outbound webhook routes.
// Mounted under /api/v1/integrations/webhooks

import express from "express";
import { z } from "zod";
import { validationError } from "../../lib/apiErrors.js";
import {
  getWebhooks,
  getWebhook,
  createWebhook,
  updateWebhook,
  deleteWebhook,
  getDeliveryLogs,
} from "./webhook.service.js";
import { deliverWebhook } from "./providers/webhookProvider.js";

export const webhookRouter = express.Router();

const BASE = "/api/v1/integrations/webhooks";

// ── Validation schemas ────────────────────────────────────────────────
//
// targetUrl must be an http(s) URL. We don't allow file:, javascript:, or
// other custom schemes — webhooks are an outbound HTTP feature.

const HttpsUrl = z
  .string()
  .url()
  .max(2048)
  .refine((u) => /^https?:\/\//i.test(u), {
    message: "targetUrl must be an http(s) URL",
  });

// Known event types we'll deliver. Anything else is rejected so a typo
// can't silently never fire.
const SubscribedEventEnum = z.enum([
  "POST_PUBLISHED",
  "POST_FAILED",
  "USAGE_LIMIT_NEARING",
  "CONNECTION_EXPIRED",
  "BATCH_COMPLETE",
  "TEST",
]);

const CreateWebhookSchema = z.object({
  targetUrl: HttpsUrl,
  subscribedEvents: z.array(SubscribedEventEnum).min(1).max(20).optional(),
});

const UpdateWebhookSchema = z.object({
  targetUrl: HttpsUrl.optional(),
  subscribedEvents: z.array(SubscribedEventEnum).min(1).max(20).optional(),
  isActive: z.boolean().optional(),
});

// GET all webhooks
webhookRouter.get(BASE, async (req, res, next) => {
  try {
    const webhooks = await getWebhooks(req.user.id);
    // Strip secrets from response
    const safe = webhooks.map(({ secret, ...rest }) => rest);
    res.json({ webhooks: safe });
  } catch (err) {
    next(err);
  }
});

// POST create webhook
webhookRouter.post(BASE, async (req, res, next) => {
  try {
    const parsed = CreateWebhookSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    const webhook = await createWebhook(req.user.id, parsed.data);
    // Return secret only on creation so user can copy it
    res.status(201).json({ webhook });
  } catch (err) {
    next(err);
  }
});

// PUT update webhook
webhookRouter.put(`${BASE}/:id`, async (req, res, next) => {
  try {
    const parsed = UpdateWebhookSchema.safeParse(req.body);
    if (!parsed.success) return validationError(res, parsed.error.issues);
    await updateWebhook(req.user.id, req.params.id, parsed.data);
    const updated = await getWebhook(req.user.id, req.params.id);
    if (!updated) return res.status(404).json({ error: "Webhook not found" });
    const { secret: _secret, ...safe } = updated;
    res.json({ webhook: safe });
  } catch (err) {
    next(err);
  }
});

// DELETE webhook
webhookRouter.delete(`${BASE}/:id`, async (req, res, next) => {
  try {
    await deleteWebhook(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET delivery logs for a webhook
webhookRouter.get(`${BASE}/:id/logs`, async (req, res, next) => {
  try {
    // Verify ownership
    const hook = await getWebhook(req.user.id, req.params.id);
    if (!hook) return res.status(404).json({ error: "Webhook not found" });

    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;
    const logs = await getDeliveryLogs(req.params.id, { limit, offset });
    res.json({ logs });
  } catch (err) {
    next(err);
  }
});

// POST test webhook
webhookRouter.post(`${BASE}/:id/test`, async (req, res, next) => {
  try {
    const hook = await getWebhook(req.user.id, req.params.id);
    if (!hook) return res.status(404).json({ error: "Webhook not found" });

    const result = await deliverWebhook({
      targetUrl: hook.targetUrl,
      secret: hook.secret,
      eventType: "TEST",
      payload: { message: "This is a test webhook from Squadpitch" },
      userId: req.user.id,
    });

    res.json({ ok: true, ...result });
  } catch (err) {
    next(err);
  }
});
