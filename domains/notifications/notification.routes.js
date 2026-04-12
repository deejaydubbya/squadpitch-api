// Notification preference routes.
// Mounted under /api/v1/notifications/*

import express from "express";
import {
  getPreferences,
  updatePreferences,
  getNotificationLogs,
  getInboxNotifications,
  getUnreadCount,
  markAsRead,
  markAllAsRead,
  getActivityFeed,
  subscribePush,
  unsubscribePush,
  getPushSubscriptions,
} from "./notification.service.js";
import { env } from "../../config/env.js";

export const notificationRouter = express.Router();
export const notificationPublicRouter = express.Router();

const BASE = "/api/v1/notifications";

// ── Public (no auth) ──────────────────────────────────────────────────

notificationPublicRouter.get(`${BASE}/push/vapid-key`, (_req, res) => {
  res.json({ publicKey: env.VAPID_PUBLIC_KEY || null });
});

// GET preferences
notificationRouter.get(`${BASE}/preferences`, async (req, res, next) => {
  try {
    const prefs = await getPreferences(req.user.id);
    res.json({ preferences: prefs });
  } catch (err) {
    next(err);
  }
});

// PUT preferences
notificationRouter.put(`${BASE}/preferences`, async (req, res, next) => {
  try {
    const { emailEnabled, smsEnabled, pushEnabled, digestEnabled, phoneNumber, preferencesJson } = req.body;
    const data = {};
    if (typeof emailEnabled === "boolean") data.emailEnabled = emailEnabled;
    if (typeof smsEnabled === "boolean") data.smsEnabled = smsEnabled;
    if (typeof pushEnabled === "boolean") data.pushEnabled = pushEnabled;
    if (typeof digestEnabled === "boolean") data.digestEnabled = digestEnabled;
    if (phoneNumber !== undefined) data.phoneNumber = phoneNumber || null;
    if (preferencesJson && typeof preferencesJson === "object")
      data.preferencesJson = preferencesJson;

    const updated = await updatePreferences(req.user.id, data);
    res.json({ preferences: updated });
  } catch (err) {
    next(err);
  }
});

// GET logs
notificationRouter.get(`${BASE}/logs`, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    const offset = parseInt(req.query.offset) || 0;
    const logs = await getNotificationLogs(req.user.id, { limit, offset });
    res.json({ logs });
  } catch (err) {
    next(err);
  }
});

// ── In-app inbox ──────────────────────────────────────────────────────

// GET inbox (paginated, filterable)
notificationRouter.get(`${BASE}/inbox`, async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;
    const filter = ["all", "unread", "read"].includes(req.query.filter)
      ? req.query.filter
      : "all";
    const result = await getInboxNotifications(req.user.id, { limit, offset, filter });
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// GET unread count (must be registered BEFORE :id/read)
notificationRouter.get(`${BASE}/inbox/unread-count`, async (req, res, next) => {
  try {
    const count = await getUnreadCount(req.user.id);
    res.json({ count });
  } catch (err) {
    next(err);
  }
});

// PATCH mark all as read (must be registered BEFORE :id/read)
notificationRouter.patch(`${BASE}/inbox/read-all`, async (req, res, next) => {
  try {
    await markAllAsRead(req.user.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// PATCH mark single notification as read
notificationRouter.patch(`${BASE}/inbox/:id/read`, async (req, res, next) => {
  try {
    await markAsRead(req.user.id, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// ── Push subscriptions ────────────────────────────────────────────────

// POST subscribe push
notificationRouter.post(`${BASE}/push/subscribe`, async (req, res, next) => {
  try {
    const { endpoint, keys, userAgent } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: "Missing endpoint or keys" });
    }
    await subscribePush(req.user.id, {
      endpoint,
      p256dh: keys.p256dh,
      auth: keys.auth,
      userAgent: userAgent || null,
    });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// DELETE unsubscribe push
notificationRouter.delete(`${BASE}/push/subscribe`, async (req, res, next) => {
  try {
    const { endpoint } = req.body;
    if (!endpoint) {
      return res.status(400).json({ error: "Missing endpoint" });
    }
    await unsubscribePush(req.user.id, endpoint);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// GET push subscriptions (for settings UI)
notificationRouter.get(`${BASE}/push/subscriptions`, async (req, res, next) => {
  try {
    const subscriptions = await getPushSubscriptions(req.user.id);
    res.json({ subscriptions });
  } catch (err) {
    next(err);
  }
});

// ── Activity feed ─────────────────────────────────────────────────────

notificationRouter.get("/api/v1/activity", async (req, res, next) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 20, 100);
    const offset = parseInt(req.query.offset) || 0;
    const clientId = req.query.clientId || undefined;
    const result = await getActivityFeed(req.user.id, { limit, offset, clientId });
    res.json(result);
  } catch (err) {
    next(err);
  }
});
