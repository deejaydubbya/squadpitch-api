// Outbound webhook routes.
// Mounted under /api/v1/integrations/webhooks

import express from "express";
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
    const { targetUrl, subscribedEvents } = req.body;
    if (!targetUrl) {
      return res.status(400).json({ error: "targetUrl is required" });
    }
    const webhook = await createWebhook(req.user.id, { targetUrl, subscribedEvents });
    // Return secret only on creation so user can copy it
    res.status(201).json({ webhook });
  } catch (err) {
    next(err);
  }
});

// PUT update webhook
webhookRouter.put(`${BASE}/:id`, async (req, res, next) => {
  try {
    const { targetUrl, subscribedEvents, isActive } = req.body;
    await updateWebhook(req.user.id, req.params.id, {
      targetUrl,
      subscribedEvents,
      isActive,
    });
    const updated = await getWebhook(req.user.id, req.params.id);
    if (!updated) return res.status(404).json({ error: "Webhook not found" });
    const { secret, ...safe } = updated;
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
