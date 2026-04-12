// Slack integration routes.
// Mounted under /api/v1/integrations/slack

import express from "express";
import {
  getSlackConnection,
  upsertSlackConnection,
  updateSlackEvents,
  toggleSlackActive,
  deleteSlackConnection,
} from "./slack.service.js";

export const slackRouter = express.Router();

const BASE = "/api/v1/integrations/slack";

// GET connection
slackRouter.get(BASE, async (req, res, next) => {
  try {
    const conn = await getSlackConnection(req.user.id);
    res.json({ connection: conn });
  } catch (err) {
    next(err);
  }
});

// POST create/update connection
slackRouter.post(BASE, async (req, res, next) => {
  try {
    const { webhookUrl, channelName, subscribedEvents } = req.body;
    if (!webhookUrl) {
      return res.status(400).json({ error: "webhookUrl is required" });
    }
    const conn = await upsertSlackConnection(req.user.id, {
      webhookUrl,
      channelName,
      subscribedEvents,
    });
    res.json({ connection: conn });
  } catch (err) {
    next(err);
  }
});

// PUT update subscribed events
slackRouter.put(`${BASE}/events`, async (req, res, next) => {
  try {
    const { subscribedEvents } = req.body;
    if (!Array.isArray(subscribedEvents)) {
      return res.status(400).json({ error: "subscribedEvents must be an array" });
    }
    const conn = await updateSlackEvents(req.user.id, subscribedEvents);
    res.json({ connection: conn });
  } catch (err) {
    next(err);
  }
});

// PATCH toggle active
slackRouter.patch(`${BASE}/active`, async (req, res, next) => {
  try {
    const { isActive } = req.body;
    if (typeof isActive !== "boolean") {
      return res.status(400).json({ error: "isActive must be a boolean" });
    }
    const conn = await toggleSlackActive(req.user.id, isActive);
    res.json({ connection: conn });
  } catch (err) {
    next(err);
  }
});

// DELETE connection
slackRouter.delete(BASE, async (req, res, next) => {
  try {
    await deleteSlackConnection(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST test — send a test notification
slackRouter.post(`${BASE}/test`, async (req, res, next) => {
  try {
    const conn = await getSlackConnection(req.user.id);
    if (!conn?.webhookUrl) {
      return res.status(400).json({ error: "No Slack connection configured" });
    }

    const { sendSlackNotification } = await import("./providers/slackWebhookProvider.js");
    await sendSlackNotification(conn.webhookUrl, "POST_PUBLISHED", {
      platformName: "Test",
      clientName: "Squadpitch",
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
